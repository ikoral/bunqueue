/**
 * 10 Million Jobs Benchmark - Extreme Stress Test
 * Tests system limits with maximum parallelism
 */

import { QueueManager } from '../application/queueManager';
import { SHARD_COUNT } from '../shared/hash';
import type { Worker } from '../domain/types/worker';

const TOTAL_JOBS = 10_000_000;
const BATCH_SIZE = 10000;
const PULL_BATCH_SIZE = 1000;
const WORKER_COUNT = 32;
const QUEUE_COUNT = 32;
const REMOVE_ON_COMPLETE = true;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║          🔥 10 MILLION JOBS EXTREME BENCHMARK 🔥             ║
╚══════════════════════════════════════════════════════════════╝

Configuration:
  Jobs:      ${TOTAL_JOBS.toLocaleString()}
  Workers:   ${WORKER_COUNT}
  Queues:    ${QUEUE_COUNT}
  Shards:    ${SHARD_COUNT}
  Batch:     ${BATCH_SIZE} (push) / ${PULL_BATCH_SIZE} (pull)
  Mode:      fire-and-forget (max throughput)
`);

async function runBenchmark() {
  const qm = new QueueManager();
  const queues = Array.from({ length: QUEUE_COUNT }, (_, i) => `extreme-queue-${i}`);

  // Phase 0: Register workers
  console.log('👷 Registering workers...');
  const workers: { worker: Worker; queue: string }[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const queue = queues[i % QUEUE_COUNT];
    const worker = qm.workerManager.register(`worker-${i}`, [queue]);
    workers.push({ worker, queue });
  }
  console.log(`✅ ${workers.length} workers ready\n`);

  const startTime = Date.now();

  // Phase 1: Push all jobs
  console.log('📤 Phase 1: Pushing 10M jobs...');
  const pushStart = Date.now();

  const jobsPerQueue = Math.ceil(TOTAL_JOBS / QUEUE_COUNT);

  // Push in parallel to all queues
  await Promise.all(
    queues.map(async (queue, qIdx) => {
      const queueJobs =
        qIdx === queues.length - 1 ? TOTAL_JOBS - jobsPerQueue * (QUEUE_COUNT - 1) : jobsPerQueue;

      for (let i = 0; i < queueJobs; i += BATCH_SIZE) {
        const batch = Array.from({ length: Math.min(BATCH_SIZE, queueJobs - i) }, (_, j) => ({
          data: { idx: qIdx * jobsPerQueue + i + j },
          removeOnComplete: REMOVE_ON_COMPLETE,
        }));
        await qm.pushBatch(queue, batch);
      }
    })
  );

  const pushTime = Date.now() - pushStart;
  const pushRate = Math.round(TOTAL_JOBS / (pushTime / 1000));
  console.log(`✅ Push: ${TOTAL_JOBS.toLocaleString()} jobs in ${(pushTime / 1000).toFixed(2)}s`);
  console.log(`   Rate: ${pushRate.toLocaleString()} jobs/sec\n`);

  // Phase 2: Process all jobs
  console.log('👷 Phase 2: Processing 10M jobs...');
  const processStart = Date.now();

  let totalCompleted = 0;

  // Worker function
  async function workerLoop(queue: string): Promise<number> {
    let workerCompleted = 0;

    while (true) {
      const jobs = await qm.pullBatch(queue, PULL_BATCH_SIZE, 0);
      if (jobs.length === 0) break;

      // Batch ack
      await qm.ackBatch(jobs.map((j) => j.id));
      workerCompleted += jobs.length;
    }

    return workerCompleted;
  }

  // Progress reporter
  const progressInterval = setInterval(() => {
    const stats = qm.getStats();
    const completed = TOTAL_JOBS - stats.waiting - stats.active;
    const elapsed = (Date.now() - processStart) / 1000;
    const overallRate = Math.round(completed / elapsed);

    const pct = ((completed / TOTAL_JOBS) * 100).toFixed(1);
    const bar =
      '█'.repeat(Math.floor((completed / TOTAL_JOBS) * 30)) +
      '░'.repeat(30 - Math.floor((completed / TOTAL_JOBS) * 30));

    console.log(
      `   [${bar}] ${pct}% | ${completed.toLocaleString()} / ${TOTAL_JOBS.toLocaleString()} | ${overallRate.toLocaleString()} jobs/sec`
    );
  }, 2000);

  // Start all workers
  const workerPromises = workers.map((w) => workerLoop(w.queue));
  const results = await Promise.all(workerPromises);
  totalCompleted = results.reduce((a, b) => a + b, 0);

  clearInterval(progressInterval);

  const processTime = Date.now() - processStart;
  const processRate = Math.round(totalCompleted / (processTime / 1000));
  console.log(
    `\n✅ Process: ${totalCompleted.toLocaleString()} jobs in ${(processTime / 1000).toFixed(2)}s`
  );
  console.log(`   Rate: ${processRate.toLocaleString()} jobs/sec\n`);

  // Summary
  const totalTime = Date.now() - startTime;
  const overallRate = Math.round(TOTAL_JOBS / (totalTime / 1000));

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      📊 RESULTS                              ║
╠══════════════════════════════════════════════════════════════╣
║  Total Jobs:       ${TOTAL_JOBS.toLocaleString().padStart(15)}                      ║
║  Total Time:       ${(totalTime / 1000).toFixed(2).padStart(15)}s                     ║
╠══════════════════════════════════════════════════════════════╣
║  Push Rate:        ${pushRate.toLocaleString().padStart(15)} jobs/sec              ║
║  Process Rate:     ${processRate.toLocaleString().padStart(15)} jobs/sec              ║
║  Overall Rate:     ${overallRate.toLocaleString().padStart(15)} jobs/sec              ║
╠══════════════════════════════════════════════════════════════╣
║  Status:           ${totalCompleted === TOTAL_JOBS ? '✅ ALL JOBS COMPLETED' : '❌ INCOMPLETE'}                       ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Memory stats
  const mem = process.memoryUsage();
  console.log(`
💾 Memory Usage:
   Heap Used:  ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB
   Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB
   RSS:        ${(mem.rss / 1024 / 1024).toFixed(2)} MB
`);

  // Cleanup
  for (const { worker } of workers) {
    qm.workerManager.unregister(worker.id);
  }
  qm.shutdown();
}

runBenchmark().catch(console.error);
