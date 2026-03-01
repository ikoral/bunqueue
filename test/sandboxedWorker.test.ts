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
    processorPath = `${Bun.env.TMPDIR ?? '/tmp'}/test-processor-${Date.now()}.ts`;
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
    const queueName = `sandboxed-concurrent-test-${Date.now()}`;
    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 4,
      timeout: 10000,
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

    // Wait for all jobs in parallel to avoid sequential timeout
    const results = await Promise.all(
      jobs.map(async (job, i) => {
        let result: unknown;
        for (let attempt = 0; attempt < 80; attempt++) {
          await Bun.sleep(150);
          result = manager.getResult(job.id);
          if (result !== undefined) break;
        }
        return { result, expected: { processed: true, value: (i + 1) * 2 } };
      })
    );

    for (const { result, expected } of results) {
      expect(result).toEqual(expected);
    }

    await worker.stop();
  }, 15000);

  test('should handle worker timeout', async () => {
    // Create a slow processor
    const slowProcessorPath = `${Bun.env.TMPDIR ?? '/tmp'}/slow-processor-${Date.now()}.ts`;
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
    const errorProcessorPath = `${Bun.env.TMPDIR ?? '/tmp'}/error-processor-${Date.now()}.ts`;
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

  // ============ Event Emission Tests ============

  test('should emit ready event on start', async () => {
    let readyEmitted = false;
    const worker = new SandboxedWorker('sandboxed-ready-event', {
      processor: processorPath,
      concurrency: 1,
      manager,
    });

    worker.on('ready', () => {
      readyEmitted = true;
    });

    await worker.start();
    expect(readyEmitted).toBe(true);

    await worker.stop();
  });

  test('should emit closed event on stop', async () => {
    let closedEmitted = false;
    const worker = new SandboxedWorker('sandboxed-closed-event', {
      processor: processorPath,
      concurrency: 1,
      manager,
    });

    worker.on('closed', () => {
      closedEmitted = true;
    });

    await worker.start();
    await worker.stop();
    expect(closedEmitted).toBe(true);
  });

  test('should emit active and completed events', async () => {
    const queueName = `sandboxed-events-test-${Date.now()}`;
    const activeJobs: string[] = [];
    const completedJobs: { id: string; result: unknown }[] = [];

    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    worker.on('active', (job) => {
      activeJobs.push(String(job.id));
    });

    worker.on('completed', (job, result) => {
      completedJobs.push({ id: String(job.id), result });
    });

    await worker.start();

    const job = await manager.push(queueName, { data: { value: 10 } });

    // Wait for completion
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100);
      if (completedJobs.length > 0) break;
    }

    expect(activeJobs.length).toBe(1);
    expect(activeJobs[0]).toBe(String(job.id));
    expect(completedJobs.length).toBe(1);
    expect(completedJobs[0].id).toBe(String(job.id));
    expect(completedJobs[0].result).toEqual({ processed: true, value: 20 });

    await worker.stop();
  });

  test('should emit failed event on processor error', async () => {
    const errorProcessorPath2 = `${Bun.env.TMPDIR ?? '/tmp'}/error-processor-events-${Date.now()}.ts`;
    await Bun.write(
      errorProcessorPath2,
      `
      export default async (job: any) => {
        throw new Error('Event test error');
      };
    `
    );

    const queueName = `sandboxed-failed-event-${Date.now()}`;
    const failedJobs: { id: string; error: string }[] = [];

    const worker = new SandboxedWorker(queueName, {
      processor: errorProcessorPath2,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    worker.on('failed', (job, error) => {
      failedJobs.push({ id: String(job.id), error: error.message });
    });

    await worker.start();

    const job = await manager.push(queueName, { data: { test: true } });

    // Wait for failure
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100);
      if (failedJobs.length > 0) break;
    }

    expect(failedJobs.length).toBe(1);
    expect(failedJobs[0].id).toBe(String(job.id));
    expect(failedJobs[0].error).toContain('Event test error');

    await worker.stop();

    try {
      await unlink(errorProcessorPath2);
    } catch {
      // Ignore
    }
  });

  test('should emit progress event', async () => {
    const queueName = `sandboxed-progress-event-${Date.now()}`;
    const progressUpdates: number[] = [];

    const worker = new SandboxedWorker(queueName, {
      processor: processorPath,
      concurrency: 1,
      timeout: 5000,
      manager,
    });

    worker.on('progress', (_job, progress) => {
      progressUpdates.push(progress);
    });

    await worker.start();

    await manager.push(queueName, { data: { value: 5 } });

    // Wait for completion (processor calls progress(50) then progress(100))
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100);
      if (progressUpdates.length >= 2) break;
    }

    expect(progressUpdates).toContain(50);
    expect(progressUpdates).toContain(100);

    await worker.stop();
  });

  // ============ TCP Mode Tests ============

  test('should create sandboxed worker with TCP connection options', async () => {
    const worker = new SandboxedWorker('sandboxed-tcp-test', {
      processor: processorPath,
      connection: { host: 'localhost', port: 16789 },
    });

    expect(worker).toBeDefined();
    const stats = worker.getStats();
    expect(stats.total).toBe(0);

    // Cleanup the TCP pool reference
    await worker.stop();
  });

  test('should accept custom heartbeat interval for TCP mode', async () => {
    const worker = new SandboxedWorker('sandboxed-tcp-hb-test', {
      processor: processorPath,
      connection: { host: 'localhost', port: 16789 },
      heartbeatInterval: 5000,
    });

    expect(worker).toBeDefined();
    await worker.stop();
  });

  test('should emit failed event on timeout', async () => {
    const slowProcessorPath2 = `${Bun.env.TMPDIR ?? '/tmp'}/slow-processor-events-${Date.now()}.ts`;
    await Bun.write(
      slowProcessorPath2,
      `
      export default async (job: any) => {
        await Bun.sleep(10000);
        return { done: true };
      };
    `
    );

    const queueName = `sandboxed-timeout-event-${Date.now()}`;
    const failedJobs: { id: string; error: string }[] = [];

    const worker = new SandboxedWorker(queueName, {
      processor: slowProcessorPath2,
      concurrency: 1,
      timeout: 100,
      manager,
    });

    worker.on('failed', (job, error) => {
      failedJobs.push({ id: String(job.id), error: error.message });
    });

    await worker.start();

    await manager.push(queueName, { data: { test: true } });

    // Wait for timeout
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(100);
      if (failedJobs.length > 0) break;
    }

    expect(failedJobs.length).toBe(1);
    expect(failedJobs[0].error).toContain('timed out');

    await worker.stop();

    try {
      await unlink(slowProcessorPath2);
    } catch {
      // Ignore
    }
  });
});
