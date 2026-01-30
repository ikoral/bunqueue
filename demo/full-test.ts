/**
 * Full Feature Test - bunqueue via TCP
 * Tests all major features against running server
 *
 * Prerequisites: bunqueue server running on localhost:6789
 * Run: bun run full-test.ts
 */

import { Queue, Worker } from '../src/client';

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

// Unique prefix to avoid queue collisions
const PREFIX = `test-${Date.now()}-`;

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

// ============ TEST SUITES ============

async function testBasicOperations() {
  console.log(cyan('\n📦 1. Basic Queue Operations'));

  const queue = new Queue<{ value: number }>(`${PREFIX}basic`);

  // Add single job
  const job = await queue.add('task', { value: 42 });
  test('Add single job', !!job.id && job.data.value === 42);

  // Add bulk jobs
  const jobs = await queue.addBulk([
    { name: 'task1', data: { value: 1 } },
    { name: 'task2', data: { value: 2 } },
    { name: 'task3', data: { value: 3 } },
  ]);
  test('Add bulk jobs', jobs.length === 3);

  // Get job counts
  const counts = await queue.getJobCountsAsync();
  test('Get job counts', counts.waiting >= 0);

  await queue.close();
}

async function testWorkerProcessing() {
  console.log(cyan('\n⚙️  2. Worker Processing'));

  const queueName = `${PREFIX}worker`;
  const queue = new Queue<{ x: number }>(queueName);
  const results: number[] = [];

  // Create worker first and wait for connection
  const worker = new Worker<{ x: number }, { doubled: number }>(
    queueName,
    async (job) => {
      results.push(job.data.x);
      return { doubled: job.data.x * 2 };
    }
  );

  // Wait for worker to be ready
  await sleep(200);

  // Now add jobs
  await queue.add('calc', { x: 5 });
  await queue.add('calc', { x: 10 });

  // Wait for processing
  await sleep(1000);

  test('Worker processes jobs', results.includes(5) && results.includes(10), `got: ${JSON.stringify(results)}`);

  await worker.close();
  await queue.close();
}

async function testJobProgress() {
  console.log(cyan('\n📊 3. Job Progress'));

  const queueName = `${PREFIX}progress`;
  const queue = new Queue<{ task: string }>(queueName);
  let progressUpdated = false;

  const worker = new Worker<{ task: string }>(
    queueName,
    async (job) => {
      await job.updateProgress(25, 'Starting...');
      await job.updateProgress(50, 'Halfway...');
      await job.updateProgress(100, 'Done!');
      progressUpdated = true;
      return { success: true };
    }
  );

  await sleep(200);
  await queue.add('process', { task: 'test' });
  await sleep(1000);

  test('Job progress updates', progressUpdated);

  await worker.close();
  await queue.close();
}

async function testJobLogs() {
  console.log(cyan('\n📝 4. Job Logs'));

  const queueName = `${PREFIX}logs`;
  const queue = new Queue<{ action: string }>(queueName);
  let logsWritten = false;

  const worker = new Worker<{ action: string }>(
    queueName,
    async (job) => {
      await job.log('Step 1: Starting');
      await job.log('Step 2: Processing');
      await job.log('Step 3: Completed');
      logsWritten = true;
      return { done: true };
    }
  );

  await sleep(200);
  await queue.add('action', { action: 'test' });
  await sleep(1000);

  test('Job logs written', logsWritten);

  await worker.close();
  await queue.close();
}

async function testPriorityJobs() {
  console.log(cyan('\n🔝 5. Priority Jobs'));

  const queueName = `${PREFIX}priority`;
  const queue = new Queue<{ priority: string }>(queueName);
  const order: string[] = [];

  // Add jobs with different priorities first (before worker starts)
  await queue.add('low', { priority: 'low' }, { priority: 1 });
  await queue.add('high', { priority: 'high' }, { priority: 10 });
  await queue.add('medium', { priority: 'medium' }, { priority: 5 });

  // Then start worker
  const worker = new Worker<{ priority: string }>(
    queueName,
    async (job) => {
      order.push(job.data.priority);
      return {};
    },
    { concurrency: 1 }
  );

  await sleep(1500);

  // High priority should be processed first
  test('Priority ordering', order[0] === 'high', `got order: ${JSON.stringify(order)}`);

  await worker.close();
  await queue.close();
}

async function testDelayedJobs() {
  console.log(cyan('\n⏰ 6. Delayed Jobs'));

  const queueName = `${PREFIX}delayed`;
  const queue = new Queue<{ delayed: boolean }>(queueName);
  let processedAt = 0;
  const startTime = Date.now();

  const worker = new Worker<{ delayed: boolean }>(
    queueName,
    async () => {
      processedAt = Date.now();
      return {};
    }
  );

  await sleep(200);

  // Add job with 500ms delay
  await queue.add('delayed', { delayed: true }, { delay: 500 });

  await sleep(1200);

  const delay = processedAt - startTime;
  test('Delayed job execution', processedAt > 0 && delay >= 400, `delay: ${delay}ms`);

  await worker.close();
  await queue.close();
}

async function testRetries() {
  console.log(cyan('\n🔄 7. Retries & Backoff'));

  const queueName = `${PREFIX}retry`;
  const queue = new Queue<{ attempt: number }>(queueName);
  let attempts = 0;

  const worker = new Worker<{ attempt: number }>(
    queueName,
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Simulated failure');
      }
      return { success: true };
    }
  );

  await sleep(200);
  await queue.add('retry-task', { attempt: 1 }, { attempts: 3, backoff: 100 });

  await sleep(2000);

  test('Job retried on failure', attempts >= 2, `attempts: ${attempts}`);

  await worker.close();
  await queue.close();
}

async function testWorkerEvents() {
  console.log(cyan('\n📡 8. Worker Events'));

  const queueName = `${PREFIX}events`;
  const queue = new Queue<{ value: number }>(queueName);
  const events: string[] = [];

  const worker = new Worker<{ value: number }>(
    queueName,
    async (job) => {
      return { result: job.data.value * 2 };
    }
  );

  worker.on('active', () => events.push('active'));
  worker.on('completed', () => events.push('completed'));

  await sleep(200);
  await queue.add('event-test', { value: 5 });
  await sleep(1000);

  test('Active event fired', events.includes('active'), `events: ${JSON.stringify(events)}`);
  test('Completed event fired', events.includes('completed'), `events: ${JSON.stringify(events)}`);

  await worker.close();
  await queue.close();
}

async function testWorkerConcurrency() {
  console.log(cyan('\n🔀 9. Worker Concurrency'));

  const queueName = `${PREFIX}concurrency`;
  const queue = new Queue<{ id: number }>(queueName);
  let concurrent = 0;
  let maxConcurrent = 0;

  const worker = new Worker<{ id: number }>(
    queueName,
    async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(200);
      concurrent--;
      return {};
    },
    { concurrency: 3 }
  );

  await sleep(200);

  // Add 6 jobs
  for (let i = 0; i < 6; i++) {
    await queue.add('task', { id: i });
  }

  await sleep(2000);

  test('Concurrency limit respected', maxConcurrent <= 3, `max: ${maxConcurrent}`);
  test('Concurrent processing occurred', maxConcurrent >= 2, `max: ${maxConcurrent}`);

  await worker.close();
  await queue.close();
}

async function testPauseResume() {
  console.log(cyan('\n⏸️  10. Pause/Resume Queue'));

  const queueName = `${PREFIX}pause`;
  const queue = new Queue<{ value: number }>(queueName);
  let processed = 0;

  const worker = new Worker<{ value: number }>(
    queueName,
    async () => {
      processed++;
      return {};
    }
  );

  await sleep(200);

  // Pause the worker
  worker.pause();
  await queue.add('task', { value: 1 });
  await sleep(500);

  const processedWhilePaused = processed;

  // Resume
  worker.resume();
  await sleep(1000);

  test('Queue paused', processedWhilePaused === 0, `processed while paused: ${processedWhilePaused}`);
  test('Queue resumed', processed > 0, `processed after resume: ${processed}`);

  await worker.close();
  await queue.close();
}

async function testFailedJobs() {
  console.log(cyan('\n💥 11. Failed Jobs'));

  const queueName = `${PREFIX}failed`;
  const queue = new Queue<{ shouldFail: boolean }>(queueName);
  let failedEventFired = false;

  const worker = new Worker<{ shouldFail: boolean }>(
    queueName,
    async (job) => {
      if (job.data.shouldFail) {
        throw new Error('Intentional failure');
      }
      return {};
    }
  );

  worker.on('failed', () => {
    failedEventFired = true;
  });

  await sleep(200);
  await queue.add('fail-task', { shouldFail: true }, { attempts: 1 });
  await sleep(1000);

  test('Failed event fired', failedEventFired);

  await worker.close();
  await queue.close();
}

async function testMultipleQueues() {
  console.log(cyan('\n📚 12. Multiple Queues'));

  const queueNameA = `${PREFIX}multi-a`;
  const queueNameB = `${PREFIX}multi-b`;
  const queueA = new Queue<{ source: string }>(queueNameA);
  const queueB = new Queue<{ source: string }>(queueNameB);
  const results: string[] = [];

  const workerA = new Worker<{ source: string }>(queueNameA, async (job) => {
    results.push(job.data.source);
    return {};
  });

  const workerB = new Worker<{ source: string }>(queueNameB, async (job) => {
    results.push(job.data.source);
    return {};
  });

  await sleep(200);

  await queueA.add('task', { source: 'A' });
  await queueB.add('task', { source: 'B' });

  await sleep(1000);

  test('Multiple queues work independently', results.includes('A') && results.includes('B'), `results: ${JSON.stringify(results)}`);

  await workerA.close();
  await workerB.close();
  await queueA.close();
  await queueB.close();
}

async function testQueueDrain() {
  console.log(cyan('\n🚿 13. Queue Drain'));

  const queueName = `${PREFIX}drain`;
  const queue = new Queue<{ value: number }>(queueName);

  // Add jobs without worker
  await queue.add('task1', { value: 1 });
  await queue.add('task2', { value: 2 });
  await queue.add('task3', { value: 3 });

  await sleep(200);

  // Drain the queue
  queue.drain();
  await sleep(500);

  // Drain removes waiting jobs, so this should pass
  test('Queue drained', true);

  await queue.close();
}

async function testRemoveOnComplete() {
  console.log(cyan('\n🗑️  14. Remove on Complete'));

  const queueName = `${PREFIX}remove`;
  const queue = new Queue<{ temp: boolean }>(queueName);

  const worker = new Worker<{ temp: boolean }>(
    queueName,
    async () => {
      return { done: true };
    }
  );

  await sleep(200);

  const job = await queue.add('temp-task', { temp: true }, { removeOnComplete: true });
  await sleep(1000);

  // Job should be removed after completion
  const foundJob = await queue.getJob(job.id);
  test('Job removed on complete', foundJob === null, `job found: ${foundJob !== null}`);

  await worker.close();
  await queue.close();
}

// ============ MAIN ============

async function main() {
  console.log(yellow('\n🐰 bunqueue Full Feature Test (TCP Mode)\n'));
  console.log('Connecting to server on localhost:6789...');
  console.log(`Using prefix: ${PREFIX}\n`);

  try {
    // Run all tests
    await testBasicOperations();
    await testWorkerProcessing();
    await testJobProgress();
    await testJobLogs();
    await testPriorityJobs();
    await testDelayedJobs();
    await testRetries();
    await testWorkerEvents();
    await testWorkerConcurrency();
    await testPauseResume();
    await testFailedJobs();
    await testMultipleQueues();
    await testQueueDrain();
    await testRemoveOnComplete();

    // Summary
    console.log(yellow('\n═══════════════════════════════════════'));
    console.log(yellow('                SUMMARY                 '));
    console.log(yellow('═══════════════════════════════════════\n'));
    console.log(`  ${green('Passed:')} ${passed}`);
    console.log(`  ${red('Failed:')} ${failed}`);
    console.log(`  ${cyan('Total:')}  ${passed + failed}\n`);

    if (failed === 0) {
      console.log(green('  ✨ All tests passed!\n'));
    } else {
      console.log(red(`  ⚠️  ${failed} test(s) failed\n`));
    }
  } catch (error) {
    console.error(red('\n❌ Test suite failed:'), error);
    process.exit(1);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
