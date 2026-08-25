## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Why

<!-- The constraint or the bug. Link the issue if there is one. -->

## Checklist

- [ ] Tests added or updated, and they failed before the change
- [ ] `bun test` and `bun run typecheck` pass
- [ ] Docs updated if behaviour changed (README, action docs, ADR)
- [ ] CHANGELOG entry if the change is user-visible

## Touching the safety surface?

Tick anything this PR changes. These get reviewed personally by the maintainer.

- [ ] `src/exec/` — command execution or SSH
- [ ] `src/security/` — scrubber, path denylist, permissions
- [ ] `src/actions/` — the catalog

If any is ticked, describe what stops the gate from getting weaker:

<!-- e.g. "the new action is read-tier and its path arg goes through isPathDenied" -->
