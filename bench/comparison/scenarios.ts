#!/usr/bin/env bun
/**
 * Real-World & Niche Scenario Benchmarks
 * bunqueue vs BullMQ
 *
 * Run: bun run bench/comparison/scenarios.ts
 */

import { Queue as BunQueue, Worker as BunWorker } from '../../src/client';
import { getHardwareInfo, calculatePercentiles, getMemoryUsageMB } from './setup';

// Colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

interface ScenarioResult {
  scenario: string;
  category: 'real-world' | 'niche';
  bunqueue: { opsPerSec: number; avgLatencyMs: number; p99Ms: number };
  bullmq: { opsPerSec: number; avgLatencyMs: number; p99Ms: number } | null;
  speedup: number | null;
}

const results: ScenarioResult[] = [];

function log(msg: string) {
  console.log(msg);
}

function logScenario(name: string, category: string) {
  console.log(`\n${c.cyan}━━━ ${name} ${c.dim}(${category})${c.reset} ${c.cyan}━━━${c.reset}\n`);
}

function logResult(library: string, ops: number, latency: number) {
  const lib = library === 'bunqueue' ? c.magenta : c.yellow;
  console.log(`  ${lib}${library.padEnd(10)}${c.reset} ${ops.toLocaleString().padStart(10)} ops/sec  ${c.dim}p99: ${latency.toFixed(2)}ms${c.reset}`);
}

// ============================================================================
// REAL-WORLD SCENARIOS
// ============================================================================

/**
 * Scenario 1: Email Queue
 * - Mixed immediate and delayed emails
 * - Some with priority (transactional vs marketing)
 * - Retry on failure
 */
async function scenarioEmailQueue(): Promise<void> {
  logScenario('Email Queue', 'real-world');
  const EMAILS = 5000;

  // bunqueue
  const bunQueue = new BunQueue('email-queue');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  // Add mixed emails
  for (let i = 0; i < EMAILS; i++) {
    const opStart = performance.now();
    const isTransactional = i % 5 === 0;
    const isDelayed = i % 10 === 0;

    await bunQueue.add(
      isTransactional ? 'transactional' : 'marketing',
      {
        to: `user${i}@example.com`,
        subject: `Email ${i}`,
        body: 'x'.repeat(500),
      },
      {
        priority: isTransactional ? 10 : 1,
        delay: isDelayed ? 100 : 0,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );
    bunLatencies.push(performance.now() - opStart);
  }

  const bunElapsed = performance.now() - bunStart;
  const bunPercentiles = calculatePercentiles(bunLatencies);
  const bunOps = Math.round((EMAILS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunPercentiles.p99);

  // BullMQ
  let bullOps = 0;
  let bullP99 = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('email-queue', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullLatencies: number[] = [];
    const bullStart = performance.now();

    for (let i = 0; i < EMAILS; i++) {
      const opStart = performance.now();
      const isTransactional = i % 5 === 0;
      const isDelayed = i % 10 === 0;

      await bullQueue.add(
        isTransactional ? 'transactional' : 'marketing',
        {
          to: `user${i}@example.com`,
          subject: `Email ${i}`,
          body: 'x'.repeat(500),
        },
        {
          priority: isTransactional ? 10 : 1,
          delay: isDelayed ? 100 : 0,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }
      );
      bullLatencies.push(performance.now() - opStart);
    }

    const bullElapsed = performance.now() - bullStart;
    const bullPercentiles = calculatePercentiles(bullLatencies);
    bullOps = Math.round((EMAILS / bullElapsed) * 1000);
    bullP99 = bullPercentiles.p99;

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullP99);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Email Queue',
    category: 'real-world',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies.reduce((a, b) => a + b, 0) / bunLatencies.length, p99Ms: bunPercentiles.p99 },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: 0, p99Ms: bullP99 } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 2: API Webhook Delivery
 * - Burst of webhooks after an event
 * - Retries with exponential backoff
 */
async function scenarioWebhookDelivery(): Promise<void> {
  logScenario('Webhook Delivery Burst', 'real-world');
  const WEBHOOKS = 3000;

  const bunQueue = new BunQueue('webhooks');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  // Simulate burst - add all webhooks as fast as possible
  const jobs = Array.from({ length: WEBHOOKS }, (_, i) => ({
    name: 'deliver',
    data: {
      url: `https://api${i % 100}.example.com/webhook`,
      payload: { event: 'order.created', orderId: i, timestamp: Date.now() },
      headers: { 'X-Webhook-Secret': 'secret123' },
    },
    opts: { attempts: 5, backoff: { type: 'exponential' as const, delay: 500 } },
  }));

  const opStart = performance.now();
  await bunQueue.addBulk(jobs);
  bunLatencies.push(performance.now() - opStart);

  const bunElapsed = performance.now() - bunStart;
  const bunOps = Math.round((WEBHOOKS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunLatencies[0]);

  // BullMQ
  let bullOps = 0;
  let bullLatency = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('webhooks', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullStart = performance.now();
    const bullOpStart = performance.now();
    await bullQueue.addBulk(jobs);
    bullLatency = performance.now() - bullOpStart;

    const bullElapsed = performance.now() - bullStart;
    bullOps = Math.round((WEBHOOKS / bullElapsed) * 1000);

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullLatency);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Webhook Burst',
    category: 'real-world',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies[0], p99Ms: bunLatencies[0] },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: bullLatency, p99Ms: bullLatency } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 3: Image Processing Pipeline
 * - Large payloads (image metadata)
 * - Sequential processing
 */
async function scenarioImageProcessing(): Promise<void> {
  logScenario('Image Processing (Large Payloads)', 'real-world');
  const IMAGES = 1000;
  const PAYLOAD_SIZE = 10000; // 10KB metadata per image

  const bunQueue = new BunQueue('images');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  for (let i = 0; i < IMAGES; i++) {
    const opStart = performance.now();
    await bunQueue.add('process', {
      imageId: `img_${i}`,
      url: `https://cdn.example.com/images/${i}.jpg`,
      metadata: {
        width: 1920,
        height: 1080,
        format: 'jpeg',
        exif: 'x'.repeat(PAYLOAD_SIZE), // Large EXIF data
      },
      operations: ['resize', 'watermark', 'optimize'],
    });
    bunLatencies.push(performance.now() - opStart);
  }

  const bunElapsed = performance.now() - bunStart;
  const bunPercentiles = calculatePercentiles(bunLatencies);
  const bunOps = Math.round((IMAGES / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunPercentiles.p99);

  // BullMQ
  let bullOps = 0;
  let bullP99 = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('images', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullLatencies: number[] = [];
    const bullStart = performance.now();

    for (let i = 0; i < IMAGES; i++) {
      const opStart = performance.now();
      await bullQueue.add('process', {
        imageId: `img_${i}`,
        url: `https://cdn.example.com/images/${i}.jpg`,
        metadata: {
          width: 1920,
          height: 1080,
          format: 'jpeg',
          exif: 'x'.repeat(PAYLOAD_SIZE),
        },
        operations: ['resize', 'watermark', 'optimize'],
      });
      bullLatencies.push(performance.now() - opStart);
    }

    const bullElapsed = performance.now() - bullStart;
    const bullPercentiles = calculatePercentiles(bullLatencies);
    bullOps = Math.round((IMAGES / bullElapsed) * 1000);
    bullP99 = bullPercentiles.p99;

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullP99);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Image Processing',
    category: 'real-world',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies.reduce((a, b) => a + b, 0) / bunLatencies.length, p99Ms: bunPercentiles.p99 },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: 0, p99Ms: bullP99 } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 4: E-commerce Order Processing
 * - Orders with different priorities
 * - Express orders processed first
 */
async function scenarioOrderProcessing(): Promise<void> {
  logScenario('E-commerce Orders (Priority)', 'real-world');
  const ORDERS = 5000;

  const bunQueue = new BunQueue('orders');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  for (let i = 0; i < ORDERS; i++) {
    const opStart = performance.now();
    const isExpress = i % 20 === 0; // 5% express
    const isPrime = i % 5 === 0; // 20% prime

    await bunQueue.add(
      'process-order',
      {
        orderId: `ORD-${i}`,
        items: Array.from({ length: Math.floor(Math.random() * 5) + 1 }, (_, j) => ({
          sku: `SKU-${j}`,
          qty: Math.floor(Math.random() * 3) + 1,
          price: Math.random() * 100,
        })),
        shipping: isExpress ? 'express' : isPrime ? 'prime' : 'standard',
        customer: { id: `CUST-${i % 1000}`, email: `user${i}@example.com` },
      },
      {
        priority: isExpress ? 100 : isPrime ? 50 : 1,
      }
    );
    bunLatencies.push(performance.now() - opStart);
  }

  const bunElapsed = performance.now() - bunStart;
  const bunPercentiles = calculatePercentiles(bunLatencies);
  const bunOps = Math.round((ORDERS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunPercentiles.p99);

  // BullMQ
  let bullOps = 0;
  let bullP99 = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('orders', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullLatencies: number[] = [];
    const bullStart = performance.now();

    for (let i = 0; i < ORDERS; i++) {
      const opStart = performance.now();
      const isExpress = i % 20 === 0;
      const isPrime = i % 5 === 0;

      await bullQueue.add(
        'process-order',
        {
          orderId: `ORD-${i}`,
          items: Array.from({ length: Math.floor(Math.random() * 5) + 1 }, (_, j) => ({
            sku: `SKU-${j}`,
            qty: Math.floor(Math.random() * 3) + 1,
            price: Math.random() * 100,
          })),
          shipping: isExpress ? 'express' : isPrime ? 'prime' : 'standard',
          customer: { id: `CUST-${i % 1000}`, email: `user${i}@example.com` },
        },
        {
          priority: isExpress ? 100 : isPrime ? 50 : 1,
        }
      );
      bullLatencies.push(performance.now() - opStart);
    }

    const bullElapsed = performance.now() - bullStart;
    const bullPercentiles = calculatePercentiles(bullLatencies);
    bullOps = Math.round((ORDERS / bullElapsed) * 1000);
    bullP99 = bullPercentiles.p99;

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullP99);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Order Processing',
    category: 'real-world',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies.reduce((a, b) => a + b, 0) / bunLatencies.length, p99Ms: bunPercentiles.p99 },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: 0, p99Ms: bullP99 } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

// ============================================================================
// NICHE SCENARIOS
// ============================================================================

/**
 * Scenario 5: Massive Delayed Jobs
 * - Schedule 10k jobs for future execution
 */
async function scenarioMassiveDelayed(): Promise<void> {
  logScenario('Massive Delayed Jobs (10k)', 'niche');
  const JOBS = 10000;

  const bunQueue = new BunQueue('delayed');
  await bunQueue.obliterate();

  const bunStart = performance.now();
  const jobs = Array.from({ length: JOBS }, (_, i) => ({
    name: 'scheduled',
    data: { id: i },
    opts: { delay: Math.floor(Math.random() * 86400000) }, // Random delay up to 24h
  }));
  await bunQueue.addBulk(jobs);

  const bunElapsed = performance.now() - bunStart;
  const bunOps = Math.round((JOBS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunElapsed);

  // BullMQ
  let bullOps = 0;
  let bullLatency = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('delayed', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullStart = performance.now();
    await bullQueue.addBulk(jobs);
    bullLatency = performance.now() - bullStart;
    bullOps = Math.round((JOBS / bullLatency) * 1000);

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullLatency);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Massive Delayed',
    category: 'niche',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunElapsed, p99Ms: bunElapsed },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: bullLatency, p99Ms: bullLatency } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 6: Priority Stress Test
 * - 100 different priority levels
 */
async function scenarioPriorityStress(): Promise<void> {
  logScenario('Priority Stress (100 levels)', 'niche');
  const JOBS = 5000;
  const PRIORITY_LEVELS = 100;

  const bunQueue = new BunQueue('priority-stress');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  for (let i = 0; i < JOBS; i++) {
    const opStart = performance.now();
    await bunQueue.add(
      'task',
      { id: i },
      { priority: i % PRIORITY_LEVELS }
    );
    bunLatencies.push(performance.now() - opStart);
  }

  const bunElapsed = performance.now() - bunStart;
  const bunPercentiles = calculatePercentiles(bunLatencies);
  const bunOps = Math.round((JOBS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunPercentiles.p99);

  // BullMQ
  let bullOps = 0;
  let bullP99 = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('priority-stress', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullLatencies: number[] = [];
    const bullStart = performance.now();

    for (let i = 0; i < JOBS; i++) {
      const opStart = performance.now();
      await bullQueue.add('task', { id: i }, { priority: i % PRIORITY_LEVELS });
      bullLatencies.push(performance.now() - opStart);
    }

    const bullElapsed = performance.now() - bullStart;
    const bullPercentiles = calculatePercentiles(bullLatencies);
    bullOps = Math.round((JOBS / bullElapsed) * 1000);
    bullP99 = bullPercentiles.p99;

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullP99);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Priority Stress',
    category: 'niche',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies.reduce((a, b) => a + b, 0) / bunLatencies.length, p99Ms: bunPercentiles.p99 },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: 0, p99Ms: bullP99 } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 7: Tiny Payloads (IoT sensors)
 * - Minimal job data, maximum throughput
 */
async function scenarioTinyPayloads(): Promise<void> {
  logScenario('Tiny Payloads (IoT)', 'niche');
  const JOBS = 50000;

  const bunQueue = new BunQueue('iot');
  await bunQueue.obliterate();

  const bunStart = performance.now();
  const jobs = Array.from({ length: JOBS }, (_, i) => ({
    name: 'sensor',
    data: { s: i, v: Math.random() }, // Minimal payload
  }));
  await bunQueue.addBulk(jobs);

  const bunElapsed = performance.now() - bunStart;
  const bunOps = Math.round((JOBS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunElapsed);

  // BullMQ
  let bullOps = 0;
  let bullLatency = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('iot', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullStart = performance.now();
    await bullQueue.addBulk(jobs);
    bullLatency = performance.now() - bullStart;
    bullOps = Math.round((JOBS / bullLatency) * 1000);

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullLatency);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Tiny Payloads (IoT)',
    category: 'niche',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunElapsed, p99Ms: bunElapsed },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: bullLatency, p99Ms: bullLatency } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 8: Unique Jobs Deduplication
 * - Many jobs with duplicate keys
 */
async function scenarioDeduplication(): Promise<void> {
  logScenario('Deduplication (unique keys)', 'niche');
  const JOBS = 5000;
  const UNIQUE_KEYS = 1000; // Only 1000 unique keys for 5000 jobs

  const bunQueue = new BunQueue('dedup');
  await bunQueue.obliterate();

  const bunLatencies: number[] = [];
  const bunStart = performance.now();

  for (let i = 0; i < JOBS; i++) {
    const opStart = performance.now();
    try {
      await bunQueue.add(
        'task',
        { id: i },
        { jobId: `unique-${i % UNIQUE_KEYS}` }
      );
    } catch {
      // Expected: duplicate job rejection
    }
    bunLatencies.push(performance.now() - opStart);
  }

  const bunElapsed = performance.now() - bunStart;
  const bunPercentiles = calculatePercentiles(bunLatencies);
  const bunOps = Math.round((JOBS / bunElapsed) * 1000);

  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunPercentiles.p99);

  // BullMQ
  let bullOps = 0;
  let bullP99 = 0;
  try {
    const { Queue } = await import('bullmq');
    const bullQueue = new Queue('dedup', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    const bullLatencies: number[] = [];
    const bullStart = performance.now();

    for (let i = 0; i < JOBS; i++) {
      const opStart = performance.now();
      try {
        await bullQueue.add('task', { id: i }, { jobId: `unique-${i % UNIQUE_KEYS}` });
      } catch {
        // Expected: duplicate job rejection
      }
      bullLatencies.push(performance.now() - opStart);
    }

    const bullElapsed = performance.now() - bullStart;
    const bullPercentiles = calculatePercentiles(bullLatencies);
    bullOps = Math.round((JOBS / bullElapsed) * 1000);
    bullP99 = bullPercentiles.p99;

    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullP99);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'Deduplication',
    category: 'niche',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunLatencies.reduce((a, b) => a + b, 0) / bunLatencies.length, p99Ms: bunPercentiles.p99 },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: 0, p99Ms: bullP99 } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

/**
 * Scenario 9: High Concurrency Processing
 * - 50 concurrent workers
 */
async function scenarioHighConcurrency(): Promise<void> {
  logScenario('High Concurrency (50 workers)', 'niche');
  const JOBS = 10000;
  const CONCURRENCY = 50;

  const bunQueue = new BunQueue('high-concurrency');
  await bunQueue.obliterate();

  // Add jobs first
  const jobs = Array.from({ length: JOBS }, (_, i) => ({
    name: 'work',
    data: { id: i },
  }));
  await bunQueue.addBulk(jobs);

  let processed = 0;
  const bunStart = performance.now();

  const worker = new BunWorker(
    'high-concurrency',
    async () => {
      processed++;
      // Simulate minimal work
      return { ok: true };
    },
    { concurrency: CONCURRENCY }
  );

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (processed >= JOBS) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  const bunElapsed = performance.now() - bunStart;
  const bunOps = Math.round((JOBS / bunElapsed) * 1000);

  await worker.close();
  await bunQueue.obliterate();
  logResult('bunqueue', bunOps, bunElapsed);

  // BullMQ
  let bullOps = 0;
  let bullLatency = 0;
  try {
    const { Queue, Worker } = await import('bullmq');
    const bullQueue = new Queue('high-concurrency', { connection: { host: 'localhost', port: 6379 } });
    await bullQueue.obliterate({ force: true });

    await bullQueue.addBulk(jobs);

    let bullProcessed = 0;
    const bullStart = performance.now();

    const bullWorker = new Worker(
      'high-concurrency',
      async () => {
        bullProcessed++;
        return { ok: true };
      },
      { connection: { host: 'localhost', port: 6379 }, concurrency: CONCURRENCY }
    );

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (bullProcessed >= JOBS) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    bullLatency = performance.now() - bullStart;
    bullOps = Math.round((JOBS / bullLatency) * 1000);

    await bullWorker.close();
    await bullQueue.obliterate({ force: true });
    await bullQueue.close();
    logResult('bullmq', bullOps, bullLatency);
  } catch {
    log(`  ${c.dim}BullMQ skipped${c.reset}`);
  }

  results.push({
    scenario: 'High Concurrency',
    category: 'niche',
    bunqueue: { opsPerSec: bunOps, avgLatencyMs: bunElapsed, p99Ms: bunElapsed },
    bullmq: bullOps ? { opsPerSec: bullOps, avgLatencyMs: bullLatency, p99Ms: bullLatency } : null,
    speedup: bullOps ? Math.round((bunOps / bullOps) * 10) / 10 : null,
  });

  if (bullOps) log(`  ${c.green}bunqueue ${(bunOps / bullOps).toFixed(1)}x faster${c.reset}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`
${c.magenta}   (\\(\\        ${c.reset}
${c.magenta}   ( -.-)      ${c.bold}Scenario Benchmarks${c.reset}
${c.magenta}   o_(")(")    ${c.reset}${c.dim}Real-world & Niche${c.reset}
`);

  // Real-world scenarios
  await scenarioEmailQueue();
  await scenarioWebhookDelivery();
  await scenarioImageProcessing();
  await scenarioOrderProcessing();

  // Niche scenarios
  await scenarioMassiveDelayed();
  await scenarioPriorityStress();
  await scenarioTinyPayloads();
  await scenarioDeduplication();
  await scenarioHighConcurrency();

  // Summary
  console.log(`\n${c.cyan}━━━ Summary ━━━${c.reset}\n`);

  console.log(`${c.bold}Real-World Scenarios:${c.reset}`);
  for (const r of results.filter((r) => r.category === 'real-world')) {
    const speedup = r.speedup ? `${c.green}${r.speedup}x faster${c.reset}` : c.dim + 'N/A' + c.reset;
    console.log(`  ${r.scenario.padEnd(25)} ${speedup}`);
  }

  console.log(`\n${c.bold}Niche Scenarios:${c.reset}`);
  for (const r of results.filter((r) => r.category === 'niche')) {
    const speedup = r.speedup ? `${c.green}${r.speedup}x faster${c.reset}` : c.dim + 'N/A' + c.reset;
    console.log(`  ${r.scenario.padEnd(25)} ${speedup}`);
  }

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    hardware: getHardwareInfo(),
    scenarios: results,
  };

  await Bun.write('./bench/comparison/scenarios-results.json', JSON.stringify(output, null, 2));
  console.log(`\n${c.dim}Results saved to ./bench/comparison/scenarios-results.json${c.reset}`);
}

main().catch(console.error);
