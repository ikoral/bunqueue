/**
 * TCP Performance Benchmark
 * Tests batch pull and connection pool optimizations
 *
 * Prerequisites: bunqueue server running on localhost:6789
 * Run: bun run demo/tcp-benchmark.ts
 */

import { Queue, Worker } from '../src/client';

const TOTAL_JOBS = 10_000;
const BATCH_SIZE = 500;

console.log(`
🚀 TCP Performance Benchmark
=====================================
Jobs:     ${TOTAL_JOBS.toLocaleString()}
Batch:    ${BATCH_SIZE}
`);

interface BenchResult {
  name: string;
  pushTime: number;
  processTime: number;
  pushRate: number;
  processRate: number;
}

async function runBenchmark(
  name: string,
  workerOpts: { concurrency: number; batchSize: number },
  queueOpts: { poolSize?: number } = {}
): Promise<BenchResult> {
  const queueName = `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const queue = new Queue<{ index: number }>(queueName, {
    connection: { poolSize: queueOpts.poolSize },
  });
  let completed = 0;

  // Phase 1: Push jobs
  const pushStart = Date.now();
  const jobs = Array.from({ length: TOTAL_JOBS }, (_, i) => ({
    name: 'task',
    data: { index: i },
    opts: { removeOnComplete: true },
  }));

  // Push in batches
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    await queue.addBulk(batch);
  }

  const pushTime = Date.now() - pushStart;
  const pushRate = Math.round(TOTAL_JOBS / (pushTime / 1000));

  // Phase 2: Process with worker
  const processStart = Date.now();

  const worker = new Worker<{ index: number }>(
    queueName,
    async () => {
      completed++;
      return {};
    },
    { ...workerOpts, autorun: false }
  );

  worker.run();

  // Wait for completion
  while (completed < TOTAL_JOBS) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const processTime = Date.now() - processStart;
  const processRate = Math.round(completed / (processTime / 1000));

  await worker.close();
  await queue.close();

  return { name, pushTime, processTime, pushRate, processRate };
}

async function main() {
  const results: BenchResult[] = [];

  // Test 1: Baseline - single pull, no batch
  console.log('📊 Test 1: Baseline (batchSize=1, concurrency=1)...');
  results.push(await runBenchmark('Baseline', { concurrency: 1, batchSize: 1 }));

  // Test 2: Batch pull only
  console.log('📊 Test 2: Batch Pull (batchSize=50, concurrency=1)...');
  results.push(await runBenchmark('Batch Pull', { concurrency: 1, batchSize: 50 }));

  // Test 3: Concurrency only
  console.log('📊 Test 3: Concurrency (batchSize=1, concurrency=10)...');
  results.push(await runBenchmark('Concurrency', { concurrency: 10, batchSize: 1 }));

  // Test 4: Batch + Concurrency
  console.log('📊 Test 4: Batch + Concurrency (batchSize=50, concurrency=10)...');
  results.push(await runBenchmark('Batch+Concurrency', { concurrency: 10, batchSize: 50 }));

  // Test 5: High batch + high concurrency
  console.log('📊 Test 5: High Performance (batchSize=100, concurrency=20)...');
  results.push(await runBenchmark('High Perf', { concurrency: 20, batchSize: 100 }));

  // Test 6: With connection pool
  console.log('📊 Test 6: Connection Pool (poolSize=4, batchSize=50, concurrency=10)...');
  results.push(await runBenchmark('Pool+Batch', { concurrency: 10, batchSize: 50 }, { poolSize: 4 }));

  // Test 7: Maximum performance with batch ACK
  console.log('📊 Test 7: Max Perf (batchSize=200, concurrency=50)...');
  results.push(await runBenchmark('Max Perf', { concurrency: 50, batchSize: 200 }));

  // Print results
  console.log(`
═══════════════════════════════════════════════════════════════════
                         BENCHMARK RESULTS
═══════════════════════════════════════════════════════════════════
`);

  console.log('┌─────────────────────┬───────────┬───────────┬────────────┬────────────┐');
  console.log('│ Configuration       │ Push Time │ Push Rate │ Proc Time  │ Proc Rate  │');
  console.log('├─────────────────────┼───────────┼───────────┼────────────┼────────────┤');

  const baseline = results[0];

  for (const r of results) {
    const pushSpeedup = (r.pushRate / baseline.pushRate).toFixed(1);
    const procSpeedup = (r.processRate / baseline.processRate).toFixed(1);
    const pushRateStr = `${(r.pushRate / 1000).toFixed(1)}K/s`;
    const procRateStr = `${(r.processRate / 1000).toFixed(1)}K/s`;

    console.log(
      `│ ${r.name.padEnd(19)} │ ${String(r.pushTime + 'ms').padStart(9)} │ ${pushRateStr.padStart(9)} │ ${String(r.processTime + 'ms').padStart(10)} │ ${procRateStr.padStart(10)} │`
    );
  }

  console.log('└─────────────────────┴───────────┴───────────┴────────────┴────────────┘');

  // Speedup summary
  console.log(`
📈 Speedup vs Baseline:
`);
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const pushSpeedup = (r.pushRate / baseline.pushRate).toFixed(1);
    const procSpeedup = (r.processRate / baseline.processRate).toFixed(1);
    console.log(`  ${r.name}: Push ${pushSpeedup}x, Process ${procSpeedup}x`);
  }

  console.log();
}

main().catch(console.error);
