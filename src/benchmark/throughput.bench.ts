/**
 * bunQ Throughput Benchmark
 * Measures jobs per second for push, pull, ack operations
 */

import { QueueManager } from '../application/queueManager';

const QUEUE_NAME = 'benchmark-queue';

interface BenchmarkResult {
  operation: string;
  totalJobs: number;
  durationMs: number;
  jobsPerSecond: number;
}

/** Format number with thousand separators */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Run a benchmark */
async function runBenchmark(
  name: string,
  totalJobs: number,
  fn: () => Promise<void>
): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < 100; i++) {
    await fn();
  }

  const start = performance.now();
  for (let i = 0; i < totalJobs; i++) {
    await fn();
  }
  const end = performance.now();

  const durationMs = end - start;
  const jobsPerSecond = (totalJobs / durationMs) * 1000;

  return { operation: name, totalJobs, durationMs, jobsPerSecond };
}

/** Benchmark PUSH operation */
async function benchmarkPush(qm: QueueManager, count: number): Promise<BenchmarkResult> {
  let i = 0;
  return runBenchmark('PUSH', count, async () => {
    await qm.push(QUEUE_NAME, { data: { id: i++, payload: 'benchmark-data' } });
  });
}

/** Benchmark PULL operation */
async function benchmarkPull(qm: QueueManager, count: number): Promise<BenchmarkResult> {
  // Pre-fill queue
  for (let i = 0; i < count + 100; i++) {
    await qm.push(QUEUE_NAME, { data: { id: i } });
  }

  return runBenchmark('PULL', count, async () => {
    await qm.pull(QUEUE_NAME, 0);
  });
}

/** Benchmark ACK operation */
async function benchmarkAck(qm: QueueManager, count: number): Promise<BenchmarkResult> {
  // Pre-pull jobs
  const jobIds: bigint[] = [];
  for (let i = 0; i < count + 100; i++) {
    await qm.push(QUEUE_NAME, { data: { id: i } });
  }
  for (let i = 0; i < count + 100; i++) {
    const job = await qm.pull(QUEUE_NAME, 0);
    if (job) jobIds.push(job.id);
  }

  let idx = 0;
  return runBenchmark('ACK', count, async () => {
    const jobId = jobIds[idx++];
    if (jobId !== undefined) {
      await qm.ack(jobId as any);
    }
  });
}

/** Benchmark full cycle: PUSH + PULL + ACK */
async function benchmarkFullCycle(qm: QueueManager, count: number): Promise<BenchmarkResult> {
  const start = performance.now();

  for (let i = 0; i < count; i++) {
    const job = await qm.push(QUEUE_NAME, { data: { id: i } });
    const pulled = await qm.pull(QUEUE_NAME, 0);
    if (pulled) {
      await qm.ack(pulled.id);
    }
  }

  const end = performance.now();
  const durationMs = end - start;
  const jobsPerSecond = (count / durationMs) * 1000;

  return { operation: 'FULL CYCLE (push+pull+ack)', totalJobs: count, durationMs, jobsPerSecond };
}

/** Benchmark batch push */
async function benchmarkBatchPush(qm: QueueManager, totalJobs: number, batchSize: number): Promise<BenchmarkResult> {
  const batches = Math.ceil(totalJobs / batchSize);
  const jobs = Array.from({ length: batchSize }, (_, i) => ({ data: { id: i } }));

  const start = performance.now();
  for (let b = 0; b < batches; b++) {
    await qm.pushBatch(QUEUE_NAME, jobs);
  }
  const end = performance.now();

  const actualJobs = batches * batchSize;
  const durationMs = end - start;
  const jobsPerSecond = (actualJobs / durationMs) * 1000;

  return { operation: `BATCH PUSH (batch=${batchSize})`, totalJobs: actualJobs, durationMs, jobsPerSecond };
}

/** Print results table */
function printResults(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(70));
  console.log(
    'Operation'.padEnd(35) +
    'Jobs'.padStart(10) +
    'Time (ms)'.padStart(12) +
    'Jobs/sec'.padStart(13)
  );
  console.log('-'.repeat(70));

  for (const r of results) {
    console.log(
      r.operation.padEnd(35) +
      formatNumber(r.totalJobs).padStart(10) +
      formatNumber(r.durationMs).padStart(12) +
      formatNumber(r.jobsPerSecond).padStart(13)
    );
  }

  console.log('='.repeat(70));
}

/** Main benchmark runner */
async function main(): Promise<void> {
  console.log('bunQ Throughput Benchmark');
  console.log('========================\n');

  const results: BenchmarkResult[] = [];

  // Small test
  const SMALL = 10_000;
  // Medium test
  const MEDIUM = 50_000;
  // Large test
  const LARGE = 100_000;

  // Test with different job counts
  for (const count of [SMALL, MEDIUM]) {
    console.log(`\nRunning benchmarks with ${formatNumber(count)} jobs...`);

    // Create fresh queue manager for each test
    const qm = new QueueManager();

    try {
      // Individual operations
      console.log('  Testing PUSH...');
      results.push(await benchmarkPush(qm, count));

      qm.drain(QUEUE_NAME);

      console.log('  Testing PULL...');
      results.push(await benchmarkPull(qm, count));

      qm.drain(QUEUE_NAME);

      console.log('  Testing ACK...');
      results.push(await benchmarkAck(qm, count));

      qm.drain(QUEUE_NAME);

      // Full cycle
      console.log('  Testing FULL CYCLE...');
      results.push(await benchmarkFullCycle(qm, Math.min(count, 10_000)));

      qm.drain(QUEUE_NAME);

      // Batch push
      console.log('  Testing BATCH PUSH...');
      results.push(await benchmarkBatchPush(qm, count, 100));
      results.push(await benchmarkBatchPush(qm, count, 1000));

    } finally {
      qm.shutdown();
    }
  }

  printResults(results);

  // Summary
  const pushResults = results.filter(r => r.operation === 'PUSH');
  const pullResults = results.filter(r => r.operation === 'PULL');
  const ackResults = results.filter(r => r.operation === 'ACK');

  console.log('\nSUMMARY');
  console.log('-'.repeat(40));
  if (pushResults.length > 0) {
    const avgPush = pushResults.reduce((a, b) => a + b.jobsPerSecond, 0) / pushResults.length;
    console.log(`Average PUSH: ${formatNumber(avgPush)} jobs/sec`);
  }
  if (pullResults.length > 0) {
    const avgPull = pullResults.reduce((a, b) => a + b.jobsPerSecond, 0) / pullResults.length;
    console.log(`Average PULL: ${formatNumber(avgPull)} jobs/sec`);
  }
  if (ackResults.length > 0) {
    const avgAck = ackResults.reduce((a, b) => a + b.jobsPerSecond, 0) / ackResults.length;
    console.log(`Average ACK:  ${formatNumber(avgAck)} jobs/sec`);
  }
}

// Run
main().catch(console.error);
