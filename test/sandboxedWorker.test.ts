/**
 * Sandboxed Worker Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SandboxedWorker } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { unlink } from 'fs/promises';

describe('SandboxedWorker', () => {
  let manager: QueueManager;
  let processorPath: string;

  beforeAll(async () => {
    manager = new QueueManager();

    // Create a temporary processor file
    processorPath = `${Bun.env.TMPDIR || '/tmp'}/test-processor-${Date.now()}.ts`;
    await Bun.write(
      processorPath,
      `
      export default async (job: { id: string; data: any; queue: string; progress: (n: number) => void }) => {
        job.progress(50);
        await Bun.sleep(10);
        job.progress(100);
        return { processed: true, value: job.data.value * 2 };
      };
    `
    );
  });

  afterAll(async () => {
    await manager.shutdown();
    try {
      await unlink(processorPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  test('should create sandboxed worker with options', () => {
    const worker = new SandboxedWorker('sandboxed-test', {
      processor: processorPath,
      concurrency: 2,
      timeout: 5000,
      manager,
    });

    expect(worker).toBeDefined();
    const stats = worker.getStats();
    expect(stats.total).toBe(0); // Not started yet
  });

  test('should start and stop worker pool', async () => {
    const worker = new SandboxedWorker('sandboxed-test-2', {
      processor: processorPath,
      concurrency: 2,
      manager,
    });

    await worker.start();
    const stats = worker.getStats();
    expect(stats.total).toBe(2);
    expect(stats.idle).toBe(2);
    expect(stats.busy).toBe(0);

    await worker.stop();
    expect(worker.getStats().total).toBe(0);
  });

  test('should process jobs in isolated workers', async () => {
    const queueName = `sandboxed-process-test-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    await worker.start();

    // Add job using manager directly
    const job = await manager.push(queueName, { data: { value: 21 } });
    expect(job.id).toBeDefined();

    // Wait for processing with polling
    let result: unknown;
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      result = manager.getResult(job.id);
      if (result !== undefined) break;
    }

    expect(result).toEqual({ processed: true, value: 42 });

    await worker.stop();
  });

  test('should handle multiple concurrent jobs', async () => {
    const queueName = 'sandboxed-concurrent-test';
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 4,
      timeout: 5000,
      manager,
    });

    await worker.start();

    // Add multiple jobs
    const jobs = await Promise.all([
      manager.push(queueName, { data: { value: 1 } }),
      manager.push(queueName, { data: { value: 2 } }),
      manager.push(queueName, { data: { value: 3 } }),
      manager.push(queueName, { data: { value: 4 } }),
    ]);

    // Wait for processing
    await Bun.sleep(1000);

    // Check all results
    for (let i = 0; i < jobs.length; i++) {
      const result = await manager.getResult(jobs[i].id);
      expect(result).toEqual({ processed: true, value: (i + 1) * 2 });
    }

    await worker.stop();
  });

  test('should handle worker timeout', async () => {
    // Create a slow processor
    const slowProcessorPath = `${Bun.env.TMPDIR || '/tmp'}/slow-processor-${Date.now()}.ts`;
    await Bun.write(
      slowProcessorPath,
      `
      export default async (job: any) => {
        await Bun.sleep(10000); // 10 seconds
        return { done: true };
      };
    `
    );

    const queueName = `sandboxed-timeout-test-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: slowProcessorPath,
      concurrency: 1,
      timeout: 100, // 100ms timeout
      manager,
    });

    await worker.start();

    await manager.push(queueName, { data: { test: true } });

    // Wait for timeout + restart with polling
    let stats = worker.getStats();
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      stats = worker.getStats();
      if (stats.restarts > 0) break;
    }

    // Worker should have restarted after timeout
    expect(stats.restarts).toBeGreaterThan(0);

    await worker.stop();

    try {
      await unlink(slowProcessorPath);
    } catch {
      // Ignore
    }
  });

  test('should handle processor errors', async () => {
    // Create an error-throwing processor
    const errorProcessorPath = `${Bun.env.TMPDIR || '/tmp'}/error-processor-${Date.now()}.ts`;
    await Bun.write(
      errorProcessorPath,
      `
      export default async (job: any) => {
        throw new Error('Test error from processor');
      };
    `
    );

    const queueName = `sandboxed-error-test-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: errorProcessorPath,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    await worker.start();

    await manager.push(queueName, { data: { test: true } });

    // Wait for error to be processed
    let stats = worker.getStats();
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(100);
      stats = worker.getStats();
      if (stats.idle === 1) break;
    }

    // Worker should still be running after handling error
    expect(stats.total).toBe(1);
    expect(stats.idle).toBe(1); // Worker is idle after processing

    await worker.stop();

    try {
      await unlink(errorProcessorPath);
    } catch {
      // Ignore
    }
  });

  test('should report correct stats', async () => {
    const worker = new SandboxedWorker('sandboxed-stats-test', {
      processor: processorPath,
      concurrency: 3,
      manager,
    });

    await worker.start();

    const stats = worker.getStats();
    expect(stats.total).toBe(3);
    expect(stats.idle).toBe(3);
    expect(stats.busy).toBe(0);
    expect(stats.restarts).toBe(0);

    await worker.stop();
  });
});
