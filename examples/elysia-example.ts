/**
 * Elysia + bunqueue Example
 *
 * Real-world example: REST API with background job processing
 *
 * Features tested:
 * 1. Job creation via API
 * 2. Job status checking
 * 3. Priority queues
 * 4. Delayed jobs
 * 5. Progress tracking
 * 6. DLQ monitoring
 * 7. Graceful shutdown
 */

import { Elysia } from 'elysia';
import { mkdirSync } from 'fs';

// Setup persistence BEFORE importing bunqueue
mkdirSync('./data', { recursive: true });
process.env.DATA_PATH = './data/elysia-demo.db';

import { Queue, Worker, shutdownManager } from '../src/client/index';

// ============================================
// Job Types
// ============================================

interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

interface ReportJob {
  type: 'daily' | 'weekly' | 'monthly';
  userId: string;
}

interface WebhookJob {
  url: string;
  payload: Record<string, unknown>;
  retries?: number;
}

// ============================================
// Queues (Embedded Mode)
// ============================================

const emailQueue = new Queue<EmailJob>('emails', {
  embedded: true,
  defaultJobOptions: {
    attempts: 3,
    backoff: 1000,
  }
});

const reportQueue = new Queue<ReportJob>('reports', {
  embedded: true,
  defaultJobOptions: {
    attempts: 2,
    timeout: 60000,
  }
});

const webhookQueue = new Queue<WebhookJob>('webhooks', {
  embedded: true,
  defaultJobOptions: {
    attempts: 5,
    backoff: 2000,
  }
});

// Configure DLQ for webhooks (they fail often)
webhookQueue.setDlqConfig({
  autoRetry: true,
  autoRetryInterval: 300000, // 5 minutes
  maxAutoRetries: 3,
});

// ============================================
// Workers
// ============================================

const emailWorker = new Worker<EmailJob>('emails', async (job) => {
  await job.updateProgress(10, 'Validating email...');

  // Simulate email validation
  if (!job.data.to.includes('@')) {
    throw new Error('Invalid email address');
  }

  await job.updateProgress(50, 'Sending email...');
  await job.log(`Sending to: ${job.data.to}`);

  // Simulate sending (random delay)
  await new Promise(r => setTimeout(r, Math.random() * 500 + 100));

  await job.updateProgress(100, 'Sent!');
  return {
    messageId: `msg-${Date.now()}`,
    sentAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 3 });

const reportWorker = new Worker<ReportJob>('reports', async (job) => {
  await job.log(`Generating ${job.data.type} report for user ${job.data.userId}`);

  // Simulate report generation with progress
  for (let i = 0; i <= 100; i += 20) {
    await job.updateProgress(i, `Processing data... ${i}%`);
    await new Promise(r => setTimeout(r, 100));
  }

  return {
    reportUrl: `/reports/${job.data.type}-${job.data.userId}-${Date.now()}.pdf`,
    generatedAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 2 });

const webhookWorker = new Worker<WebhookJob>('webhooks', async (job) => {
  await job.log(`Calling webhook: ${job.data.url}`);

  // Simulate webhook call (30% failure rate for testing)
  if (Math.random() < 0.3) {
    throw new Error('Webhook endpoint unavailable');
  }

  await new Promise(r => setTimeout(r, 200));

  return {
    status: 200,
    deliveredAt: new Date().toISOString(),
  };
}, { embedded: true, concurrency: 5 });

// ============================================
// Event Logging
// ============================================

emailWorker.on('completed', (job, result) => {
  console.log(`📧 Email sent: ${job.data.to} → ${result.messageId}`);
});

emailWorker.on('failed', (job, err) => {
  console.log(`❌ Email failed: ${job.data.to} → ${err.message}`);
});

reportWorker.on('completed', (job, result) => {
  console.log(`📊 Report ready: ${result.reportUrl}`);
});

webhookWorker.on('failed', (job, err) => {
  console.log(`🔗 Webhook failed: ${job.data.url} → ${err.message}`);
});

// ============================================
// Elysia API
// ============================================

const app = new Elysia()

  // Health check
  .get('/health', () => ({
    status: 'ok',
    queues: {
      emails: emailQueue.getJobCounts(),
      reports: reportQueue.getJobCounts(),
      webhooks: webhookQueue.getJobCounts(),
    },
  }))

  // ---- Email Jobs ----

  .post('/emails', async ({ body }) => {
    const { to, subject, body: content } = body as EmailJob;
    const job = await emailQueue.add('send', { to, subject, body: content });
    return { jobId: job.id, status: 'queued' };
  })

  .post('/emails/priority', async ({ body }) => {
    const { to, subject, body: content } = body as EmailJob;
    const job = await emailQueue.add('send-priority', { to, subject, body: content }, {
      priority: 10, // High priority
    });
    return { jobId: job.id, status: 'queued', priority: 'high' };
  })

  .post('/emails/scheduled', async ({ body }) => {
    const { to, subject, body: content, delayMs } = body as EmailJob & { delayMs: number };
    const job = await emailQueue.add('send-scheduled', { to, subject, body: content }, {
      delay: delayMs || 5000,
    });
    return {
      jobId: job.id,
      status: 'scheduled',
      willRunAt: new Date(Date.now() + (delayMs || 5000)).toISOString(),
    };
  })

  // ---- Report Jobs ----

  .post('/reports', async ({ body }) => {
    const { type, userId } = body as ReportJob;
    const job = await reportQueue.add(`generate-${type}`, { type, userId });
    return { jobId: job.id, status: 'queued' };
  })

  // ---- Webhook Jobs ----

  .post('/webhooks', async ({ body }) => {
    const { url, payload } = body as WebhookJob;
    const job = await webhookQueue.add('deliver', { url, payload });
    return { jobId: job.id, status: 'queued' };
  })

  .post('/webhooks/bulk', async ({ body }) => {
    const { webhooks } = body as { webhooks: WebhookJob[] };
    const jobs = await webhookQueue.addBulk(
      webhooks.map(w => ({ name: 'deliver', data: w }))
    );
    return {
      jobIds: jobs.map(j => j.id),
      count: jobs.length,
      status: 'queued',
    };
  })

  // ---- Job Status ----

  .get('/jobs/:queue/:id', async ({ params }) => {
    const { queue, id } = params;

    let q: Queue<unknown>;
    switch (queue) {
      case 'emails': q = emailQueue; break;
      case 'reports': q = reportQueue; break;
      case 'webhooks': q = webhookQueue; break;
      default: return { error: 'Unknown queue' };
    }

    const job = await q.getJob(id);
    if (!job) return { error: 'Job not found' };

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
    };
  })

  // ---- DLQ Monitoring ----

  .get('/dlq/:queue', ({ params }) => {
    const { queue } = params;

    let q: Queue<unknown>;
    switch (queue) {
      case 'emails': q = emailQueue; break;
      case 'reports': q = reportQueue; break;
      case 'webhooks': q = webhookQueue; break;
      default: return { error: 'Unknown queue' };
    }

    const entries = q.getDlq();
    const stats = q.getDlqStats();

    return {
      stats,
      entries: entries.slice(0, 10).map(e => ({
        jobId: e.job.id,
        reason: e.reason,
        error: e.error,
        attempts: e.attempts.length,
        enteredAt: new Date(e.enteredAt).toISOString(),
      })),
    };
  })

  .post('/dlq/:queue/retry', ({ params }) => {
    const { queue } = params;

    let q: Queue<unknown>;
    switch (queue) {
      case 'emails': q = emailQueue; break;
      case 'reports': q = reportQueue; break;
      case 'webhooks': q = webhookQueue; break;
      default: return { error: 'Unknown queue' };
    }

    const count = q.retryDlq();
    return { retriedCount: count };
  })

  // ---- Queue Control ----

  .post('/queues/:queue/pause', ({ params }) => {
    const { queue } = params;
    switch (queue) {
      case 'emails': emailQueue.pause(); break;
      case 'reports': reportQueue.pause(); break;
      case 'webhooks': webhookQueue.pause(); break;
      default: return { error: 'Unknown queue' };
    }
    return { status: 'paused', queue };
  })

  .post('/queues/:queue/resume', ({ params }) => {
    const { queue } = params;
    switch (queue) {
      case 'emails': emailQueue.resume(); break;
      case 'reports': reportQueue.resume(); break;
      case 'webhooks': webhookQueue.resume(); break;
      default: return { error: 'Unknown queue' };
    }
    return { status: 'resumed', queue };
  });

// ============================================
// Graceful Shutdown
// ============================================

async function shutdown() {
  console.log('\n🛑 Shutting down...');

  await Promise.all([
    emailWorker.close(),
    reportWorker.close(),
    webhookWorker.close(),
  ]);

  shutdownManager();
  console.log('✓ Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================
// Start Server
// ============================================

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         Elysia + bunqueue Demo Server                ║
╠═══════════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}                    ║
║  Mode:      Embedded (SQLite persistence)             ║
║  Database:  ./data/elysia-demo.db                     ║
╠═══════════════════════════════════════════════════════╣
║  Queues:                                              ║
║    • emails   (concurrency: 3)                        ║
║    • reports  (concurrency: 2)                        ║
║    • webhooks (concurrency: 5, auto-retry DLQ)        ║
╠═══════════════════════════════════════════════════════╣
║  Endpoints:                                           ║
║    GET  /health              - Queue stats            ║
║    POST /emails              - Send email             ║
║    POST /emails/priority     - High priority email    ║
║    POST /emails/scheduled    - Delayed email          ║
║    POST /reports             - Generate report        ║
║    POST /webhooks            - Send webhook           ║
║    POST /webhooks/bulk       - Bulk webhooks          ║
║    GET  /jobs/:queue/:id     - Job status             ║
║    GET  /dlq/:queue          - DLQ entries            ║
║    POST /dlq/:queue/retry    - Retry DLQ              ║
║    POST /queues/:queue/pause - Pause queue            ║
║    POST /queues/:queue/resume- Resume queue           ║
╚═══════════════════════════════════════════════════════╝
  `);
});

export { app };
