/**
 * Million Jobs Benchmark - TCP Mode
 * Tests full job lifecycle via TCP: push -> pull -> ack
 * Compares performance with embedded mode
 *
 * Prerequisites: bunqueue server running on localhost:6789
 * Run: bun run demo/million-jobs-tcp.ts
 */

import { Queue, Worker } from '../src/client';

const TOTAL_JOBS = 100_000; // Start with 100K for TCP (network overhead)
const BATCH_SIZE = 1000; // Push batch size
const WORKER_COUNT = 8; // Concurrent workers
const QUEUE_COUNT = 4; // Multiple queues

console.log(`
🚀 Million Jobs Benchmark (TCP Mode)
=====================================
Jobs:     ${TOTAL_JOBS.toLocaleString()}
Workers:  ${WORKER_COUNT}
Queues:   ${QUEUE_COUNT}
Batch:    ${BATCH_SIZE}
`);

async function runBenchmark() {
  const queues: Queue<{ index: number }>[] = [];
  const workers: Worker<{ index: number }>[] = [];
  const queueNames = Array.from({ length: QUEUE_COUNT }, (_, i) => `tcp-bench-${Date.now()}-${i}`);

  // Create queues
  for (const name of queueNames) {
    queues.push(new Queue<{ index: number }>(name));
  }

  // Stats tracking
  let completed = 0;
  const seenIndexes = new Set<number>();
  const startTime = Date.now();

  // Phase 1: Push all jobs
  console.log('📤 Phase 1: Pushing jobs via TCP...');
  const pushStart = Date.now();

  const jobsPerQueue = Math.ceil(TOTAL_JOBS / QUEUE_COUNT);

  await Promise.all(
    queues.map(async (queue, qIdx) => {
      const queueJobs = qIdx === queues.length - 1
        ? TOTAL_JOBS - jobsPerQueue * (QUEUE_COUNT - 1)
        : jobsPerQueue;

      for (let i = 0; i < queueJobs; i += BATCH_SIZE) {
        const batch = Array.from(
          { length: Math.min(BATCH_SIZE, queueJobs - i) },
          (_, j) => ({
            name: 'task',
            data: { index: qIdx * jobsPerQueue + i + j },
            opts: { removeOnComplete: true },
          })
        );
        await queue.addBulk(batch);
      }
    })
  );

  const pushTime = Date.now() - pushStart;
  const pushRate = Math.round(TOTAL_JOBS / (pushTime / 1000));
  console.log(`✅ Push complete: ${TOTAL_JOBS.toLocaleString()} jobs in ${pushTime}ms (${pushRate.toLocaleString()} jobs/sec)\n`);

  // Phase 2: Create workers and process
  console.log('👷 Phase 2: Workers processing jobs via TCP...');
  const processStart = Date.now();

  // Create workers for each queue
  for (let w = 0; w < WORKER_COUNT; w++) {
    const queueName = queueNames[w % QUEUE_COUNT];
    const worker = new Worker<{ index: number }>(
      queueName,
      async (job) => {
        seenIndexes.add(job.data.index);
        completed++;
        return { done: true };
      },
      { concurrency: 5, autorun: false }
    );
    workers.push(worker);
  }

  // Start all workers
  for (const worker of workers) {
    worker.run();
  }

  // Progress reporter
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - processStart) / 1000;
    const rate = Math.round(completed / elapsed);
    console.log(`  Progress: ${completed.toLocaleString()} completed (${rate.toLocaleString()} jobs/sec)`);
  }, 2000);

  // Wait for all jobs to complete
  const maxWait = 120000; // 2 minutes max
  const waitStart = Date.now();
  while (completed < TOTAL_JOBS && Date.now() - waitStart < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }

  clearInterval(progressInterval);

  const processTime = Date.now() - processStart;
  const processRate = Math.round(completed / (processTime / 1000));

  console.log(`✅ Process complete: ${completed.toLocaleString()} jobs in ${processTime}ms (${processRate.toLocaleString()} jobs/sec)\n`);

  // Summary
  const totalTime = Date.now() - startTime;
  const overallRate = Math.round(TOTAL_JOBS / (totalTime / 1000));

  // Data integrity check
  const missingIndexes: number[] = [];
  for (let i = 0; i < TOTAL_JOBS && missingIndexes.length < 10; i++) {
    if (!seenIndexes.has(i)) missingIndexes.push(i);
  }

  const passed = seenIndexes.size === TOTAL_JOBS;

  console.log(`
📊 Summary (TCP Mode)
==========================
Total jobs:      ${TOTAL_JOBS.toLocaleString()}
Completed:       ${completed.toLocaleString()}
Total time:      ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)

Push rate:       ${pushRate.toLocaleString()} jobs/sec
Process rate:    ${processRate.toLocaleString()} jobs/sec
Overall rate:    ${overallRate.toLocaleString()} jobs/sec

Workers:         ${WORKER_COUNT}
Per-worker avg:  ${Math.round(completed / WORKER_COUNT).toLocaleString()} jobs

✅ Data Integrity
--------------------------
Unique indexes:  ${seenIndexes.size.toLocaleString()} / ${TOTAL_JOBS.toLocaleString()}
Missing indexes: ${missingIndexes.length > 0 ? missingIndexes.join(', ') + '...' : 'none'}
Status:          ${passed ? '✅ PASSED' : '❌ FAILED'}

📈 Comparison (Embedded vs TCP)
--------------------------
Embedded push:   ~1,146,789 jobs/sec
TCP push:        ${pushRate.toLocaleString()} jobs/sec
Ratio:           ${(1146789 / pushRate).toFixed(1)}x slower (network overhead)

Embedded process: ~499,750 jobs/sec
TCP process:      ${processRate.toLocaleString()} jobs/sec
Ratio:            ${(499750 / processRate).toFixed(1)}x slower (network overhead)
`);

  // Cleanup
  for (const worker of workers) {
    await worker.close();
  }
  for (const queue of queues) {
    await queue.close();
  }
}

runBenchmark().catch(console.error);
