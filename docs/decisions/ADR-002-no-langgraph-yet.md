# ADR-002 — Plain async-generator runner, not LangGraph (yet)

- **Status**: accepted (M1)
- **Date**: 2026-05-25
- **Audience**: contributors evaluating the agent layer
- **Supersedes**: nothing
- **Superseded by**: nothing (likely revisited in M2)

## Context

`CLAUDE.md` originally specified LangGraph.js as PIPER's agent orchestration
layer. LangGraph offers four things we genuinely need eventually:

1. A typed state machine of nodes + edges (plan / gather / synthesize / verify /
   propose / execute / verify-rollback).
2. **Durable execution** — checkpointed state, resume after crashes.
3. **Human-in-the-loop interrupts** (`interrupt()`) — the gate's mutation flow
   needs this in M2.
4. **Time-travel / replay** — replay a session from any checkpoint.

For M1, the diagnostic flow is linear:

```
plan → gather → synthesize → verify → (propose → approve → repeat)
```

No long-running interrupts. No durable resume across process restarts (sessions
are interactive and short). No replay requirement.

## Decision

**M1 uses a plain TypeScript async generator** in `src/agent/runner.ts`. It
exposes the same conceptual nodes (plan/gather/synthesize/verify) as discrete
functions, calls them in sequence, and yields a typed `AgentEvent` stream that
the TUI consumes.

LangGraph is **deferred to M2**, where mutation approval flows + durable
resume become first-class requirements.

## Why defer

### Cost of adopting LangGraph today

- Dependency on `@langchain/langgraph` (and transitively on a slice of LangChain
  Core). LangChain's interface has had breaking changes across minor versions.
- The community PGlite checkpointer (`@steerprotocol/langgraph-checkpoint-pglite`)
  is a one-maintainer package; pinning it tight enough to track LangGraph's
  `BaseCheckpointSaver` API is a real maintenance burden.
- The alternative — a custom subclass of `BaseCheckpointSaver` against PGlite —
  is ~150 lines of code we'd write only to throw away if LangGraph's API moves.
- LangGraph encourages a "let the framework call your nodes" inversion of
  control. Our deterministic gate (ADR-001) wants us in control.

### Benefit we'd get today

- Roughly nothing in M1. The flow is `plan() → gather() → synthesize() →
  verify()`. The conditional edge "if verify fails, retry synthesize" is one
  `while` loop, not a state machine.

### When the calculus flips (M2)

Mutation actions need:

```
propose → interrupt(human approval) → execute → verify → on-fail → rollback
```

`interrupt()` is the LangGraph primitive we don't want to reinvent. The
moment we add `mutate` tier actions, we'll add LangGraph and migrate the
existing nodes. The nodes themselves are already shaped as pure async
functions taking input + deps and returning output — they port cleanly.

## Consequences

### Pros

- No external dependency on the agent layer beyond Zod and our own modules.
- Runner is ~250 lines, readable end-to-end, and uses standard JavaScript
  semantics (async generators with `yield` for the AgentEvent stream).
- TUI consumes the runner with a plain `for await (const event of runner.run(req))`
  loop. No framework on either side.
- Testing the runner is trivial: pass a scripted mock `ModelClient` whose
  `complete()` returns canned responses; assert the yielded event sequence.

### Cons

- No durable resume across PIPER restarts. A long session restarted from cold
  loses in-memory state (the audit log and chat history persist in PGlite if
  `PIPER_DATA_DIR` is set, but the agent state machine itself doesn't survive).
- The `approveProposals` callback bridge between TUI and runner is a
  React-state-via-Promise trick. It works, but LangGraph's `interrupt` would
  be more native to a long-running approval flow.
- When mutations land in M2, we'll do a one-time refactor — touching `runner.ts`,
  the TUI's approval bridge, and adding the LangGraph checkpointer.

## Alternatives considered

### A. Adopt LangGraph now, defer mutations

Build the LangGraph machinery for the diagnostic flow without using its
interrupt features yet. **Rejected** — pays the dependency + checkpointer cost
upfront for zero current benefit. The migration cost in M2 isn't lower this way.

### B. Build a custom mini-LangGraph in-house

Implement a state-machine runtime ourselves. **Rejected** — overkill for one
linear flow. We'd be writing a framework before we know what shape it should
take.

### C. Stay async-generator-only forever, even for M2

**Likely rejected** — LangGraph's `interrupt` + checkpointer give us durable
HITL approval flows for free. Reinventing those is not in scope for a one-person
project.

## Migration plan (when we go for LangGraph)

1. Install `@langchain/langgraph` and pick a checkpointer (community PGlite saver
   first, custom fallback ready).
2. Wrap existing `planNode`, `gatherNode`, `synthesizeNodeStream`,
   `proposeFollowups`, `verifyReport` as LangGraph `StateGraph` nodes with the
   same input/output contracts.
3. Replace the `for await` loop in `runner.run` with a `graph.compile()` +
   `graph.stream()` consumption.
4. Replace the `approveProposals` Promise bridge with a `graph.interrupt()`
   handler in the TUI.
5. Add a `graph.invoke({ thread_id: sessionId })` call, persisting state per
   session.

Estimated cost: ~1 working day. The async-generator detour wasn't wasted: it
shaped the nodes as composable pure functions, which is exactly what LangGraph
wants.

## Verification

The current runner is tested in `tests/unit/agent/runner.test.ts` against
scripted mock clients. When LangGraph lands, those tests port directly — same
input/output expectations, different orchestrator.
