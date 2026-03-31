/**
 * Bug #69: Job still started when job running longer than next queued job
 *
 * When a cron job has a pattern shorter than the job runtime (e.g., fires every
 * 100ms but job takes 500ms), handleDeduplication allows a duplicate because:
 *   1. The active job is no longer in the priority queue (it was popped on pull)
 *   2. q.find() returns null for active jobs
 *   3. handleDeduplication falls through to "allow new insert"
 *   4. pushJob also falls through when dedupResult.skip is true but q.find() is null
 *
 * @see https://github.com/egeominotti/bunqueue/issues/69
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue } from '../src/client';
import { getSharedManager } from '../src/client/manager';

describe('Bug #69: deduplication must block pushes while job is active', () => {
  let queue: Queue;

  beforeEach(() => {
    queue = new Queue('test-bug-69', { embedded: true });
  });

  afterEach(async () => {
    const manager = getSharedManager();
    for (const cron of manager.listCrons()) {
      manager.removeCron(cron.name);
    }
    await queue.obliterate();
    await queue.close();
  });

  test('push with uniqueKey should be rejected while a job with same key is active (processing)', async () => {
    const manager = getSharedManager();
    const queueName = 'test-bug-69';

    // Push a job with a uniqueKey
    const job1 = await manager.push(queueName, {
      data: { iteration: 1 },
      uniqueKey: 'singleton-job',
      dedup: { ttl: 60_000 },
    });

    // Pull the job — it moves from priority queue to processingShards
    const pulledJob = await manager.pull(queueName);
    expect(pulledJob).not.toBeNull();
    expect(pulledJob!.id).toBe(job1.id);

    // Now try to push another job with the SAME uniqueKey while job1 is active
    const job2 = await manager.push(queueName, {
      data: { iteration: 2 },
      uniqueKey: 'singleton-job',
      dedup: { ttl: 60_000 },
    });

    // Bug #69: job2 should be deduplicated (return existing ID), not a new job
    expect(job2.id).toBe(job1.id);

    // There should be 0 waiting jobs (job1 is active, job2 was deduplicated)
    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(0);
  });

  test('push with uniqueKey should be allowed after active job is acked', async () => {
    const manager = getSharedManager();
    const queueName = 'test-bug-69';

    // Push and pull a job
    const job1 = await manager.push(queueName, {
      data: { iteration: 1 },
      uniqueKey: 'singleton-job',
      dedup: { ttl: 60_000 },
    });
    const pulledJob = await manager.pull(queueName);
    expect(pulledJob).not.toBeNull();

    // Ack the job — this should release the uniqueKey
    await manager.ack(job1.id);

    // Now a new push with the same uniqueKey should succeed as a NEW job
    const job2 = await manager.push(queueName, {
      data: { iteration: 2 },
      uniqueKey: 'singleton-job',
      dedup: { ttl: 60_000 },
    });

    // Should be a different job (new insert allowed after ack)
    expect(job2.id).not.toBe(job1.id);

    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(1);
  });

  test('cron with dedup should not create duplicates when job runtime exceeds interval', async () => {
    const manager = getSharedManager();
    const queueName = 'test-bug-69';

    // Simulate: push first cron-fired job with uniqueKey
    const job1 = await manager.push(queueName, {
      data: { tick: 1 },
      uniqueKey: 'cron-singleton',
      dedup: { ttl: 60_000 },
    });

    // Worker pulls it (now active/processing)
    const pulled = await manager.pull(queueName);
    expect(pulled).not.toBeNull();

    // Simulate multiple cron ticks while job1 is still processing
    const pushResults: { id: number }[] = [];
    for (let i = 2; i <= 5; i++) {
      const result = await manager.push(queueName, {
        data: { tick: i },
        uniqueKey: 'cron-singleton',
        dedup: { ttl: 60_000 },
      });
      pushResults.push({ id: Number(result.id) });
    }

    // All subsequent pushes should return the original job's ID (deduplicated)
    for (const r of pushResults) {
      expect(r.id).toBe(Number(job1.id));
    }

    // No new jobs should be waiting
    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(0);
  });

  test('batch push with uniqueKey should be deduplicated while job is active', async () => {
    const manager = getSharedManager();
    const queueName = 'test-bug-69';

    // Push and pull a job
    const job1 = await manager.push(queueName, {
      data: { v: 1 },
      uniqueKey: 'batch-singleton',
      dedup: { ttl: 60_000 },
    });
    await manager.pull(queueName);

    // Batch push with the same uniqueKey
    const ids = await manager.pushBatch(queueName, [
      { data: { v: 2 }, uniqueKey: 'batch-singleton', dedup: { ttl: 60_000 } },
      { data: { v: 3 }, uniqueKey: 'batch-singleton', dedup: { ttl: 60_000 } },
    ]);

    // Both should return the original job ID
    expect(ids[0]).toBe(job1.id);
    expect(ids[1]).toBe(job1.id);

    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(0);
  });
});
