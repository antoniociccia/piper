import { describe, expect, test } from 'bun:test';

import { createApprovalQueue } from '../../../src/tui/approval-queue.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createApprovalQueue', () => {
  test('runs a single task and returns its value', async () => {
    const q = createApprovalQueue();
    const out = await q.enqueue(async () => 'ok');
    expect(out).toBe('ok');
  });

  test('serializes concurrent tasks: the second starts only after the first resolves', async () => {
    const q = createApprovalQueue();
    const order: string[] = [];
    const first = deferred<string>();

    const p1 = q.enqueue(() => {
      order.push('start-1');
      return first.promise;
    });
    const p2 = q.enqueue(async () => {
      order.push('start-2');
      return 'two';
    });

    // Give the event loop a chance: task 2 must NOT have started yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start-1']);

    first.resolve('one');
    expect(await p1).toBe('one');
    expect(await p2).toBe('two');
    expect(order).toEqual(['start-1', 'start-2']);
  });

  test('a rejected task does not wedge the queue', async () => {
    const q = createApprovalQueue();
    const p1 = q.enqueue(async () => {
      throw new Error('declined');
    });
    await expect(p1).rejects.toThrow('declined');
    const out = await q.enqueue(async () => 'still alive');
    expect(out).toBe('still alive');
  });

  test('preserves FIFO order across many tasks', async () => {
    const q = createApprovalQueue();
    const seen: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        q.enqueue(async () => {
          seen.push(n);
          await new Promise((r) => setTimeout(r, 1));
          return n;
        }),
      ),
    );
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});
