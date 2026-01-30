/**
 * TCP Stability Tests - bunqueue
 * Extensive tests for TCP client resilience and stability
 *
 * Prerequisites: bunqueue server running on localhost:6789
 * Run: bun run demo/tcp-stability-test.ts
 */

import { Queue, Worker } from '../src/client';

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

const PREFIX = `stability-${Date.now()}-`;

function test(name: string, success: boolean, details?: string) {
  if (success) {
    console.log(`  ${green('✓')} ${name}`);
    passed++;
  } else {
    console.log(`  ${red('✗')} ${name}${details ? ` - ${details}` : ''}`);
    failed++;
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ STABILITY TESTS ============

async function testHighVolumeJobs() {
  console.log(cyan('\n🚀 1. High Volume Job Processing'));

  const queueName = `${PREFIX}high-volume`;
  const queue = new Queue<{ index: number }>(queueName);
  const processed: number[] = [];
  const JOB_COUNT = 100;

  const worker = new Worker<{ index: number }>(
    queueName,
    async (job) => {
      processed.push(job.data.index);
      return { done: true };
    },
    { concurrency: 10 }
  );

  await sleep(200);

  console.log(dim(`    Adding ${JOB_COUNT} jobs...`));
  const startTime = Date.now();

  // Add jobs in bulk
  const jobs = Array.from({ length: JOB_COUNT }, (_, i) => ({
    name: 'task',
    data: { index: i },
  }));
  await queue.addBulk(jobs);

  const addTime = Date.now() - startTime;
  console.log(dim(`    Jobs added in ${addTime}ms`));

  // Wait for processing
  const maxWait = 30000;
  const waitStart = Date.now();
  while (processed.length < JOB_COUNT && Date.now() - waitStart < maxWait) {
    await sleep(100);
  }

  const processTime = Date.now() - startTime;
  const throughput = Math.round((processed.length / processTime) * 1000);

  test(`All ${JOB_COUNT} jobs processed`, processed.length === JOB_COUNT, `got ${processed.length}`);
  test(`Throughput > 50 jobs/sec`, throughput > 50, `${throughput} jobs/sec`);
  console.log(dim(`    Total time: ${processTime}ms, Throughput: ${throughput} jobs/sec`));

  await worker.close();
  await queue.close();
}

async function testRapidFireJobs() {
  console.log(cyan('\n⚡ 2. Rapid Fire Job Submission'));

  const queueName = `${PREFIX}rapid-fire`;
  const queue = new Queue<{ seq: number }>(queueName);
  const results: number[] = [];
  const JOB_COUNT = 50;

  const worker = new Worker<{ seq: number }>(
    queueName,
    async (job) => {
      results.push(job.data.seq);
      return {};
    },
    { concurrency: 5 }
  );

  await sleep(200);

  console.log(dim(`    Firing ${JOB_COUNT} jobs rapidly...`));

  // Fire jobs as fast as possible without awaiting each one
  const promises: Promise<unknown>[] = [];
  for (let i = 0; i < JOB_COUNT; i++) {
    promises.push(queue.add('rapid', { seq: i }));
  }
  await Promise.all(promises);

  await sleep(3000);

  test('All rapid-fire jobs processed', results.length === JOB_COUNT, `got ${results.length}`);

  await worker.close();
  await queue.close();
}

async function testConcurrentQueues() {
  console.log(cyan('\n🔀 3. Multiple Concurrent Queues'));

  const QUEUE_COUNT = 5;
  const JOBS_PER_QUEUE = 20;
  const queues: Queue<{ queueIndex: number; jobIndex: number }>[] = [];
  const workers: Worker<{ queueIndex: number; jobIndex: number }>[] = [];
  const results: Map<number, number[]> = new Map();

  // Create multiple queues and workers
  for (let q = 0; q < QUEUE_COUNT; q++) {
    const queueName = `${PREFIX}concurrent-${q}`;
    results.set(q, []);

    const queue = new Queue<{ queueIndex: number; jobIndex: number }>(queueName);
    queues.push(queue);

    const worker = new Worker<{ queueIndex: number; jobIndex: number }>(
      queueName,
      async (job) => {
        results.get(job.data.queueIndex)?.push(job.data.jobIndex);
        return {};
      },
      { concurrency: 3 }
    );
    workers.push(worker);
  }

  await sleep(300);

  console.log(dim(`    Adding ${JOBS_PER_QUEUE} jobs to each of ${QUEUE_COUNT} queues...`));

  // Add jobs to all queues concurrently
  const addPromises: Promise<unknown>[] = [];
  for (let q = 0; q < QUEUE_COUNT; q++) {
    for (let j = 0; j < JOBS_PER_QUEUE; j++) {
      addPromises.push(queues[q].add('task', { queueIndex: q, jobIndex: j }));
    }
  }
  await Promise.all(addPromises);

  await sleep(5000);

  // Check results
  let allProcessed = true;
  for (let q = 0; q < QUEUE_COUNT; q++) {
    const queueResults = results.get(q) || [];
    if (queueResults.length !== JOBS_PER_QUEUE) {
      allProcessed = false;
      console.log(dim(`    Queue ${q}: ${queueResults.length}/${JOBS_PER_QUEUE}`));
    }
  }

  const totalProcessed = Array.from(results.values()).reduce((sum, arr) => sum + arr.length, 0);
  test(
    'All queues processed their jobs',
    allProcessed,
    `${totalProcessed}/${QUEUE_COUNT * JOBS_PER_QUEUE}`
  );

  // Cleanup
  for (const worker of workers) await worker.close();
  for (const queue of queues) await queue.close();
}

async function testWorkerResilience() {
  console.log(cyan('\n💪 4. Worker Resilience (Error Recovery)'));

  const queueName = `${PREFIX}resilience`;
  const queue = new Queue<{ shouldFail: boolean; id: number }>(queueName);
  const processed: number[] = [];
  const failedJobs: number[] = [];
  let errorCount = 0;

  const worker = new Worker<{ shouldFail: boolean; id: number }>(
    queueName,
    async (job) => {
      if (job.data.shouldFail) {
        throw new Error(`Intentional failure for job ${job.data.id}`);
      }
      processed.push(job.data.id);
      return { success: true };
    },
    { concurrency: 2 }
  );

  worker.on('failed', (job) => {
    failedJobs.push(job.data.id);
    errorCount++;
  });

  await sleep(200);

  // Mix of successful and failing jobs
  await queue.add('task', { shouldFail: false, id: 1 });
  await queue.add('task', { shouldFail: true, id: 2 }, { attempts: 1 });
  await queue.add('task', { shouldFail: false, id: 3 });
  await queue.add('task', { shouldFail: true, id: 4 }, { attempts: 1 });
  await queue.add('task', { shouldFail: false, id: 5 });

  await sleep(2000);

  test('Successful jobs processed', processed.length === 3, `processed: ${processed.join(', ')}`);
  test('Failed jobs detected', failedJobs.length === 2, `failed: ${failedJobs.join(', ')}`);
  test('Worker continues after errors', processed.includes(5));

  await worker.close();
  await queue.close();
}

async function testLongRunningJobs() {
  console.log(cyan('\n⏱️  5. Long Running Jobs'));

  const queueName = `${PREFIX}long-running`;
  const queue = new Queue<{ duration: number; id: number }>(queueName);
  const completed: number[] = [];
  const progressUpdates: Map<number, number[]> = new Map();

  const worker = new Worker<{ duration: number; id: number }>(
    queueName,
    async (job) => {
      const steps = 5;
      const stepDuration = job.data.duration / steps;
      progressUpdates.set(job.data.id, []);

      for (let i = 1; i <= steps; i++) {
        await sleep(stepDuration);
        const progress = (i / steps) * 100;
        await job.updateProgress(progress, `Step ${i}/${steps}`);
        progressUpdates.get(job.data.id)?.push(progress);
      }

      completed.push(job.data.id);
      return { completed: true };
    },
    { concurrency: 2 }
  );

  await sleep(200);

  // Add long-running jobs
  await queue.add('long', { duration: 1000, id: 1 });
  await queue.add('long', { duration: 1500, id: 2 });
  await queue.add('long', { duration: 800, id: 3 });

  await sleep(5000);

  test('All long-running jobs completed', completed.length === 3, `completed: ${completed.length}`);

  // Check progress updates
  let allProgressCorrect = true;
  for (const [id, updates] of progressUpdates) {
    if (updates.length !== 5 || updates[4] !== 100) {
      allProgressCorrect = false;
      console.log(dim(`    Job ${id} progress: ${updates.join(', ')}`));
    }
  }
  test('Progress updates recorded', allProgressCorrect);

  await worker.close();
  await queue.close();
}

async function testPriorityUnderLoad() {
  console.log(cyan('\n🎯 6. Priority Handling Under Load'));

  const queueName = `${PREFIX}priority-load`;
  const queue = new Queue<{ priority: string; index: number }>(queueName);
  const order: string[] = [];

  // Add jobs BEFORE starting worker
  console.log(dim('    Adding jobs with different priorities...'));

  // Add low priority jobs first
  for (let i = 0; i < 5; i++) {
    await queue.add('low', { priority: 'low', index: i }, { priority: 1 });
  }

  // Add medium priority
  for (let i = 0; i < 5; i++) {
    await queue.add('medium', { priority: 'medium', index: i }, { priority: 5 });
  }

  // Add high priority last
  for (let i = 0; i < 5; i++) {
    await queue.add('high', { priority: 'high', index: i }, { priority: 10 });
  }

  // Now start worker
  const worker = new Worker<{ priority: string; index: number }>(
    queueName,
    async (job) => {
      order.push(job.data.priority);
      await sleep(50); // Small delay to ensure order is maintained
      return {};
    },
    { concurrency: 1 }
  );

  await sleep(5000);

  // Check that high priority jobs came first
  const firstFive = order.slice(0, 5);
  const highPriorityFirst = firstFive.filter((p) => p === 'high').length;

  test('High priority jobs processed first', highPriorityFirst >= 4, `first 5: ${firstFive.join(', ')}`);
  test('All priority jobs completed', order.length === 15, `processed: ${order.length}`);

  await worker.close();
  await queue.close();
}

async function testMemoryStability() {
  console.log(cyan('\n🧠 7. Memory Stability (Leak Detection)'));

  const queueName = `${PREFIX}memory`;
  const queue = new Queue<{ payload: string }>(queueName);
  let processedCount = 0;

  const worker = new Worker<{ payload: string }>(
    queueName,
    async () => {
      processedCount++;
      return {};
    },
    { concurrency: 5 }
  );

  await sleep(200);

  // Get initial memory
  const initialMemory = process.memoryUsage().heapUsed;
  console.log(dim(`    Initial heap: ${Math.round(initialMemory / 1024 / 1024)}MB`));

  // Process many jobs with substantial payloads
  const BATCH_COUNT = 10;
  const JOBS_PER_BATCH = 50;
  const payload = 'x'.repeat(1000); // 1KB payload

  for (let batch = 0; batch < BATCH_COUNT; batch++) {
    const jobs = Array.from({ length: JOBS_PER_BATCH }, () => ({
      name: 'task',
      data: { payload },
    }));
    await queue.addBulk(jobs);
    await sleep(500);
  }

  // Wait for processing
  await sleep(3000);

  // Force GC if available
  if (global.gc) {
    global.gc();
  }

  const finalMemory = process.memoryUsage().heapUsed;
  const memoryGrowth = finalMemory - initialMemory;
  const growthMB = Math.round(memoryGrowth / 1024 / 1024);

  console.log(dim(`    Final heap: ${Math.round(finalMemory / 1024 / 1024)}MB`));
  console.log(dim(`    Growth: ${growthMB}MB`));

  test('All jobs processed', processedCount === BATCH_COUNT * JOBS_PER_BATCH, `processed: ${processedCount}`);
  test('Memory growth acceptable (<50MB)', growthMB < 50, `grew ${growthMB}MB`);

  await worker.close();
  await queue.close();
}

async function testConnectionStability() {
  console.log(cyan('\n🔌 8. Connection Stability'));

  const queueName = `${PREFIX}connection`;
  const queue = new Queue<{ test: number }>(queueName);
  const results: number[] = [];

  const worker = new Worker<{ test: number }>(
    queueName,
    async (job) => {
      results.push(job.data.test);
      return {};
    }
  );

  await sleep(200);

  // Perform many operations in sequence
  console.log(dim('    Performing 100 sequential operations...'));
  for (let i = 0; i < 100; i++) {
    await queue.add('task', { test: i });
    if (i % 20 === 0) {
      await queue.getJobCountsAsync();
    }
  }

  await sleep(3000);

  test('All sequential operations succeeded', results.length === 100, `got ${results.length}`);

  // Test connection under concurrent load
  console.log(dim('    Testing concurrent operations...'));
  const concurrentOps: Promise<unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    concurrentOps.push(queue.add('concurrent', { test: 100 + i }));
    concurrentOps.push(queue.getJobCountsAsync());
  }

  const concurrentResults = await Promise.allSettled(concurrentOps);
  const concurrentSuccesses = concurrentResults.filter((r) => r.status === 'fulfilled').length;

  test('Concurrent operations stable', concurrentSuccesses === 100, `${concurrentSuccesses}/100 succeeded`);

  await worker.close();
  await queue.close();
}

async function testGracefulShutdown() {
  console.log(cyan('\n🛑 9. Graceful Shutdown'));

  const queueName = `${PREFIX}shutdown`;
  const queue = new Queue<{ id: number }>(queueName);
  const processing: number[] = [];
  const completed: number[] = [];

  const worker = new Worker<{ id: number }>(
    queueName,
    async (job) => {
      processing.push(job.data.id);
      await sleep(500); // Simulate work
      completed.push(job.data.id);
      return {};
    },
    { concurrency: 3 }
  );

  await sleep(200);

  // Add jobs
  for (let i = 0; i < 6; i++) {
    await queue.add('task', { id: i });
  }

  // Wait for some to start processing
  await sleep(300);

  const processingAtShutdown = processing.length;
  console.log(dim(`    Jobs started before shutdown: ${processingAtShutdown}`));

  // Initiate graceful shutdown (should wait for active jobs)
  const shutdownStart = Date.now();
  await worker.close(false); // false = graceful
  const shutdownTime = Date.now() - shutdownStart;

  console.log(dim(`    Shutdown took: ${shutdownTime}ms`));

  test('Active jobs completed on shutdown', completed.length >= processingAtShutdown,
    `completed: ${completed.length}, started: ${processingAtShutdown}`);
  test('Graceful shutdown waited for jobs', shutdownTime >= 200);

  await queue.close();
}

async function testEventConsistency() {
  console.log(cyan('\n📡 10. Event Consistency'));

  const queueName = `${PREFIX}events`;
  const queue = new Queue<{ value: number }>(queueName);

  const events = {
    active: 0,
    completed: 0,
    failed: 0,
    progress: 0,
  };

  const worker = new Worker<{ value: number }>(
    queueName,
    async (job) => {
      await job.updateProgress(50);
      await job.updateProgress(100);
      if (job.data.value < 0) {
        throw new Error('Negative value');
      }
      return { doubled: job.data.value * 2 };
    }
  );

  worker.on('active', () => events.active++);
  worker.on('completed', () => events.completed++);
  worker.on('failed', () => events.failed++);
  worker.on('progress', () => events.progress++);

  await sleep(200);

  // Add mix of jobs
  await queue.add('task', { value: 1 });
  await queue.add('task', { value: 2 });
  await queue.add('task', { value: -1 }, { attempts: 1 }); // Will fail
  await queue.add('task', { value: 3 });
  await queue.add('task', { value: 4 });

  await sleep(2000);

  test('Active events match job count', events.active === 5, `active: ${events.active}`);
  test('Completed events correct', events.completed === 4, `completed: ${events.completed}`);
  test('Failed events correct', events.failed === 1, `failed: ${events.failed}`);
  test('Progress events fired', events.progress >= 8, `progress: ${events.progress}`);

  await worker.close();
  await queue.close();
}

async function testDelayedJobsUnderLoad() {
  console.log(cyan('\n⏰ 11. Delayed Jobs Under Load'));

  const queueName = `${PREFIX}delayed-load`;
  const queue = new Queue<{ delay: number; id: number }>(queueName);
  const processedTimes: Map<number, number> = new Map();
  const startTime = Date.now();

  const worker = new Worker<{ delay: number; id: number }>(
    queueName,
    async (job) => {
      processedTimes.set(job.data.id, Date.now() - startTime);
      return {};
    },
    { concurrency: 3 }
  );

  await sleep(200);

  // Add jobs with various delays
  await queue.add('delayed', { delay: 500, id: 1 }, { delay: 500 });
  await queue.add('delayed', { delay: 1000, id: 2 }, { delay: 1000 });
  await queue.add('delayed', { delay: 200, id: 3 }, { delay: 200 });
  await queue.add('immediate', { delay: 0, id: 4 });
  await queue.add('delayed', { delay: 800, id: 5 }, { delay: 800 });

  await sleep(3000);

  // Check order respects delays
  test('All delayed jobs processed', processedTimes.size === 5, `processed: ${processedTimes.size}`);

  const times = Array.from(processedTimes.entries()).sort((a, b) => a[1] - b[1]);
  console.log(dim(`    Processing order: ${times.map(([id, t]) => `${id}@${t}ms`).join(', ')}`));

  // Immediate job should be first or very early
  const immediateTime = processedTimes.get(4) || Infinity;
  test('Immediate job processed quickly', immediateTime < 500, `immediate at ${immediateTime}ms`);

  await worker.close();
  await queue.close();
}

async function testBulkOperations() {
  console.log(cyan('\n📦 12. Bulk Operations Stress Test'));

  const queueName = `${PREFIX}bulk`;
  const queue = new Queue<{ batch: number; index: number }>(queueName);
  let processedCount = 0;

  const worker = new Worker<{ batch: number; index: number }>(
    queueName,
    async () => {
      processedCount++;
      return {};
    },
    { concurrency: 10 }
  );

  await sleep(200);

  const BATCH_SIZE = 100;
  const BATCH_COUNT = 5;

  console.log(dim(`    Adding ${BATCH_COUNT} batches of ${BATCH_SIZE} jobs...`));

  const batchTimes: number[] = [];
  for (let batch = 0; batch < BATCH_COUNT; batch++) {
    const jobs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      name: 'bulk-task',
      data: { batch, index: i },
    }));

    const start = Date.now();
    await queue.addBulk(jobs);
    batchTimes.push(Date.now() - start);
  }

  const avgBatchTime = Math.round(batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length);
  console.log(dim(`    Avg batch add time: ${avgBatchTime}ms`));

  await sleep(5000);

  const totalJobs = BATCH_SIZE * BATCH_COUNT;
  test('All bulk jobs processed', processedCount === totalJobs, `${processedCount}/${totalJobs}`);
  test('Batch add performance acceptable', avgBatchTime < 500, `avg: ${avgBatchTime}ms`);

  await worker.close();
  await queue.close();
}

// ============ MAIN ============

async function main() {
  console.log(yellow('\n🔬 bunqueue TCP Stability Tests\n'));
  console.log('Connecting to server on localhost:6789...');
  console.log(`Using prefix: ${PREFIX}\n`);

  try {
    await testHighVolumeJobs();
    await testRapidFireJobs();
    await testConcurrentQueues();
    await testWorkerResilience();
    await testLongRunningJobs();
    await testPriorityUnderLoad();
    await testMemoryStability();
    await testConnectionStability();
    await testGracefulShutdown();
    await testEventConsistency();
    await testDelayedJobsUnderLoad();
    await testBulkOperations();

    // Summary
    console.log(yellow('\n═══════════════════════════════════════'));
    console.log(yellow('           STABILITY TEST SUMMARY       '));
    console.log(yellow('═══════════════════════════════════════\n'));
    console.log(`  ${green('Passed:')} ${passed}`);
    console.log(`  ${red('Failed:')} ${failed}`);
    console.log(`  ${cyan('Total:')}  ${passed + failed}\n`);

    if (failed === 0) {
      console.log(green('  ✨ All stability tests passed!\n'));
    } else {
      console.log(red(`  ⚠️  ${failed} test(s) failed\n`));
    }
  } catch (error) {
    console.error(red('\n❌ Stability test suite failed:'), error);
    process.exit(1);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
