#!/usr/bin/env bun
/**
 * BullMQ vs bunqueue Comprehensive Benchmark
 *
 * Run: bun run bench/comparison/run.ts
 *
 * Prerequisites:
 * - Redis running on localhost:6379
 * - bun add -d bullmq ioredis
 */

import { Queue as BunQueue, Worker as BunWorker } from '../../src/client';
import {
  type BenchmarkResult,
  type ComparisonResults,
  getHardwareInfo,
  calculatePercentiles,
  getMemoryUsageMB,
  warmup,
} from './setup';

const ITERATIONS = 10000;
const BULK_SIZE = 100;
const CONCURRENCY = 10;

// Colors for output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(msg: string) {
  console.log(msg);
}

function logSection(title: string) {
  console.log(`\n${colors.cyan}━━━ ${title} ━━━${colors.reset}\n`);
}

function logResult(library: string, metric: string, value: string) {
  const lib = library === 'bunqueue' ? colors.magenta : colors.yellow;
  console.log(`  ${lib}${library.padEnd(10)}${colors.reset} ${metric.padEnd(20)} ${colors.bold}${value}${colors.reset}`);
}

// ============================================================================
// bunqueue Benchmarks
// ============================================================================

async function benchBunqueuePush(): Promise<BenchmarkResult> {
  const queue = new BunQueue('bench-push');
  await queue.obliterate();

  const latencies: number[] = [];
  const startMem = getMemoryUsageMB();

  // Warmup
  await warmup(async () => {
    await queue.add('warmup', { i: 0 });
  });
  await queue.drain();

  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const opStart = performance.now();
    await queue.add('test', { id: i, data: 'x'.repeat(100) });
    latencies.push(performance.now() - opStart);
  }

  const elapsed = performance.now() - start;
  const endMem = getMemoryUsageMB();
  const percentiles = calculatePercentiles(latencies);

  await queue.obliterate();

  return {
    library: 'bunqueue',
    operation: 'push',
    opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
    avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
    p50Ms: Math.round(percentiles.p50 * 100) / 100,
    p95Ms: Math.round(percentiles.p95 * 100) / 100,
    p99Ms: Math.round(percentiles.p99 * 100) / 100,
    memoryMB: endMem - startMem,
  };
}

async function benchBunqueueBulkPush(): Promise<BenchmarkResult> {
  const queue = new BunQueue('bench-bulk');
  await queue.obliterate();

  const latencies: number[] = [];
  const startMem = getMemoryUsageMB();
  const batches = Math.floor(ITERATIONS / BULK_SIZE);

  const start = performance.now();

  for (let i = 0; i < batches; i++) {
    const jobs = Array.from({ length: BULK_SIZE }, (_, j) => ({
      name: 'test',
      data: { id: i * BULK_SIZE + j, data: 'x'.repeat(100) },
    }));

    const opStart = performance.now();
    await queue.addBulk(jobs);
    latencies.push(performance.now() - opStart);
  }

  const elapsed = performance.now() - start;
  const endMem = getMemoryUsageMB();
  const percentiles = calculatePercentiles(latencies);

  await queue.obliterate();

  return {
    library: 'bunqueue',
    operation: 'bulk-push',
    opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
    avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
    p50Ms: Math.round(percentiles.p50 * 100) / 100,
    p95Ms: Math.round(percentiles.p95 * 100) / 100,
    p99Ms: Math.round(percentiles.p99 * 100) / 100,
    memoryMB: endMem - startMem,
  };
}

async function benchBunqueueProcess(): Promise<BenchmarkResult> {
  const queue = new BunQueue('bench-process');
  await queue.obliterate();

  // Add jobs first
  const jobs = Array.from({ length: ITERATIONS }, (_, i) => ({
    name: 'test',
    data: { id: i },
  }));
  await queue.addBulk(jobs);

  const latencies: number[] = [];
  const startMem = getMemoryUsageMB();
  let processed = 0;

  const start = performance.now();

  const worker = new BunWorker(
    'bench-process',
    async () => {
      processed++;
      return { ok: true };
    },
    { concurrency: CONCURRENCY }
  );

  worker.on('completed', (job) => {
    latencies.push(performance.now() - start);
  });

  // Wait for all jobs to complete
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (processed >= ITERATIONS) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  const elapsed = performance.now() - start;
  const endMem = getMemoryUsageMB();
  const percentiles = calculatePercentiles(latencies);

  await worker.close();
  await queue.obliterate();

  return {
    library: 'bunqueue',
    operation: 'process',
    opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
    avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
    p50Ms: Math.round(percentiles.p50 * 100) / 100,
    p95Ms: Math.round(percentiles.p95 * 100) / 100,
    p99Ms: Math.round(percentiles.p99 * 100) / 100,
    memoryMB: endMem - startMem,
  };
}

// ============================================================================
// BullMQ Benchmarks
// ============================================================================

async function benchBullMQPush(): Promise<BenchmarkResult | null> {
  try {
    const { Queue } = await import('bullmq');
    const queue = new Queue('bench-push', { connection: { host: 'localhost', port: 6379 } });

    await queue.obliterate({ force: true });

    const latencies: number[] = [];
    const startMem = getMemoryUsageMB();

    // Warmup
    for (let i = 0; i < 100; i++) {
      await queue.add('warmup', { i });
    }
    await queue.drain();

    const start = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const opStart = performance.now();
      await queue.add('test', { id: i, data: 'x'.repeat(100) });
      latencies.push(performance.now() - opStart);
    }

    const elapsed = performance.now() - start;
    const endMem = getMemoryUsageMB();
    const percentiles = calculatePercentiles(latencies);

    await queue.obliterate({ force: true });
    await queue.close();

    return {
      library: 'bullmq',
      operation: 'push',
      opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
      avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
      p50Ms: Math.round(percentiles.p50 * 100) / 100,
      p95Ms: Math.round(percentiles.p95 * 100) / 100,
      p99Ms: Math.round(percentiles.p99 * 100) / 100,
      memoryMB: endMem - startMem,
    };
  } catch (e) {
    console.log(`  ${colors.dim}BullMQ push skipped (Redis not available)${colors.reset}`);
    return null;
  }
}

async function benchBullMQBulkPush(): Promise<BenchmarkResult | null> {
  try {
    const { Queue } = await import('bullmq');
    const queue = new Queue('bench-bulk', { connection: { host: 'localhost', port: 6379 } });

    await queue.obliterate({ force: true });

    const latencies: number[] = [];
    const startMem = getMemoryUsageMB();
    const batches = Math.floor(ITERATIONS / BULK_SIZE);

    const start = performance.now();

    for (let i = 0; i < batches; i++) {
      const jobs = Array.from({ length: BULK_SIZE }, (_, j) => ({
        name: 'test',
        data: { id: i * BULK_SIZE + j, data: 'x'.repeat(100) },
      }));

      const opStart = performance.now();
      await queue.addBulk(jobs);
      latencies.push(performance.now() - opStart);
    }

    const elapsed = performance.now() - start;
    const endMem = getMemoryUsageMB();
    const percentiles = calculatePercentiles(latencies);

    await queue.obliterate({ force: true });
    await queue.close();

    return {
      library: 'bullmq',
      operation: 'bulk-push',
      opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
      avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
      p50Ms: Math.round(percentiles.p50 * 100) / 100,
      p95Ms: Math.round(percentiles.p95 * 100) / 100,
      p99Ms: Math.round(percentiles.p99 * 100) / 100,
      memoryMB: endMem - startMem,
    };
  } catch (e) {
    console.log(`  ${colors.dim}BullMQ bulk-push skipped (Redis not available)${colors.reset}`);
    return null;
  }
}

async function benchBullMQProcess(): Promise<BenchmarkResult | null> {
  try {
    const { Queue, Worker } = await import('bullmq');
    const queue = new Queue('bench-process', { connection: { host: 'localhost', port: 6379 } });

    await queue.obliterate({ force: true });

    // Add jobs first
    const jobs = Array.from({ length: ITERATIONS }, (_, i) => ({
      name: 'test',
      data: { id: i },
    }));
    await queue.addBulk(jobs);

    const latencies: number[] = [];
    const startMem = getMemoryUsageMB();
    let processed = 0;

    const start = performance.now();

    const worker = new Worker(
      'bench-process',
      async () => {
        processed++;
        return { ok: true };
      },
      { connection: { host: 'localhost', port: 6379 }, concurrency: CONCURRENCY }
    );

    worker.on('completed', () => {
      latencies.push(performance.now() - start);
    });

    // Wait for all jobs to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (processed >= ITERATIONS) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const elapsed = performance.now() - start;
    const endMem = getMemoryUsageMB();
    const percentiles = calculatePercentiles(latencies);

    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();

    return {
      library: 'bullmq',
      operation: 'process',
      opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
      avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
      p50Ms: Math.round(percentiles.p50 * 100) / 100,
      p95Ms: Math.round(percentiles.p95 * 100) / 100,
      p99Ms: Math.round(percentiles.p99 * 100) / 100,
      memoryMB: endMem - startMem,
    };
  } catch (e) {
    console.log(`  ${colors.dim}BullMQ process skipped (Redis not available)${colors.reset}`);
    return null;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`
${colors.magenta}   (\\(\\        ${colors.reset}
${colors.magenta}   ( -.-)      ${colors.bold}bunqueue vs BullMQ Benchmark${colors.reset}
${colors.magenta}   o_(")(")    ${colors.reset}${colors.dim}Comprehensive comparison${colors.reset}
`);

  log(`${colors.dim}Configuration: ${ITERATIONS} iterations, bulk size ${BULK_SIZE}, concurrency ${CONCURRENCY}${colors.reset}`);

  const results: BenchmarkResult[] = [];

  // bunqueue benchmarks
  logSection('bunqueue Benchmarks');

  log('  Running push benchmark...');
  const bunPush = await benchBunqueuePush();
  results.push(bunPush);
  logResult('bunqueue', 'Push', `${bunPush.opsPerSec.toLocaleString()} ops/sec`);

  log('  Running bulk-push benchmark...');
  const bunBulk = await benchBunqueueBulkPush();
  results.push(bunBulk);
  logResult('bunqueue', 'Bulk Push', `${bunBulk.opsPerSec.toLocaleString()} ops/sec`);

  log('  Running process benchmark...');
  const bunProcess = await benchBunqueueProcess();
  results.push(bunProcess);
  logResult('bunqueue', 'Process', `${bunProcess.opsPerSec.toLocaleString()} ops/sec`);

  // BullMQ benchmarks
  logSection('BullMQ Benchmarks');

  log('  Running push benchmark...');
  const bullPush = await benchBullMQPush();
  if (bullPush) {
    results.push(bullPush);
    logResult('bullmq', 'Push', `${bullPush.opsPerSec.toLocaleString()} ops/sec`);
  }

  log('  Running bulk-push benchmark...');
  const bullBulk = await benchBullMQBulkPush();
  if (bullBulk) {
    results.push(bullBulk);
    logResult('bullmq', 'Bulk Push', `${bullBulk.opsPerSec.toLocaleString()} ops/sec`);
  }

  log('  Running process benchmark...');
  const bullProcess = await benchBullMQProcess();
  if (bullProcess) {
    results.push(bullProcess);
    logResult('bullmq', 'Process', `${bullProcess.opsPerSec.toLocaleString()} ops/sec`);
  }

  // Summary
  logSection('Summary');

  if (bullPush && bunPush) {
    const pushSpeedup = (bunPush.opsPerSec / bullPush.opsPerSec).toFixed(1);
    log(`  Push:      bunqueue is ${colors.green}${pushSpeedup}x faster${colors.reset}`);
  }
  if (bullBulk && bunBulk) {
    const bulkSpeedup = (bunBulk.opsPerSec / bullBulk.opsPerSec).toFixed(1);
    log(`  Bulk Push: bunqueue is ${colors.green}${bulkSpeedup}x faster${colors.reset}`);
  }
  if (bullProcess && bunProcess) {
    const processSpeedup = (bunProcess.opsPerSec / bullProcess.opsPerSec).toFixed(1);
    log(`  Process:   bunqueue is ${colors.green}${processSpeedup}x faster${colors.reset}`);
  }

  // Save results
  const output: ComparisonResults = {
    timestamp: new Date().toISOString(),
    hardware: getHardwareInfo(),
    results,
  };

  const outputPath = './bench/comparison/results.json';
  await Bun.write(outputPath, JSON.stringify(output, null, 2));
  log(`\n${colors.dim}Results saved to ${outputPath}${colors.reset}`);

  // Print JSON for copy-paste
  logSection('JSON Results');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
