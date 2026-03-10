/**
 * Issue #39: bun app quits before sandboxed processor is processed
 *
 * When SandboxedWorker.stop() is called while jobs are still being processed,
 * the worker immediately terminates all Bun Worker threads without waiting
 * for active jobs to complete. This causes data loss / incomplete processing.
 *
 * The regular Worker.close() correctly drains active jobs before shutting down.
 * SandboxedWorker.stop() should behave the same way.
 *
 * Expected: stop() waits for busy workers to finish current jobs before terminating.
 * Actual: stop() calls worker.terminate() immediately, killing in-flight jobs.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SandboxedWorker } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { unlink } from 'fs/promises';

describe('Issue #39: SandboxedWorker.stop() should drain active jobs', () => {
  let manager: QueueManager;
  const cleanupFiles: string[] = [];

  beforeEach(async () => {
    manager = new QueueManager();
  });

  afterEach(async () => {
    await manager.shutdown();
    for (const f of cleanupFiles) {
      try {
        await unlink(f);
      } catch {
        // Ignore
      }
    }
    cleanupFiles.length = 0;
  });

  test('stop() should wait for active job to complete before terminating', async () => {
    // Create a processor that takes 1s to complete
    const processorPath = `${Bun.env.TMPDIR ?? '/tmp'}/test-processor-issue39-slow-${Date.now()}.ts`;
    await Bun.write(
      processorPath,
      `
      export default async (job: any) => {
        await Bun.sleep(1000);
        return { completed: true, id: job.id };
      };
    `
    );
    cleanupFiles.push(processorPath);

    const queueName = `issue39-drain-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 1,
      timeout: 10000,
      manager,
    });

    await worker.start();

    // Add a job
    const job = await manager.push(queueName, { data: { value: 42 } });

    // Wait for it to become active
    let active = false;
    worker.on('active', () => {
      active = true;
    });
    for (let i = 0; i < 50 && !active; i++) {
      await Bun.sleep(100);
    }
    expect(active).toBe(true);

    // Track if job completed
    let completedJobId: string | null = null;
    worker.on('completed', (j) => {
      completedJobId = String(j.id);
    });

    // Call stop() while the job is still processing (1s job)
    // This should WAIT for the job to finish, not kill it
    await worker.stop();

    // The job should have completed successfully before stop() returned
    expect(completedJobId).toBe(String(job.id));

    // The job result should be available
    const result = manager.getResult(job.id);
    expect(result).toEqual({ completed: true, id: String(job.id) });
  });

  test('stop() should drain multiple active jobs before terminating', async () => {
    // Create a processor that takes 2s (long enough for all 3 to become active)
    const processorPath = `${Bun.env.TMPDIR ?? '/tmp'}/test-processor-issue39-multi-${Date.now()}.ts`;
    await Bun.write(
      processorPath,
      `
      export default async (job: any) => {
        await Bun.sleep(2000);
        return { value: job.data.value * 2 };
      };
    `
    );
    cleanupFiles.push(processorPath);

    const queueName = `issue39-multi-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 3,
      timeout: 10000,
      manager,
    });

    // Register listeners BEFORE start to avoid missing events
    let activeCount = 0;
    const completedIds = new Set<string>();
    worker.on('active', () => {
      activeCount++;
    });
    worker.on('completed', (j) => {
      completedIds.add(String(j.id));
    });

    await worker.start();

    // Add 3 jobs that will be processed concurrently
    const jobs = await Promise.all([
      manager.push(queueName, { data: { value: 1 } }),
      manager.push(queueName, { data: { value: 2 } }),
      manager.push(queueName, { data: { value: 3 } }),
    ]);

    // Wait for all 3 to become active
    for (let i = 0; i < 100 && activeCount < 3; i++) {
      await Bun.sleep(100);
    }
    expect(activeCount).toBe(3);

    // stop() should wait for all 3 active jobs to complete
    await worker.stop();

    // All 3 jobs should have completed
    expect(completedIds.size).toBe(3);
    for (const job of jobs) {
      expect(completedIds.has(String(job.id))).toBe(true);
    }
  }, 15000);

  test('stop() should not pull new jobs while draining', async () => {
    // Processor takes 500ms
    const processorPath = `${Bun.env.TMPDIR ?? '/tmp'}/test-processor-issue39-nopull-${Date.now()}.ts`;
    await Bun.write(
      processorPath,
      `
      export default async (job: any) => {
        await Bun.sleep(500);
        return { ok: true };
      };
    `
    );
    cleanupFiles.push(processorPath);

    const queueName = `issue39-nopull-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 1,
      timeout: 10000,
      manager,
    });

    await worker.start();

    // Add 2 jobs - first will be active, second should stay waiting
    await manager.push(queueName, { data: { first: true } });
    await manager.push(queueName, { data: { second: true } });

    // Wait for first job to become active
    let active = false;
    worker.on('active', () => {
      active = true;
    });
    for (let i = 0; i < 50 && !active; i++) {
      await Bun.sleep(100);
    }
    expect(active).toBe(true);

    // Count completions
    let completedCount = 0;
    worker.on('completed', () => {
      completedCount++;
    });

    // stop() during first job - should finish first, but NOT pull second
    await worker.stop();

    // Only the first (active) job should have completed
    expect(completedCount).toBe(1);

    // Second job should still be waiting in the queue
    const counts = manager.getQueueJobCounts(queueName);
    expect(counts.waiting).toBe(1);
  });
});
