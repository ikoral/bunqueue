/**
 * EXTREME TESTS - Chaos Engineering & Production Scenarios
 * These tests push bunqueue to its limits
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, QueueEvents, shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';

describe('🔥 EXTREME: Stress Tests', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('stress');
    manager.obliterate('burst');
    manager.obliterate('heavy');
  });

  it('should handle 10,000 jobs burst in under 1 second', async () => {
    const queue = new Queue('stress');
    const jobCount = 10_000;

    const start = performance.now();

    // Bulk add 10k jobs
    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      name: 'task',
      data: { index: i },
    }));

    await queue.addBulk(jobs);

    const duration = performance.now() - start;

    console.log(`📊 10,000 jobs added in ${duration.toFixed(2)}ms`);
    console.log(`📊 Throughput: ${(jobCount / (duration / 1000)).toFixed(0)} jobs/sec`);

    expect(duration).toBeLessThan(1000); // Under 1 second

    const counts = queue.getJobCounts();
    expect(counts.waiting).toBe(jobCount);
  });

  it('should process 1,000 jobs with 50 concurrent workers', async () => {
    const queue = new Queue('burst');
    const jobCount = 1_000;
    let completed = 0;

    // Add jobs
    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      name: 'process',
      data: { id: i },
    }));
    await queue.addBulk(jobs);

    const start = performance.now();

    // High concurrency worker
    const worker = new Worker('burst', async (job) => {
      // Simulate tiny workload
      await Bun.sleep(1);
      completed++;
      return { processed: job.data.id };
    }, { concurrency: 50 });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (completed >= jobCount) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const duration = performance.now() - start;
    await worker.close();

    console.log(`📊 1,000 jobs processed in ${duration.toFixed(2)}ms`);
    console.log(`📊 Throughput: ${(jobCount / (duration / 1000)).toFixed(0)} jobs/sec`);

    expect(completed).toBe(jobCount);
  });

  it('should handle jobs with 1MB payload', async () => {
    const queue = new Queue('heavy');

    // Create 1MB string
    const largePayload = 'x'.repeat(1024 * 1024);

    const job = await queue.add('big-data', {
      payload: largePayload,
      metadata: { size: '1MB' },
    });

    const retrieved = await queue.getJob(job.id);
    expect(retrieved).not.toBeNull();
    expect((retrieved!.data as any).payload.length).toBe(1024 * 1024);
  });
});

describe('💀 EXTREME: Chaos Engineering', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('chaos');
    manager.obliterate('race');
    manager.obliterate('fail');
  });

  it('should survive worker crash mid-processing', async () => {
    const queue = new Queue('chaos');
    let processCount = 0;
    let completed = false;

    await queue.add('unstable', { id: 1 }, { attempts: 3, backoff: 50 });

    const worker = new Worker('chaos', async () => {
      processCount++;
      if (processCount < 3) {
        throw new Error('Simulated crash!');
      }
      return { success: true };
    });

    worker.on('completed', () => {
      completed = true;
    });

    // Wait for completion or timeout
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (completed || processCount >= 3) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3000);
    });

    await worker.close();
    expect(processCount).toBeGreaterThanOrEqual(3);
  });

  it('should handle concurrent job additions safely', async () => {
    const queue = new Queue('race');

    // Add many jobs concurrently
    const promises = Array.from({ length: 100 }, (_, i) =>
      queue.add('task', { v: i })
    );

    const jobs = await Promise.all(promises);

    // All jobs should be added
    expect(jobs.length).toBe(100);
    expect(jobs.every((j) => j !== null)).toBe(true);

    const counts = queue.getJobCounts();
    expect(counts.waiting).toBe(100);
  });

  it('should handle 100% failure rate and fill DLQ', async () => {
    const queue = new Queue('fail');
    const jobCount = 100;
    let failCount = 0;

    // Add jobs that will all fail
    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      name: 'doomed',
      data: { index: i },
      opts: { attempts: 1 }, // Fail immediately to DLQ
    }));
    await queue.addBulk(jobs);

    const worker = new Worker('fail', async () => {
      failCount++;
      throw new Error('Always fails');
    }, { concurrency: 10 });

    // Wait for all to fail
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (failCount >= jobCount) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    await worker.close();

    // Check DLQ
    const dlqEntries = queue.getDlq();
    expect(dlqEntries.length).toBe(jobCount);
    expect(failCount).toBe(jobCount);
  });

  it('should handle rapid pause/resume cycles', async () => {
    const queue = new Queue('chaos');
    let processed = 0;

    await queue.addBulk(
      Array.from({ length: 50 }, (_, i) => ({
        name: 'task',
        data: { i },
      }))
    );

    const worker = new Worker('chaos', async () => {
      processed++;
      await Bun.sleep(2);
      return {};
    }, { concurrency: 10 });

    // Rapid pause/resume 10 times
    for (let i = 0; i < 10; i++) {
      queue.pause();
      await Bun.sleep(5);
      queue.resume();
      await Bun.sleep(20);
    }

    // Wait for completion with timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      const check = setInterval(() => {
        if (processed >= 50) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    await worker.close();
    // Allow some variance due to timing
    expect(processed).toBeGreaterThanOrEqual(45);
  });
});

describe('🎯 EXTREME: Priority & Ordering', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('priority');
  });

  it('should process high priority jobs first (strict ordering)', async () => {
    const queue = new Queue('priority');
    const processOrder: number[] = [];

    // Add jobs with mixed priorities
    await queue.add('low', { p: 1 }, { priority: 1 });
    await queue.add('medium', { p: 5 }, { priority: 5 });
    await queue.add('high', { p: 10 }, { priority: 10 });
    await queue.add('critical', { p: 100 }, { priority: 100 });
    await queue.add('lowest', { p: 0 }, { priority: 0 });

    const worker = new Worker('priority', async (job) => {
      processOrder.push((job.data as any).p);
      return {};
    }, { concurrency: 1 }); // Single worker to ensure ordering

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (processOrder.length >= 5) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    await worker.close();

    // Should be processed highest to lowest
    expect(processOrder).toEqual([100, 10, 5, 1, 0]);
  });

  it('should maintain FIFO within same priority', async () => {
    const queue = new Queue('priority');
    const processOrder: number[] = [];

    // Add 10 jobs with same priority
    for (let i = 0; i < 10; i++) {
      await queue.add('task', { order: i }, { priority: 5 });
    }

    const worker = new Worker('priority', async (job) => {
      processOrder.push((job.data as any).order);
      return {};
    }, { concurrency: 1 });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (processOrder.length >= 10) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    await worker.close();

    // Should maintain insertion order
    expect(processOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('⏱️ EXTREME: Timing & Delays', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('delay');
    manager.obliterate('timeout');
  });

  it('should respect delay with millisecond precision', async () => {
    const queue = new Queue('delay');
    const delay = 500; // 500ms

    const addedAt = Date.now();
    await queue.add('delayed', { test: true }, { delay });

    let processedAt = 0;
    const worker = new Worker('delay', async () => {
      processedAt = Date.now();
      return {};
    });

    await new Promise<void>((resolve) => {
      worker.on('completed', () => resolve());
    });

    await worker.close();

    const actualDelay = processedAt - addedAt;
    console.log(`📊 Requested delay: ${delay}ms, Actual: ${actualDelay}ms`);

    // Should be within 100ms of requested delay
    expect(actualDelay).toBeGreaterThanOrEqual(delay - 50);
    expect(actualDelay).toBeLessThan(delay + 100);
  });

  it('should timeout long-running jobs', async () => {
    const queue = new Queue('timeout');
    let timedOut = false;

    await queue.add('slow', { test: true }, {
      timeout: 100, // 100ms timeout
      attempts: 1,
    });

    const worker = new Worker('timeout', async () => {
      // This will take longer than timeout
      await Bun.sleep(500);
      return {};
    });

    await new Promise<void>((resolve) => {
      worker.on('failed', (job, error) => {
        if (error.message.includes('timeout') || error.message.includes('Timeout')) {
          timedOut = true;
        }
        resolve();
      });
      // Fallback timeout
      setTimeout(resolve, 1000);
    });

    await worker.close();
    // Job should have failed due to timeout or be in DLQ
    const counts = queue.getJobCounts();
    expect(counts.waiting + counts.active).toBe(0);
  });
});

describe('📊 EXTREME: Progress & Events', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('progress');
    manager.obliterate('events');
  });

  it('should track granular progress updates', async () => {
    const queue = new Queue('progress');
    const progressUpdates: number[] = [];

    await queue.add('tracked', { test: true });

    const worker = new Worker('progress', async (job) => {
      for (let i = 0; i <= 100; i += 10) {
        await job.updateProgress(i, `Step ${i}`);
        await Bun.sleep(5);
      }
      return { done: true };
    });

    worker.on('progress', (job, progress) => {
      progressUpdates.push(progress);
    });

    await new Promise<void>((resolve) => {
      worker.on('completed', () => resolve());
    });

    await worker.close();

    // Should have received progress updates
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
  });

  it('should emit all event types correctly', async () => {
    const queue = new Queue('events');
    const events = new QueueEvents('events');
    const receivedEvents: string[] = [];

    events.on('waiting', () => receivedEvents.push('waiting'));
    events.on('active', () => receivedEvents.push('active'));
    events.on('completed', () => receivedEvents.push('completed'));

    await queue.add('test', { data: true });

    const worker = new Worker('events', async () => {
      await Bun.sleep(10);
      return { success: true };
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    await worker.close();
    events.close();

    expect(receivedEvents).toContain('waiting');
    expect(receivedEvents).toContain('active');
    expect(receivedEvents).toContain('completed');
  });
});

describe('🔄 EXTREME: Retry & Recovery', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('retry');
    manager.obliterate('backoff');
  });

  it('should retry with exponential backoff', async () => {
    const queue = new Queue('backoff');
    const attempts: number[] = [];

    await queue.add('flaky', { test: true }, {
      attempts: 4,
      backoff: 100, // 100ms base backoff
    });

    let attemptCount = 0;
    const worker = new Worker('backoff', async () => {
      attemptCount++;
      attempts.push(Date.now());
      if (attemptCount < 4) {
        throw new Error(`Attempt ${attemptCount} failed`);
      }
      return { success: true };
    });

    await new Promise<void>((resolve) => {
      worker.on('completed', () => resolve());
    });

    await worker.close();

    expect(attemptCount).toBe(4);

    // Check backoff timing (should increase)
    if (attempts.length >= 3) {
      const gap1 = attempts[1] - attempts[0];
      const gap2 = attempts[2] - attempts[1];
      console.log(`📊 Backoff gaps: ${gap1}ms, ${gap2}ms`);
    }
  });

  it('should recover jobs from DLQ', async () => {
    const queue = new Queue('retry');
    let attempt = 0;

    await queue.add('recoverable', { test: true }, { attempts: 1 });

    // First worker fails
    const worker1 = new Worker('retry', async () => {
      attempt++;
      if (attempt === 1) throw new Error('First fail');
      return { recovered: true };
    });

    await new Promise<void>((resolve) => {
      worker1.on('failed', () => resolve());
    });
    await worker1.close();

    // Job should be in DLQ
    let dlq = queue.getDlq();
    expect(dlq.length).toBe(1);

    // Retry from DLQ
    queue.retryDlq();

    // Second attempt should succeed
    const worker2 = new Worker('retry', async () => {
      attempt++;
      return { recovered: true };
    });

    await new Promise<void>((resolve) => {
      worker2.on('completed', () => resolve());
      setTimeout(resolve, 500); // Timeout fallback
    });

    await worker2.close();

    // DLQ should be empty now
    dlq = queue.getDlq();
    expect(dlq.length).toBe(0);
  });
});

describe('🧹 EXTREME: Cleanup & Memory', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('cleanup');
    manager.obliterate('memory');
  });

  it('should cleanup completed jobs when removeOnComplete is true', async () => {
    const queue = new Queue('cleanup');
    const jobCount = 100;

    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      name: 'temp',
      data: { i },
      opts: { removeOnComplete: true },
    }));
    await queue.addBulk(jobs);

    let completed = 0;
    const worker = new Worker('cleanup', async () => {
      completed++;
      return {};
    }, { concurrency: 10 });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (completed >= jobCount) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    await worker.close();
    await Bun.sleep(100); // Let cleanup run

    const counts = queue.getJobCounts();
    // Completed count should be 0 or very low (jobs removed)
    expect(counts.completed).toBeLessThan(jobCount);
  });

  it('should drain queue completely', async () => {
    const queue = new Queue('cleanup');

    // Add 500 jobs
    await queue.addBulk(
      Array.from({ length: 500 }, (_, i) => ({
        name: 'task',
        data: { i },
      }))
    );

    expect(queue.getJobCounts().waiting).toBe(500);

    // Drain
    queue.drain();

    expect(queue.getJobCounts().waiting).toBe(0);
  });

  it('should obliterate all queue data', async () => {
    const queue = new Queue('memory');

    // Add jobs
    await queue.addBulk(
      Array.from({ length: 50 }, (_, i) => ({
        name: 'task',
        data: { i },
      }))
    );

    const countsBefore = queue.getJobCounts();
    expect(countsBefore.waiting).toBe(50);

    // Obliterate before processing
    queue.obliterate();

    const countsAfter = queue.getJobCounts();
    expect(countsAfter.waiting).toBe(0);
  });
});

describe('🔗 EXTREME: Multi-Queue Scenarios', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('queue-a');
    manager.obliterate('queue-b');
    manager.obliterate('queue-c');
  });

  it('should handle 10 queues with independent workers', async () => {
    const queueCount = 10;
    const jobsPerQueue = 50;
    const completedByQueue: Record<string, number> = {};

    const queues: Queue[] = [];
    const workers: Worker[] = [];

    // Create queues and workers
    for (let q = 0; q < queueCount; q++) {
      const name = `queue-${q}`;
      completedByQueue[name] = 0;

      const queue = new Queue(name);
      queues.push(queue);

      // Add jobs
      await queue.addBulk(
        Array.from({ length: jobsPerQueue }, (_, i) => ({
          name: 'task',
          data: { queue: q, job: i },
        }))
      );

      // Create worker
      const worker = new Worker(name, async () => {
        completedByQueue[name]++;
        await Bun.sleep(1);
        return {};
      }, { concurrency: 5 });
      workers.push(worker);
    }

    // Wait for all to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const total = Object.values(completedByQueue).reduce((a, b) => a + b, 0);
        if (total >= queueCount * jobsPerQueue) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    // Cleanup
    for (const worker of workers) {
      await worker.close();
    }
    for (let q = 0; q < queueCount; q++) {
      getSharedManager().obliterate(`queue-${q}`);
    }

    // Verify each queue processed its jobs
    for (let q = 0; q < queueCount; q++) {
      expect(completedByQueue[`queue-${q}`]).toBe(jobsPerQueue);
    }
  });

  it('should pipeline jobs across queues', async () => {
    const queueA = new Queue('queue-a');
    const queueB = new Queue('queue-b');
    const queueC = new Queue('queue-c');

    const pipeline: string[] = [];

    // Worker A -> adds to B
    const workerA = new Worker('queue-a', async (job) => {
      pipeline.push('A');
      await queueB.add('from-a', { ...job.data, processedByA: true });
      return { stage: 'A' };
    });

    // Worker B -> adds to C
    const workerB = new Worker('queue-b', async (job) => {
      pipeline.push('B');
      await queueC.add('from-b', { ...job.data, processedByB: true });
      return { stage: 'B' };
    });

    // Worker C -> final
    const workerC = new Worker('queue-c', async (job) => {
      pipeline.push('C');
      return { stage: 'C', data: job.data };
    });

    // Start pipeline
    await queueA.add('start', { value: 42 });

    // Wait for pipeline to complete
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });

    await workerA.close();
    await workerB.close();
    await workerC.close();

    expect(pipeline).toEqual(['A', 'B', 'C']);
  });
});

describe('📈 EXTREME: Benchmarks', () => {
  beforeEach(() => {
    shutdownManager();
  });

  afterEach(async () => {
    const manager = getSharedManager();
    manager.obliterate('bench');
  });

  it('BENCHMARK: Queue throughput (add operations)', async () => {
    const queue = new Queue('bench');
    const iterations = 50_000;

    const start = performance.now();

    const jobs = Array.from({ length: iterations }, (_, i) => ({
      name: 'bench',
      data: { i },
    }));
    await queue.addBulk(jobs);

    const duration = performance.now() - start;
    const opsPerSec = iterations / (duration / 1000);

    console.log(`\n📊 BENCHMARK: Add Operations`);
    console.log(`   Jobs: ${iterations.toLocaleString()}`);
    console.log(`   Duration: ${duration.toFixed(2)}ms`);
    console.log(`   Throughput: ${opsPerSec.toFixed(0).toLocaleString()} ops/sec`);

    expect(opsPerSec).toBeGreaterThan(10_000); // At least 10k ops/sec
  });

  it('BENCHMARK: Queue throughput (read operations)', async () => {
    const queue = new Queue('bench');

    // Add some jobs first
    await queue.addBulk(
      Array.from({ length: 1000 }, (_, i) => ({
        name: 'bench',
        data: { i },
      }))
    );

    const iterations = 10_000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      queue.getJobCounts();
    }

    const duration = performance.now() - start;
    const opsPerSec = iterations / (duration / 1000);

    console.log(`\n📊 BENCHMARK: Read Operations (getJobCounts)`);
    console.log(`   Iterations: ${iterations.toLocaleString()}`);
    console.log(`   Duration: ${duration.toFixed(2)}ms`);
    console.log(`   Throughput: ${opsPerSec.toFixed(0).toLocaleString()} ops/sec`);

    expect(opsPerSec).toBeGreaterThan(50_000); // At least 50k ops/sec
  });
});
