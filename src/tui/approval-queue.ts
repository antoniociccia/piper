/**
 * Serializes human-approval prompts. The TUI holds ONE pending approval panel
 * at a time (`pendingElevation` / `pendingMutation` are single state slots) —
 * but the gather phase runs read steps in PARALLEL, so two probes can hit a
 * permission boundary simultaneously and both ask for sudo at once. Without
 * serialization the second dispatch overwrites the first panel's state and the
 * first caller's promise never resolves: the executor awaits forever and the
 * whole run hangs.
 *
 * The queue guarantees a task (one prompt: dispatch panel → await user) only
 * starts after the previous one settled. Rejections propagate to the caller
 * but never wedge the chain.
 */
export interface ApprovalQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createApprovalQueue(): ApprovalQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task);
      // Keep the chain alive whatever the outcome; the caller still sees the
      // original rejection through `next`.
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
