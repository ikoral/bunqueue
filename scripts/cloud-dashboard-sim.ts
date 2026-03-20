#!/usr/bin/env bun
/**
 * Cloud Dashboard Simulation — AGGRESSIVE
 * 8 queues, 40 workers, high throughput, delayed jobs, varied errors
 * Runs for 30 minutes generating heavy traffic for the dashboard.
 */

import { Queue, Worker } from '../src/client';

const TCP_PORT = parseInt(process.env.TCP_PORT ?? '6789');
const DURATION_MS = 12 * 60 * 60 * 1000;
const PUSH_INTERVAL_MS = 500; // push every 500ms

const TCP_OPTS = { port: TCP_PORT, commandTimeout: 60000, pingInterval: 0 };

const QUEUES = [
  { name: 'emails',        pushRate: 10, errorRate: 0.03, minMs: 50,   maxMs: 400,  concurrency: 5, workers: 3 },
  { name: 'payments',      pushRate: 8,  errorRate: 0.07, minMs: 100,  maxMs: 600,  concurrency: 4, workers: 3 },
  { name: 'notifications', pushRate: 15, errorRate: 0.02, minMs: 20,   maxMs: 150,  concurrency: 5, workers: 3 },
  { name: 'reports',       pushRate: 4,  errorRate: 0.05, minMs: 300,  maxMs: 1500, concurrency: 3, workers: 2 },
  { name: 'image-resize',  pushRate: 6,  errorRate: 0.06, minMs: 200,  maxMs: 1000, concurrency: 4, workers: 3 },
  { name: 'webhooks',      pushRate: 12, errorRate: 0.10, minMs: 30,   maxMs: 300,  concurrency: 5, workers: 3 },
  { name: 'analytics',     pushRate: 8,  errorRate: 0.02, minMs: 50,   maxMs: 400,  concurrency: 4, workers: 3 },
  { name: 'exports',       pushRate: 3,  errorRate: 0.08, minMs: 500,  maxMs: 2000, concurrency: 3, workers: 2 },
];

const ERRORS = [
  'Connection refused',
  'Timeout after 30000ms',
  'Rate limit exceeded (429)',
  'Internal server error (500)',
  'Invalid payload: missing required field "email"',
  'S3 upload failed: bucket not found',
  'SMTP relay error: authentication failed',
  'Database deadlock detected',
  'Out of memory',
  'DNS resolution failed',
];

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const queues: Queue[] = [];
const workers: Worker[] = [];
let totalPushed = 0;
let totalCompleted = 0;
let totalFailed = 0;
const startTime = Date.now();

async function main() {
  const totalRate = QUEUES.reduce((s, q) => s + q.pushRate, 0);
  const totalWorkers = QUEUES.reduce((s, q) => s + q.workers, 0);
  console.log(`=== Cloud Dashboard Simulation — AGGRESSIVE ===`);
  console.log(`8 queues | ${totalWorkers} workers | 12h | ~${totalRate * 2} jobs/s\n`);

  for (const q of QUEUES) {
    queues.push(new Queue(q.name, { connection: TCP_OPTS }));
  }

  // --- Cron jobs ---
  const CRONS = [
    { id: 'daily-cleanup',       queue: 'reports',       pattern: '0 3 * * *',    data: { task: 'cleanup', target: 'old-reports' } },
    { id: 'health-check',        queue: 'notifications', pattern: '*/2 * * * *',  data: { task: 'health-check', services: ['db', 'redis', 'api'] } },
    { id: 'hourly-digest',       queue: 'emails',        pattern: '0 * * * *',    data: { task: 'digest', type: 'hourly-summary' } },
    { id: 'invoice-generation',  queue: 'payments',      pattern: '0 9 * * 1-5',  data: { task: 'generate-invoices', currency: 'EUR' } },
    { id: 'image-cache-purge',   queue: 'image-resize',  pattern: '30 4 * * *',   data: { task: 'purge-cache', olderThanDays: 7 } },
    { id: 'webhook-retry-sweep', queue: 'webhooks',      pattern: '*/15 * * * *', data: { task: 'retry-failed-webhooks', maxRetries: 5 } },
    { id: 'analytics-rollup',    queue: 'analytics',     pattern: '0 */6 * * *',  data: { task: 'rollup', granularity: '1h' } },
    { id: 'export-stale-check',  queue: 'exports',       pattern: '*/30 * * * *', data: { task: 'check-stale-exports', maxAgeMins: 60 } },
    { id: 'nightly-backup',      queue: 'reports',       pattern: '0 2 * * *',    data: { task: 'backup', destination: 's3://bunqueue-backups' } },
    { id: 'payment-reconcile',   queue: 'payments',      pattern: '0 0 * * *',    data: { task: 'reconcile', provider: 'stripe' } },
  ];

  const cronQueue = queues[0]; // use first queue's connection for cron setup
  for (const cron of CRONS) {
    const targetQueue = queues.find((_, i) => QUEUES[i].name === cron.queue) ?? cronQueue;
    try {
      await targetQueue.upsertJobScheduler(cron.id, { pattern: cron.pattern }, { name: cron.id, data: cron.data });
      console.log(`  cron: ${cron.id} → ${cron.queue} (${cron.pattern})`);
    } catch (e) {
      console.error(`  cron FAIL: ${cron.id}`, (e as Error).message);
    }
  }
  console.log(`${CRONS.length} cron jobs registered\n`);

  for (const q of QUEUES) {
    for (let w = 0; w < q.workers; w++) {
      const worker = new Worker(
        q.name,
        async (job) => {
          const processingTime = q.minMs + Math.random() * (q.maxMs - q.minMs);
          await Bun.sleep(processingTime);

          if (Math.random() < q.errorRate) {
            throw new Error(ERRORS[Math.floor(Math.random() * ERRORS.length)]);
          }

          if (processingTime > 1000) {
            try {
              await job.updateProgress(50);
              await Bun.sleep(processingTime * 0.1);
              await job.updateProgress(100);
            } catch {}
          }

          return { ok: true, ms: Math.round(processingTime) };
        },
        {
          concurrency: q.concurrency,
          connection: TCP_OPTS,
          heartbeatInterval: 0,
          useLocks: false,
        },
      );

      worker.on('completed', () => { totalCompleted++; });
      worker.on('failed', () => { totalFailed++; });
      worker.on('error', () => {});
      workers.push(worker);
    }
  }

  const pushTimer = setInterval(async () => {
    for (let i = 0; i < QUEUES.length; i++) {
      const q = QUEUES[i];
      const queue = queues[i];
      const batch: { name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }[] = [];

      for (let j = 0; j < q.pushRate; j++) {
        const isDelayed = Math.random() < 0.12;
        batch.push({
          name: `${q.name}-${Date.now()}-${j}`,
          data: {
            type: q.name,
            payload: { id: Math.random().toString(36).slice(2, 10) },
            ts: Date.now(),
          },
          opts: {
            priority: Math.floor(Math.random() * 10),
            ...(isDelayed ? { delay: 1000 + Math.floor(Math.random() * 5000) } : {}),
          },
        });
      }

      try {
        await queue.addBulk(batch);
        totalPushed += batch.length;
      } catch {}
    }
  }, PUSH_INTERVAL_MS);

  const statusTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate = Math.round(totalPushed / elapsed);
    console.log(`[${elapsed}s] pushed=${totalPushed} (${rate}/s) completed=${totalCompleted} failed=${totalFailed}`);
  }, 60_000);

  await Bun.sleep(DURATION_MS);

  console.log('Draining...');
  clearInterval(pushTimer);
  await Bun.sleep(15_000);

  clearInterval(statusTimer);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`[${elapsed}s] pushed=${totalPushed} (${Math.round(totalPushed / elapsed)}/s) completed=${totalCompleted} failed=${totalFailed}`);
  console.log(`DONE — pushed=${totalPushed} completed=${totalCompleted} failed=${totalFailed}`);

  for (const w of workers) try { await w.close(); } catch {}
  for (const q of queues) try { q.obliterate(); } catch {}
  await Bun.sleep(500);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
