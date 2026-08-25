# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in PIPER, please report it
**privately** — do not open a public GitHub issue.

Use:

- [GitHub Security Advisories](https://github.com/antoniociccia/piper/security/advisories/new)

Please include:

- Affected version (commit SHA or release tag)
- Reproduction steps
- Impact assessment as you see it
- Any suggested mitigation

**Default coordinated disclosure window: 90 days** from acknowledgement, or
earlier if a fix ships sooner. Critical issues affecting deployed users may be
disclosed faster with a coordinated advisory.

## In scope

PIPER's threat model is built around a deterministic gate that keeps an LLM from
touching infrastructure directly. The most sensitive surfaces:

1. **Prompt injection** that smuggles a command past the catalog allowlist.
2. **Shell execution outside `src/exec/executor.ts`** — any code path that
   spawns processes elsewhere is a regression.
3. **Unredacted secrets in logs or LLM context** — every output passes
   `scrubText` before being persisted or sent to the model. Bugs in the scrubber
   are critical.
4. **Path denylist bypass** — `~/.ssh/id_*`, `~/.aws/credentials`,
   `~/.piper/credentials.json`, `.env*` and similar must be unreadable via
   action args, regardless of who asks.
5. **Remembered-allowlist re-match failures** — when remembered approvals land
   (M2+), a rule must be matched against the *resolved* command at execution
   time, not at proposal time.
6. **SSH host allowlist bypass** — actions must only target environments
   registered in the registry.
7. **Destructive-tier auto-approval** — the M2 design explicitly forbids
   "don't ask again" for the `destructive` tier. A bug that lets this slip is
   critical.

## Out of scope

- LLM hallucination per se — wrong claims in synthesized reports are a
  *grounding* issue, not a security issue, unless they cause infrastructure to
  be touched (which the gate prevents by design).
- Vulnerabilities in upstream model providers (OpenRouter, Anthropic, etc.).
- Vulnerabilities in tools PIPER drives (`kubectl`, `docker`, `ssh`, etc.) when
  used as intended.
- Denial-of-service from misbehaving local models.

## Hardening tips for operators

- Always run with `max_session_cost_usd` set, not unlimited.
- Use a dedicated SSH key per environment in the registry (`identity_file`).
- Keep `~/.piper/credentials.json` at mode `0600` (the wizard already does this).
- Prefer **local model providers** (Ollama, LM Studio) when handling sensitive
  infrastructure — no prompt ever leaves the machine.
- When using OpenRouter, PIPER automatically sets
  `provider.data_collection: 'deny'`, routing through providers that
  contractually do not retain prompts.

## Disclosure history

No CVEs assigned yet.
