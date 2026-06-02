# ADR-004 — Sudo elevation: gated, never silent

- **Status**: accepted (M2)
- **Date**: 2026-06-01
- **Audience**: contributors, security reviewers
- **Supersedes**: nothing
- **Superseded by**: nothing

## Context

Many diagnostics and some mutations require root: reading protected logs
(`/var/log/auth.log`), inspecting kernel state (`iptables -L`), running Docker
commands on a host where the SSH user isn't in the `docker` group. Without a
first-class elevation mechanism, PIPER's options are:

- **Ignore the problem.** The command fails with "permission denied"; the LLM
  notes it and moves on. Leaves gaps in every diagnostic on hardened hosts.
- **Hard-code `sudo` per action.** Several early actions (e.g.
  `system.iptables_list`) already did this. The result is scattered, untestable,
  not auditable as a category, and the path denylist has no chance to intercept
  the elevated path.
- **Let the LLM decide when to add sudo.** The LLM is not the right place for a
  security decision. Free-form sudo from the model context is the threat we are
  defending against, not a feature.

None of these extend PIPER's Prime Directive to privilege escalation. They either
leave capability on the floor, fragment the gate, or hand the decision to a
component that must not make it.

## Decision

Elevation is a dimension **orthogonal to tier**. An invocation carries
`elevation: 'none' | 'sudo'` independently of whether its action is `read`,
`mutate`, or `destructive`. Six interlocking constraints implement this.

### 1. One helper, one code path

`src/security/elevation.ts` exports `elevateRemoteCommand(command, mode)` — the
only place `sudo -n` is prepended to an inner command. Actions that need
elevation route their inner remote command through this helper; they do not
construct sudo invocations by hand. The helper is idempotent: a command already
starting with `sudo` (bare or full-path, any case) is returned unchanged so
double-wrapping is impossible.

An action may declare `defaultElevation: 'sudo'` to express "this action almost
always needs root". The Executor resolves the effective elevation from
`action.defaultElevation`, a session-remembered rule, or an explicit `elevation`
flag on the invocation context.

### 2. Every sudo is gated — read-tier included

This is the rule that removes the privilege-escalation hole. Read actions
execute without prompting today; elevated read actions do not — they go through
the same approval flow as mutations:

| tier + elevation | gate behaviour |
|---|---|
| read, none | no prompt (unchanged) |
| **read, sudo** | approval prompt — approve-once / approve-remember-this-session / reject |
| mutate, none | approval prompt (unchanged) |
| **mutate, sudo** | approval prompt with **double-confirm** (two messages); config-toggleable to single via `sudo_double_confirm_mutate` |
| destructive, none | fresh prompt, never remembered (unchanged) |
| **destructive, sudo** | fresh prompt, **never remembered** — the same guardrail as plain destructive |

### 3. Path denylist applies to sudo args

The Executor's path-denylist check runs **before** the elevation gate. It scans
not just the canonical `path` arg but any string arg whose value looks like a
filesystem path (starts with `/` or `~/`). This means `sudo cat ~/.ssh/id_rsa`
is refused with `path-denied` even if the user would approve the elevation — the
denylist is not bypassable by wrapping a command in sudo.

### 4. Session-only, environment-scoped remember

`approve-remember` stores an `(environment, actionName)` key in an in-memory
`Set` on the executor. It is:

- **Session-only**: the set is never written to PGlite and is discarded when the
  process exits. Persisting remembered sudo rules across restarts is deferred to
  a future "remembered allowlist" feature (which will also cover plain mutate
  "remember").
- **Environment-scoped**: a remembered `staging` sudo does not fire on `prod`.
  The key is checked and re-inserted on the resolved final `(environment, actionName)`
  inside the Executor, so the LLM cannot get a benign environment approved and
  replay it on another.
- **Never destructive**: the `approve-remember` path is guarded — if the action
  is `destructive`, `approve-remember` is dropped silently (not an error to the
  user; their intent is "run it once").

### 5. Reactive trigger — permission denied → propose sudo

The Executor inspects every non-elevated result. If the exit code is non-zero
and stderr matches a permission-boundary pattern (deterministic regexes in
`src/security/elevation.ts`, no LLM), it emits an `ElevationProposal` to the
TUI. The LLM does not decide to escalate — the gate offers it, the human
approves. The original failed result is still written to the audit log. The
re-run is recursion-bounded: the re-run has `elevation === 'sudo'`, so the
reactive check only fires in the `elevation === 'none'` branch and cannot loop.

### 6. Auth: `sudo -n` first, interactive TTY passthrough on demand

1. **Default: `sudo -n <cmd>`** — non-interactive. Works when the SSH user has
   `NOPASSWD` in sudoers. No password material anywhere.
2. **Password required**: if `sudo -n` exits non-zero and stderr matches a
   password/TTY-required pattern, the Executor proposes a TTY passthrough to
   the TUI.
3. **TTY passthrough** (opt-in, per command): `src/exec/ssh.ts#toInteractive`
   transforms the already-built `sudo -n` argv into an interactive form by
   dropping `-o BatchMode=yes`, inserting `-tt`, and replacing `sudo -n` with
   `sudo` inside the quoted remote command. The Executor runs this child with
   **inherited stdio** (`stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'`).
   The sudo prompt and the typed password live on the user's TTY; PIPER's piped
   capture path is not used. Only the exit code is captured. The audit log
   records the command (scrubbed, `sudo` visible but no password) and the exit
   code; no stdout or stderr row is written for the interactive run.

This is the **only** path in PIPER that breaks `BatchMode=yes`, it is opt-in per
command, and it is isolated from the audited read/diagnostic flow.

### 7. Re-validation on the resolved final command

After approval and after `buildCommand` runs, the Executor checks that the
resolved argv actually carries `sudo` before spawning anything. If
`buildCommand` drops the elevation by bug or tampering, the Executor refuses
with `execution-failed: approved sudo but resolved command lacks sudo`. A
remembered rule is re-matched on `(environment, actionName)` inside the
Executor, not at proposal time, so the LLM cannot get a benign command approved
and then swap in an elevated one, or vice versa.

## Consequences

### Positive

- **One sudo codepath, centrally auditable.** Every elevated command — proactive,
  reactive, read, or mutate — passes through the same gate, the same denylist,
  the same scrubber, and the same audit log. The ad-hoc `sudo -n` strings
  previously embedded in individual action `buildCommand` implementations are
  replaced by the shared helper.
- **Password material structurally absent from PIPER's data.** `sudo -n` carries
  no password. The TTY passthrough's inherited stdio means the password is typed
  on the user's terminal and never reaches any PIPER buffer, log, or model
  message. This is not "we scrub passwords" — it is "passwords are never in our
  buffers to scrub".
- **Gate is unchanged.** More elevation capability does not mean more exec
  surface. Every sudo command still goes through the one Executor, the one
  catalog, the one scrubber.
- **Reactive sudo closes the friction gap.** A user diagnosing a hardened host
  doesn't need to know in advance which commands need root; PIPER offers the
  re-run when it detects a permission failure, and the user approves once.

### Negative

- **Session-only remember doesn't survive restarts.** A user who approved
  `read+sudo` for `system.iptables_list` on staging and then restarts PIPER will
  be prompted again. Acceptable for M2; deferred to a future remembered-allowlist
  feature.
- **Interactive TTY passthrough briefly shares the terminal with Ink.** For the
  duration of the password prompt, Ink's rendering is paused and the user is
  interacting with the raw `ssh -tt` child. On most terminals this is invisible;
  on a few it may cause a momentary layout flicker. There is no way to avoid this
  without reimplementing a password-entry UI in PIPER — which would mean PIPER
  handling password material, which we deliberately refuse to do.

## Alternatives rejected

### A. Silent sudo on read actions

Treat `read+sudo` like `read` today — execute without prompting. **Rejected**:
this is the privilege-escalation hole the feature exists to close. A planner
(or a prompt-injected planner) could silently read `/etc/shadow`, protected
private keys, or any other file that passes the path denylist only because it
doesn't match the denylist patterns (false negative). Gating every sudo is the
only design where "what did PIPER read with root?" has a complete, auditable
answer.

### B. NOPASSWD-only (refuse hosts that need a password)

Support `sudo -n` only; refuse to run on hosts that require a password. **Rejected**:
this excludes the majority of real production hosts, which are hardened to require
a password for interactive sudo. The TTY passthrough is the right trade-off — the
user provides the password on their own terminal, and PIPER's security properties
are unchanged.

### C. Capture the password through PIPER

Prompt for the sudo password in PIPER's TUI and pass it to `sudo --stdin` or via
`sshpass`. **Rejected**: this turns PIPER into a credential handler. The password
would transit PIPER's buffers, the scrubber would have to recognise it (it
cannot, because passwords are not fixed patterns), and the pre-LLM scrub would
not necessarily catch it. The password could appear in the audit log or in a
model message. The TTY passthrough avoids all of this by construction.

### D. Per-action hard-coded sudo

Leave `sudo -n` embedded in individual `buildCommand` implementations, with no
shared helper and no central gate. **Rejected**: this is the pre-feature state.
It produces one sudo code path per action with no central audit, no denylist
intercept, no approval gate on elevated reads, and no way to test the security
invariants as a category. The shared helper + single gate is the correct
architecture.

## Verification

The sudo gate's security invariants are enforced by tests in `tests/gate/` and
`tests/unit/security/`:

- A `read+sudo` action requires explicit approval — it does not execute silently.
- A sudo action whose path arg is in the denylist is refused with `path-denied`,
  even if the elevation would otherwise be approved.
- After approval, if `buildCommand` produces an argv that lacks `sudo`, the
  Executor refuses with `execution-failed` (re-validation invariant). Covered by
  `tests/gate/sudo-elevation.test.ts`:
  *"re-validation: approved sudo but buildCommand drops it → refuse execution-failed"*.
- A `destructive+sudo` decision of `approve-remember` is never stored in the
  remembered set; subsequent invocations prompt again. Covered by
  `tests/gate/sudo-elevation.test.ts`:
  *"destructive+sudo is never remembered — approve-remember still prompts next time"*.
- A `mutate+sudo` action is double-gated: the elevation proposal carries
  `doubleConfirm: true` (default config) AND the mutation approval gate still runs
  after the elevation is approved — two independent confirmations. Covered by
  `tests/gate/sudo-elevation.test.ts`:
  *"mutate+sudo: elevation proposal has doubleConfirm and the mutation gate also runs"*.
- A remembered `staging` sudo key does not fire on `prod` (env-scoped isolation).
- The reactive trigger fires only on non-zero exit + permission-boundary stderr,
  never on clean exits.
- The recursion guard holds: a reactive re-run (elevation='sudo') does not
  trigger a second reactive proposal.
- `toInteractive` drops `BatchMode=yes`, ensures `-tt`, and replaces `sudo -n`
  with `sudo` in the remote command — structural test, no live sudo.
