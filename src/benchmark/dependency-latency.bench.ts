/**
 * Dependency Chain Latency Benchmark
 * Measures time from parent ack to child becoming pullable
 */

import { QueueManager } from '../application/queueManager';
import type { JobId } from '../domain/types/job';

const QUEUE = 'dep-bench';

interface LatencyResult {
  scenario: string;
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatLatency(ms: number): string {
  if (ms < 0.001) return `${(ms * 1_000_000).toFixed(0)}ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)}us`;
  return `${ms.toFixed(2)}ms`;
}

/**
 * Benchmark 1: Single dependency chain (A → B)
 * Push B (depends on A), push A, pull+ack A, measure time until B is pullable
 */
async function benchSingleDep(qm: QueueManager, samples: number): Promise<LatencyResult> {
  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    // Push parent
    const parent = await qm.push(QUEUE, { data: { role: 'parent', i } });

    // Push child that depends on parent
    await qm.push(QUEUE, {
      data: { role: 'child', i },
      dependsOn: [parent.id],
    });

    // Pull and ack parent
    const pulled = await qm.pull(QUEUE, 0);
    if (!pulled) throw new Error('Parent not pullable');

    const start = performance.now();
    await qm.ack(pulled.id);

    // Poll for child availability (measure latency)
    let child = await qm.pull(QUEUE, 0);
    let attempts = 0;
    while (!child && attempts < 1000) {
      await new Promise((r) => setTimeout(r, 0));
      child = await qm.pull(QUEUE, 0);
      attempts++;
    }
    const end = performance.now();

    if (!child) throw new Error(`Child not pullable after ${attempts} attempts`);
    await qm.ack(child.id);

    latencies.push(end - start);
  }

  latencies.sort((a, b) => a - b);
  return {
    scenario: 'Single dep (A→B)',
    samples,
    avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
  };
}

/**
 * Benchmark 2: Chain dependency (A → B → C → D)
 * Measures total time to resolve a 4-level chain
 */
async function benchChainDep(qm: QueueManager, samples: number): Promise<LatencyResult> {
  const CHAIN_LENGTH = 4;
  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    // Create chain: job0 (no deps) → job1 (depends on job0) → job2 → job3
    const jobIds: JobId[] = [];

    const first = await qm.push(QUEUE, { data: { chain: i, level: 0 } });
    jobIds.push(first.id);

    for (let level = 1; level < CHAIN_LENGTH; level++) {
      const job = await qm.push(QUEUE, {
        data: { chain: i, level },
        dependsOn: [jobIds[level - 1]],
      });
      jobIds.push(job.id);
    }

    // Start timer: pull and ack all jobs in chain order
    const start = performance.now();

    for (let level = 0; level < CHAIN_LENGTH; level++) {
      let pulled = await qm.pull(QUEUE, 0);
      let attempts = 0;
      while (!pulled && attempts < 2000) {
        await new Promise((r) => setTimeout(r, 0));
        pulled = await qm.pull(QUEUE, 0);
        attempts++;
      }
      if (!pulled) throw new Error(`Chain level ${level} not pullable after ${attempts} attempts`);
      await qm.ack(pulled.id);
    }

    const end = performance.now();
    latencies.push(end - start);
  }

  latencies.sort((a, b) => a - b);
  return {
    scenario: `Chain dep (${CHAIN_LENGTH} levels)`,
    samples,
    avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
  };
}

/**
 * Benchmark 3: Fan-out (A → B1, B2, B3, B4, B5)
 * One parent, multiple children become pullable simultaneously
 */
async function benchFanOut(qm: QueueManager, samples: number): Promise<LatencyResult> {
  const FAN_OUT = 5;
  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    const parent = await qm.push(QUEUE, { data: { role: 'parent', i } });

    for (let c = 0; c < FAN_OUT; c++) {
      await qm.push(QUEUE, {
        data: { role: 'child', i, c },
        dependsOn: [parent.id],
      });
    }

    // Pull and ack parent
    const pulled = await qm.pull(QUEUE, 0);
    if (!pulled) throw new Error('Parent not pullable');

    const start = performance.now();
    await qm.ack(pulled.id);

    // Pull all children
    let childCount = 0;
    let attempts = 0;
    while (childCount < FAN_OUT && attempts < 5000) {
      const child = await qm.pull(QUEUE, 0);
      if (child) {
        childCount++;
        await qm.ack(child.id);
      } else {
        await new Promise((r) => setTimeout(r, 0));
        attempts++;
      }
    }
    const end = performance.now();

    if (childCount < FAN_OUT) {
      throw new Error(`Only ${childCount}/${FAN_OUT} children pullable`);
    }

    latencies.push(end - start);
  }

  latencies.sort((a, b) => a - b);
  return {
    scenario: `Fan-out (1→${FAN_OUT})`,
    samples,
    avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
  };
}

function printResults(results: LatencyResult[]): void {
  console.log('\n' + '='.repeat(90));
  console.log('DEPENDENCY LATENCY BENCHMARK');
  console.log('='.repeat(90));
  console.log(
    'Scenario'.padEnd(25) +
      'Samples'.padStart(8) +
      'Avg'.padStart(12) +
      'P50'.padStart(12) +
      'P95'.padStart(12) +
      'P99'.padStart(12) +
      'Min'.padStart(12) +
      'Max'.padStart(12)
  );
  console.log('-'.repeat(90));

  for (const r of results) {
    console.log(
      r.scenario.padEnd(25) +
        String(r.samples).padStart(8) +
        formatLatency(r.avgMs).padStart(12) +
        formatLatency(r.p50Ms).padStart(12) +
        formatLatency(r.p95Ms).padStart(12) +
        formatLatency(r.p99Ms).padStart(12) +
        formatLatency(r.minMs).padStart(12) +
        formatLatency(r.maxMs).padStart(12)
    );
  }
  console.log('='.repeat(90));
}

async function main(): Promise<void> {
  console.log('Dependency Chain Latency Benchmark');
  console.log('==================================\n');

  const SAMPLES = 200;
  const results: LatencyResult[] = [];

  // Run each benchmark with a fresh QueueManager
  for (const bench of [
    { name: 'single', fn: benchSingleDep },
    { name: 'chain', fn: benchChainDep },
    { name: 'fan-out', fn: benchFanOut },
  ]) {
    console.log(`Running ${bench.name}...`);
    const qm = new QueueManager();
    try {
      results.push(await bench.fn(qm, SAMPLES));
    } finally {
      qm.shutdown();
    }
  }

  printResults(results);
}

main().catch(console.error);
