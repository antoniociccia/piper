# Contributing to PIPER

Thanks for your interest. PIPER is intentionally small in scope and strict about
safety. Please read this first.

## Ground rules

1. **Read the design doc.** [`docs/decisions/ADR-001-deterministic-gate.md`](docs/decisions/ADR-001-deterministic-gate.md)
   explains why PIPER is built the way it is. Most "shouldn't we just…" questions
   are answered there.

2. **The LLM never executes anything directly.** It selects typed actions from a
   fixed catalog. Adding a capability = adding an entry in `src/actions/builtin/`
   with `argsSchema`, `buildCommand`, `parseResult`, and tests. **Not** ad-hoc shell.

3. **Single side-effect modules.** All external effects go through one designated
   module each:
   - Command exec → `src/exec/executor.ts`
   - SSH → `src/exec/ssh.ts`
   - Model calls → `src/models/client.ts`
   - Secret scrubbing → `src/security/scrub.ts`

   If you find yourself shelling out from a new file, **stop**.

4. **No `any`.** TypeScript `strict` mode with `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, etc. Use Zod for runtime validation at boundaries.

5. **No `console.log`** in `src/`. Use the structured logger (`src/logging/logger.ts`).

## What we accept

- Bug fixes with tests.
- New `read`-tier actions (M1) following the existing pattern.
- Performance work on the executor, scrubber, or verifier.
- Documentation improvements.
- Local-provider integrations (Ollama, LM Studio, etc.) via the existing
  OpenAI-compatible client.

## What we don't accept (yet)

- `mutate` or `destructive` tier actions — these come in M2 with the full HITL
  approval flow.
- Free-form shell exec actions.
- Anything that bypasses the path denylist or scrubber.
- Telemetry, "phone home", or analytics.

## Process

1. **Open an issue first** for anything larger than a typo. Labels:
   `good first issue`, `action`, `gate`, `tui`, `bug`, `discussion`.

2. **Branch naming**: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`.

3. **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
   `chore:`, `perf:`. Scopes encouraged: `feat(actions): add network.traceroute`.

4. **Tests required**. CI runs `bun test` (unit + gate) on every PR. E2E tests
   (`bun run e2e`) are run on every release.

5. **PR must include**:
   - Test coverage for the change.
   - Doc updates if user-visible.
   - CHANGELOG fragment if user-visible.

6. **Two-eyes rule** on anything touching `src/exec/`, `src/security/`, or
   `src/actions/`. The maintainer reviews these personally.

## Adding a new read action — template

A new action goes in `src/actions/builtin/<your-action>.ts`:

```ts
import { z } from 'zod';
import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  // Validate every free-text arg with a tight regex — no shell metachars.
  filter: z.string().regex(/^[A-Za-z0-9._\- ]*$/).optional(),
});
type Args = z.infer<typeof argsSchema>;

export const yourAction: Action<Args, { /* parsed result */ }> = {
  name: 'namespace.action_name',
  tier: 'read',
  description: 'Short, plain-English description for the LLM and humans.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['your', 'argv', 'pieces']);
  },
  parseResult: (raw, args) => ({ /* parse stdout/stderr/exitCode */ }),
};
```

Then register in `src/actions/builtin/index.ts`. Tests in
`tests/unit/actions/builtin/builtins.test.ts`. Make sure:

- `argsSchema` uses regex constraints on free-text fields.
- `buildCommand` returns `readonly string[]` argv — **never** a shell-joined
  string. Argv is then quoted by `argvToShell` only at audit-log time.
- `parseResult` handles empty / error / unexpected output without crashing.

## Running locally

```bash
bun install
bun dev                  # run from source
bun run typecheck        # tsc --noEmit
bun test                 # unit + gate tests
bun run build            # bun build --compile → dist/piper
bun run e2e              # Docker sshd fixture + E2E tests
```

## Code of conduct

[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Enforced.

## License

Apache-2.0. By contributing you agree your contribution is licensed the same way
(Apache-2.0 §5 inbound = outbound).
