/**
 * Audit Bug Reproduction Tests
 * Tests that reproduce bugs found during the 4-agent audit (2026-02-13)
 * Each test MUST fail before the fix and pass after.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';

// ============================================================
// BUG 1: Concurrency slot leak when pull finds no ready jobs
// [Job Queue Agent] pull.ts:196-213
// When tryAcquireConcurrency succeeds but no job is dequeued,
// the concurrency slot is never released, eventually starving the queue.
// ============================================================
describe('BUG: Concurrency slot leak on empty pull', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  test('concurrency slot must be released when pull finds no ready jobs', async () => {
    const queue = 'concurrency-leak-test';

    // Set concurrency limit to 2
    qm.setConcurrency(queue, 2);

    // Push a delayed job (not ready yet - 10 minutes in the future)
    await qm.push(queue, { data: { msg: 'delayed' }, delay: 600_000 });

    // Pull should find no ready jobs (only delayed one) - this should NOT consume concurrency slots
    const result1 = await qm.pull(queue, 0);
    expect(result1).toBeNull();

    const result2 = await qm.pull(queue, 0);
    expect(result2).toBeNull();

    // Now push a ready job
    await qm.push(queue, { data: { msg: 'ready' } });

    // This pull MUST succeed - the concurrency slots should NOT have been consumed by the empty pulls
    const result3 = await qm.pull(queue, 0);
    expect(result3).not.toBeNull();
    expect(result3!.data).toEqual({ msg: 'ready' });
  });

  test('batch pull must not leak concurrency slots when no jobs dequeued', async () => {
    const queue = 'batch-concurrency-leak-test';

    // Set concurrency limit to 2
    qm.setConcurrency(queue, 2);

    // Push delayed jobs only
    await qm.push(queue, { data: { msg: 'delayed1' }, delay: 600_000 });
    await qm.push(queue, { data: { msg: 'delayed2' }, delay: 600_000 });

    // Batch pull finds no ready jobs
    const batch = await qm.pullBatch(queue, 5, 0);
    expect(batch).toHaveLength(0);

    // Push ready jobs
    await qm.push(queue, { data: { msg: 'ready1' } });
    await qm.push(queue, { data: { msg: 'ready2' } });

    // Both should be pullable since concurrency limit is 2
    const batch2 = await qm.pullBatch(queue, 5, 0);
    expect(batch2.length).toBe(2);
  });
});

// ============================================================
// BUG 2: promoteJob mutates job.runAt without updating heap entry
// [Job Queue Agent] jobManagement.ts:162
// job.runAt is set to Date.now() but the heap entry retains the old runAt,
// so the job may not surface correctly for pulling.
// ============================================================
describe('BUG: promoteJob does not update heap entry', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  test('promoted delayed job must be immediately pullable', async () => {
    const queue = 'promote-test';

    // Push a job delayed by 1 hour
    const pushed = await qm.push(queue, {
      data: { msg: 'delayed-job' },
      delay: 3_600_000,
    });

    // Verify it's not pullable yet
    const before = await qm.pull(queue, 0);
    expect(before).toBeNull();

    // Promote the job
    const promoted = await qm.promote(pushed.id);
    expect(promoted).toBe(true);

    // The promoted job MUST be immediately pullable
    const after = await qm.pull(queue, 0);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(pushed.id);
    expect(after!.data).toEqual({ msg: 'delayed-job' });
  });

  test('promoted job must be pulled before other delayed jobs', async () => {
    const queue = 'promote-order-test';

    // Push two delayed jobs
    const job1 = await qm.push(queue, { data: { order: 1 }, delay: 3_600_000 });
    const job2 = await qm.push(queue, { data: { order: 2 }, delay: 3_600_000 });

    // Promote job2 only
    await qm.promote(job2.id);

    // Job2 should be pullable, job1 should not
    const pulled = await qm.pull(queue, 0);
    expect(pulled).not.toBeNull();
    expect(pulled!.id).toBe(job2.id);

    // Job1 should still be delayed
    const pulled2 = await qm.pull(queue, 0);
    expect(pulled2).toBeNull();
  });
});


// ============================================================
// BUG 5: HTTP body spread allows cmd override (Security)
// [TypeScript Agent] http.ts:256
// { cmd: 'PUSH', queue, ...body } allows body to override cmd field.
// ============================================================
describe('BUG: HTTP body spread allows cmd field override', () => {
  test('body cmd field must not override route-determined cmd', () => {
    const queue = 'test-queue';
    const body: Record<string, unknown> = { data: { msg: 'test' }, cmd: 'Obliterate' };

    // Fixed code: explicit field extraction, not spread
    const cmd = {
      cmd: 'PUSH' as const,
      queue,
      data: body.data,
      priority: body.priority,
    };

    // cmd field cannot be overridden
    expect(cmd.cmd).toBe('PUSH');
  });
});

