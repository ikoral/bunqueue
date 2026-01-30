/**
 * Sandboxed Worker Tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SandboxedWorker } from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

describe('SandboxedWorker', () => {
  let manager: QueueManager;
  let processorPath: string;

  beforeAll(async () => {
    manager = new QueueManager();

    // Create a temporary processor file
    processorPath = join(tmpdir(), `test-processor-${Date.now()}.ts`);
    writeFileSync(
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
      unlinkSync(processorPath);
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
    const queueName = 'sandboxed-process-test';
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 2,
      timeout: 5000,
      manager,
    });

    await worker.start();

    // Add job using manager directly
    const job = await manager.push(queueName, { data: { value: 21 } });
    expect(job.id).toBeDefined();

    // Wait for processing
    await Bun.sleep(500);

    // Check result
    const result = await manager.getResult(job.id);
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
    const slowProcessorPath = join(tmpdir(), `slow-processor-${Date.now()}.ts`);
    writeFileSync(
      slowProcessorPath,
      `
      export default async (job: any) => {
        await Bun.sleep(10000); // 10 seconds
        return { done: true };
      };
    `
    );

    const queueName = 'sandboxed-timeout-test';
    const worker = new SandboxedWorker(queueName, {
      processor: slowProcessorPath,
      concurrency: 1,
      timeout: 100, // 100ms timeout
      manager,
    });

    await worker.start();

    const job = await manager.push(queueName, { data: { test: true } });

    // Wait for timeout + restart
    await Bun.sleep(500);

    // Worker should have restarted after timeout
    const stats = worker.getStats();
    expect(stats.restarts).toBeGreaterThan(0);

    await worker.stop();

    try {
      unlinkSync(slowProcessorPath);
    } catch {
      // Ignore
    }
  });

  test('should handle processor errors', async () => {
    // Create an error-throwing processor
    const errorProcessorPath = join(tmpdir(), `error-processor-${Date.now()}.ts`);
    writeFileSync(
      errorProcessorPath,
      `
      export default async (job: any) => {
        throw new Error('Test error from processor');
      };
    `
    );

    const queueName = 'sandboxed-error-test';
    const worker = new SandboxedWorker(queueName, {
      processor: errorProcessorPath,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    await worker.start();

    await manager.push(queueName, { data: { test: true } });

    // Wait for processing
    await Bun.sleep(500);

    // Worker should still be running after handling error
    const stats = worker.getStats();
    expect(stats.total).toBe(1);
    expect(stats.idle).toBe(1); // Worker is idle after processing

    await worker.stop();

    try {
      unlinkSync(errorProcessorPath);
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
