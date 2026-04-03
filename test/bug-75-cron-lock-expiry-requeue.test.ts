/**
 * Bug #75: Cron job with preventOverlap fires immediately on reconnect
 *
 * Root cause: TWO interacting bugs:
 *
 * 1. processExpiredLockInner (lockManager.ts) re-queues cron jobs with
 *    preventOverlap instead of discarding them. During graceful shutdown,
 *    _doClose() clears the heartbeat timer, so locks are not renewed.
 *    If the job takes longer than the lock TTL (30s default), the lock
 *    expires and the cron job is re-queued — sitting in the queue waiting
 *    for the next worker to pull it.
 *
 * 2. ackBatchWithResults / ackBatch (queueManager.ts) silently skip jobs
 *    whose lock verification fails, without calling completeStallRetriedJob.
 *    The single ack() method has this recovery, but the batch paths don't.
 *    Since workers use the ackBatcher (ACKB), the re-queued cron job is
 *    never cleaned up.
 *
 * Reproduction:
 *   Run 1: cron fires → worker pulls → ^C → lock expires → job re-queued
 *   → ACK via ACKB skips recovery → job stays in queue
 *   Run 2: worker connects → immediately pulls the stale cron job
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import type { JobId } from '../src/domain/types/job';
import { shardIndex } from '../src/shared/hash';

function getInternalLockContext(qm: QueueManager): any {
  const qmAny = qm as any;
  return {
    shards: qmAny.shards,
    shardLocks: qmAny.shardLocks,
    processingShards: qmAny.processingShards,
    processingLocks: qmAny.processingLocks,
    jobIndex: qmAny.jobIndex,
    jobLocks: qmAny.jobLocks,
    clientJobs: qmAny.clientJobs,
    eventsManager: qmAny.eventsManager,
    stalledCandidates: qmAny.stalledCandidates,
    storage: qmAny.storage,
    dashboardEmit: null,
  };
}

describe('Bug #75: Cron lock expiry re-queues job causing immediate fire on reconnect', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  test('lock expiration should discard cron jobs with preventOverlap instead of re-queuing', async () => {
    // 1. Register cron with preventOverlap (adds cron to scheduler)
    qm.addCron({
      name: 'test-cron',
      queue: 'testing',
      data: {},
      schedule: '* * * * *',
      preventOverlap: true,
    });

    // 2. Push a cron job with the uniqueKey (simulating what the cron scheduler does)
    const cronJob = await qm.push('testing', {
      data: { type: 'cron' },
      uniqueKey: 'cron:test-cron',
    });
    expect(cronJob).not.toBeNull();

    // 3. Pull with lock (short TTL for testing)
    const { job, token } = await qm.pullWithLock('testing', 'worker-1', 0, 50); // 50ms TTL
    expect(job).not.toBeNull();
    expect(token).not.toBeNull();
    expect(job!.uniqueKey).toBe('cron:test-cron');

    // 4. Wait for lock to expire (simulating heartbeat stopped during shutdown)
    await Bun.sleep(100);

    // 5. Run lock expiration check
    await checkExpiredLocks(getInternalLockContext(qm));

    // BUG: Without fix, the cron job is re-queued (state = 'waiting')
    // FIX: The cron job should be discarded (not in queue, not in processing)
    const stateAfter = await qm.getJobState(job!.id);
    // With the fix, the job should NOT be in the queue
    expect(stateAfter).not.toBe('waiting');
  });

  test('batch ACK should recover stall-retried cron job (like single ACK does)', async () => {
    // 1. Push a cron job with uniqueKey
    const cronJob = await qm.push('testing', {
      data: { type: 'cron' },
      uniqueKey: 'cron:test-cron',
    });

    // 2. Pull with lock (short TTL)
    const { job, token } = await qm.pullWithLock('testing', 'worker-1', 0, 50);
    expect(job).not.toBeNull();

    // 3. Wait for lock to expire
    await Bun.sleep(100);

    // 4. Lock expiration re-queues the job
    await checkExpiredLocks(getInternalLockContext(qm));

    // Job should be back in queue
    const stateBeforeAck = await qm.getJobState(job!.id);

    // 5. Simulate batch ACK (what the worker's ackBatcher sends)
    // This should recover the stall-retried job, not silently skip it
    await qm.ackBatchWithResults([{ id: job!.id, result: 'done', token: token! }]);

    // After batch ACK, the job should be completed or removed — not still waiting
    const stateAfterAck = await qm.getJobState(job!.id);
    expect(stateAfterAck).not.toBe('waiting');

    // The uniqueKey should be released so the next cron fire can push
    const idx = shardIndex('testing');
    const shard = qm.getShards()[idx];
    const keyEntry = shard.getUniqueKeyEntry('testing', 'cron:test-cron');
    expect(keyEntry).toBeNull();
  });

  test('full scenario: re-queued cron job should not be pullable after ACK', async () => {
    // This test simulates the full bug scenario from discussion #75

    // 1. Push cron job
    await qm.push('testing', {
      data: { type: 'cron-job' },
      uniqueKey: 'cron:start-new-test-job',
    });

    // 2. Worker pulls with lock
    const { job, token } = await qm.pullWithLock('testing', 'worker-1', 0, 50);
    expect(job).not.toBeNull();

    // 3. Lock expires (heartbeat stopped during shutdown)
    await Bun.sleep(100);
    await checkExpiredLocks(getInternalLockContext(qm));

    // 4. Worker finishes and ACKs via batch (like ackBatcher does)
    await qm.ackBatchWithResults([{ id: job!.id, result: { done: true }, token: token! }]);

    // 5. Simulate "Run 2": new worker connects and tries to pull
    // There should be NO job in the queue
    const nextJob = await qm.pull('testing', 0);
    expect(nextJob).toBeNull();

    // 6. UniqueKey should be released
    const idx = shardIndex('testing');
    const shard = qm.getShards()[idx];
    expect(shard.getUniqueKeyEntry('testing', 'cron:start-new-test-job')).toBeNull();
  });
});
