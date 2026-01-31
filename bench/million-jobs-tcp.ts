/**
 * Benchmark: 1 Million Jobs via TCP
 * Tests Queue (producer) and Worker (consumer) performance
 */

import { Queue, Worker } from '../src/client';

const TOTAL_JOBS = 1_000_000;
const BATCH_SIZE = 1000;
const WORKER_CONCURRENCY = 100;
const QUEUE_NAME = 'bench-million';

async function runBenchmark() {
  console.log('='.repeat(60));
  console.log('🐰 bunqueue TCP Benchmark: 1 Million Jobs');
  console.log('='.repeat(60));
  console.log(`Jobs: ${TOTAL_JOBS.toLocaleString()}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Worker concurrency: ${WORKER_CONCURRENCY}`);
  console.log('='.repeat(60));

  // Create queue and worker (TCP mode - no embedded flag)
  const queue = new Queue(QUEUE_NAME, {
    connection: { host: 'localhost', port: 6789, poolSize: 8 },
    defaultJobOptions: {
      // Very long stall timeout for benchmark (jobs complete instantly, no need for stall detection)
      stallTimeout: 300_000, // 5 minutes
    },
  });

  let completed = 0;
  let failed = 0;
  const startTime = Date.now();
  let producerDone = false;
  let producerEndTime = 0;

  // Create worker
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Minimal processing - just return
      return { ok: true };
    },
    {
      concurrency: WORKER_CONCURRENCY,
      connection: { host: 'localhost', port: 6789, poolSize: 16 },
      batchSize: 100,
      autorun: false,
    }
  );

  worker.on('completed', () => {
    completed++;
    if (completed % 100_000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.round(completed / elapsed);
      console.log(
        `  Completed: ${completed.toLocaleString()} (${rate.toLocaleString()} jobs/sec)`
      );
    }
  });

  worker.on('failed', (job, err) => {
    failed++;
    if (failed <= 5) {
      console.error(`  Failed job ${job.id}: ${err.message}`);
    }
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err.message);
  });

  // Start worker
  console.log('\n📥 Starting worker...');
  worker.run();

  // Push jobs in batches
  console.log('\n📤 Pushing jobs...');
  const pushStart = Date.now();

  for (let i = 0; i < TOTAL_JOBS; i += BATCH_SIZE) {
    const batch = [];
    const batchEnd = Math.min(i + BATCH_SIZE, TOTAL_JOBS);

    for (let j = i; j < batchEnd; j++) {
      batch.push({
        name: 'bench',
        data: { index: j },
      });
    }

    await queue.addBulk(batch);

    if ((i + BATCH_SIZE) % 100_000 === 0 || i + BATCH_SIZE >= TOTAL_JOBS) {
      const pushed = Math.min(i + BATCH_SIZE, TOTAL_JOBS);
      const elapsed = (Date.now() - pushStart) / 1000;
      const rate = Math.round(pushed / elapsed);
      console.log(`  Pushed: ${pushed.toLocaleString()} (${rate.toLocaleString()} jobs/sec)`);
    }
  }

  producerEndTime = Date.now();
  producerDone = true;
  const pushDuration = (producerEndTime - pushStart) / 1000;
  const pushRate = Math.round(TOTAL_JOBS / pushDuration);

  console.log(`\n✅ Producer finished in ${pushDuration.toFixed(2)}s (${pushRate.toLocaleString()} jobs/sec)`);

  // Wait for all jobs to complete
  console.log('\n⏳ Waiting for worker to finish...');

  while (completed + failed < TOTAL_JOBS) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const totalDuration = (Date.now() - startTime) / 1000;
  const totalRate = Math.round(TOTAL_JOBS / totalDuration);

  // Close connections
  await worker.close();
  queue.close();

  // Print results
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESULTS');
  console.log('='.repeat(60));
  console.log(`Total jobs:      ${TOTAL_JOBS.toLocaleString()}`);
  console.log(`Completed:       ${completed.toLocaleString()}`);
  console.log(`Failed:          ${failed.toLocaleString()}`);
  console.log(`Push duration:   ${pushDuration.toFixed(2)}s`);
  console.log(`Push rate:       ${pushRate.toLocaleString()} jobs/sec`);
  console.log(`Total duration:  ${totalDuration.toFixed(2)}s`);
  console.log(`Total rate:      ${totalRate.toLocaleString()} jobs/sec`);
  console.log('='.repeat(60));
}

// Run
runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
