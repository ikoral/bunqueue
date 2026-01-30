---
title: Framework Integrations
description: Integrate bunqueue with Hono and Elysia
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/integrations.png
---

Integrate bunqueue seamlessly with modern Bun-native frameworks.

## Hono

[Hono](https://hono.dev) is an ultrafast web framework for the Edge. Here's how to integrate bunqueue.

### Setup

```typescript
import { Hono } from 'hono';
import { Queue, Worker } from 'bunqueue/client';

const app = new Hono();

// Initialize queues
const emailQueue = new Queue('emails');
const notificationQueue = new Queue('notifications');
```

### API Routes

```typescript
// Add job endpoint
app.post('/api/jobs/:queue', async (c) => {
  const queueName = c.req.param('queue');
  const body = await c.req.json();

  const queue = new Queue(queueName);
  const job = await queue.add(body.name, body.data, body.opts);

  return c.json({
    success: true,
    jobId: job.id
  });
});

// Get job status
app.get('/api/jobs/:queue/:id', async (c) => {
  const { queue: queueName, id } = c.req.param();

  const queue = new Queue(queueName);
  const job = await queue.getJob(id);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json({
    id: job.id,
    name: job.name,
    progress: job.progress,
    data: job.data,
    result: job.returnvalue,
    error: job.failedReason,
  });
});

// Queue stats
app.get('/api/queues/:name/stats', async (c) => {
  const queueName = c.req.param('name');
  const queue = new Queue(queueName);

  const counts = queue.getJobCounts(); // Synchronous
  return c.json(counts);
});
```

### Background Workers

```typescript
// workers.ts - Run separately or in the same process
import { Worker } from 'bunqueue/client';

const emailWorker = new Worker('emails', async (job) => {
  const { to, subject, body } = job.data;

  await job.updateProgress(10, 'Preparing email');

  // Send email logic
  await sendEmail({ to, subject, body });

  await job.updateProgress(100, 'Email sent');
  return { sent: true, timestamp: Date.now() };
});

emailWorker.on('completed', (job, result) => {
  console.log(`Email sent: ${job.id}`);
});

emailWorker.on('failed', (job, error) => {
  console.error(`Email failed: ${job.id}`, error.message);
});
```

### Complete Example

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { Queue, Worker } from 'bunqueue/client';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('/api/*', cors());

// Queues
const queues = {
  emails: new Queue('emails'),
  reports: new Queue('reports'),
  webhooks: new Queue('webhooks'),
};

// Enqueue job
app.post('/api/send-email', async (c) => {
  const { to, subject, template, data } = await c.req.json();

  const job = await queues.emails.add('send', {
    to,
    subject,
    template,
    data,
  }, {
    attempts: 3,
    backoff: 5000,
    removeOnComplete: true,
  });

  return c.json({ queued: true, jobId: job.id });
});

// Generate report (long-running task)
app.post('/api/reports/generate', async (c) => {
  const { type, filters, format } = await c.req.json();

  const job = await queues.reports.add('generate', {
    type,
    filters,
    format,
    requestedBy: c.req.header('X-User-ID'),
  }, {
    timeout: 300000, // 5 minutes
    priority: 10,
  });

  return c.json({
    jobId: job.id,
    statusUrl: `/api/jobs/reports/${job.id}`,
  });
});

// Poll job status
app.get('/api/jobs/:queue/:id/poll', async (c) => {
  const { queue: queueName, id } = c.req.param();
  const queue = new Queue(queueName);
  const job = await queue.getJob(id);

  if (!job) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({
    id: job.id,
    name: job.name,
    progress: job.progress,
    result: job.returnvalue ?? null,
    error: job.failedReason ?? null,
  });
});

export default app;
```

---

## Elysia

[Elysia](https://elysiajs.com) is an ergonomic framework for building backend servers. Here's the bunqueue integration.

### Setup

```typescript
import { Elysia } from 'elysia';
import { Queue, Worker } from 'bunqueue/client';

const app = new Elysia();

// Create typed queues
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const emailQueue = new Queue<EmailJob>('emails');
```

### Plugin Pattern

```typescript
// plugins/queue.ts
import { Elysia } from 'elysia';
import { Queue } from 'bunqueue/client';

export const queuePlugin = new Elysia({ name: 'queue' })
  .decorate('queues', {
    emails: new Queue('emails'),
    notifications: new Queue('notifications'),
    analytics: new Queue('analytics'),
  })
  .derive(({ queues }) => ({
    enqueue: async (queue: keyof typeof queues, name: string, data: any, opts?: any) => {
      return queues[queue].add(name, data, opts);
    },
  }));
```

### API Routes with Validation

```typescript
import { Elysia, t } from 'elysia';
import { queuePlugin } from './plugins/queue';

const app = new Elysia()
  .use(queuePlugin)
  .post('/api/emails/send', async ({ body, enqueue }) => {
    const job = await enqueue('emails', 'send', body, {
      attempts: 3,
      backoff: 5000,
    });

    return {
      success: true,
      jobId: job.id,
    };
  }, {
    body: t.Object({
      to: t.String({ format: 'email' }),
      subject: t.String({ minLength: 1 }),
      body: t.String(),
      priority: t.Optional(t.Number()),
    }),
  })
  .get('/api/jobs/:queue/:id', async ({ params, queues }) => {
    const queue = queues[params.queue as keyof typeof queues];
    if (!queue) {
      return { error: 'Queue not found' };
    }

    const job = await queue.getJob(params.id);
    if (!job) {
      return { error: 'Job not found' };
    }

    return {
      id: job.id,
      name: job.name,
      progress: job.progress,
      data: job.data,
      result: job.returnvalue,
      error: job.failedReason,
    };
  }, {
    params: t.Object({
      queue: t.String(),
      id: t.String(),
    }),
  });
```

### WebSocket Progress Updates

```typescript
import { Elysia } from 'elysia';
import { Queue, QueueEvents } from 'bunqueue/client';

const app = new Elysia()
  .ws('/ws/jobs/:jobId', {
    open(ws) {
      const { jobId } = ws.data.params;
      const events = new QueueEvents('emails'); // Subscribe to specific queue

      events.on('progress', ({ jobId: id, data }) => {
        if (id === jobId) {
          ws.send(JSON.stringify({ type: 'progress', progress: data }));
        }
      });

      events.on('completed', ({ jobId: id, returnvalue }) => {
        if (id === jobId) {
          ws.send(JSON.stringify({ type: 'completed', result: returnvalue }));
          ws.close();
        }
      });

      events.on('failed', ({ jobId: id, failedReason }) => {
        if (id === jobId) {
          ws.send(JSON.stringify({ type: 'failed', error: failedReason }));
          ws.close();
        }
      });

      // Store for cleanup
      ws.data.events = events;
    },
    close(ws) {
      ws.data.events?.close();
    },
  });
```

### Complete Example

```typescript
import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Queue, Worker, QueueEvents } from 'bunqueue/client';

// Types
interface EmailJob {
  to: string;
  subject: string;
  template: string;
  data: Record<string, any>;
}

interface ReportJob {
  type: 'sales' | 'users' | 'analytics';
  dateRange: { start: string; end: string };
  format: 'pdf' | 'csv' | 'xlsx';
}

// Queues
const emailQueue = new Queue<EmailJob>('emails');
const reportQueue = new Queue<ReportJob>('reports');

// App
const app = new Elysia()
  .use(cors())
  .use(swagger({
    documentation: {
      info: {
        title: 'Job Queue API',
        version: '1.0.0',
      },
    },
  }))

  // Email endpoints
  .group('/api/emails', (app) =>
    app
      .post('/send', async ({ body }) => {
        const job = await emailQueue.add('send', body, {
          attempts: 3,
          backoff: 5000,
          removeOnComplete: 100,
        });
        return { jobId: job.id };
      }, {
        body: t.Object({
          to: t.String({ format: 'email' }),
          subject: t.String(),
          template: t.String(),
          data: t.Record(t.String(), t.Any()),
        }),
      })
      .post('/bulk', async ({ body }) => {
        const jobs = await emailQueue.addBulk(
          body.recipients.map((to) => ({
            name: 'send',
            data: { ...body.email, to },
          }))
        );
        return { queued: jobs.length };
      }, {
        body: t.Object({
          recipients: t.Array(t.String({ format: 'email' })),
          email: t.Object({
            subject: t.String(),
            template: t.String(),
            data: t.Record(t.String(), t.Any()),
          }),
        }),
      })
  )

  // Report endpoints
  .group('/api/reports', (app) =>
    app
      .post('/generate', async ({ body }) => {
        const job = await reportQueue.add('generate', body, {
          timeout: 300000,
          priority: body.priority || 0,
        });
        return {
          jobId: job.id,
          estimatedTime: '2-5 minutes',
        };
      }, {
        body: t.Object({
          type: t.Union([
            t.Literal('sales'),
            t.Literal('users'),
            t.Literal('analytics'),
          ]),
          dateRange: t.Object({
            start: t.String(),
            end: t.String(),
          }),
          format: t.Union([
            t.Literal('pdf'),
            t.Literal('csv'),
            t.Literal('xlsx'),
          ]),
          priority: t.Optional(t.Number()),
        }),
      })
  )

  // Job status
  .get('/api/jobs/:id', async ({ params }) => {
    // Check both queues
    let job = await emailQueue.getJob(params.id);
    if (!job) job = await reportQueue.getJob(params.id);

    if (!job) {
      return { error: 'Job not found' };
    }

    return {
      id: job.id,
      name: job.name,
      queue: job.queueName,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      createdAt: job.timestamp,
      result: job.returnvalue,
      error: job.failedReason,
    };
  }, {
    params: t.Object({
      id: t.String(),
    }),
  })

  // Queue stats (getJobCounts is synchronous)
  .get('/api/stats', async () => {
    return {
      emails: emailQueue.getJobCounts(),
      reports: reportQueue.getJobCounts(),
      timestamp: Date.now(),
    };
  })

  .listen(3000);

console.log(`🦊 Elysia running at ${app.server?.url}`);

// Workers (same file or separate)
const emailWorker = new Worker<EmailJob>('emails', async (job) => {
  await job.updateProgress(10, 'Loading template');
  // ... send email
  await job.updateProgress(100, 'Sent');
  return { sent: true };
});

const reportWorker = new Worker<ReportJob>('reports', async (job) => {
  await job.updateProgress(0, 'Starting report generation');
  // ... generate report
  await job.updateProgress(100, 'Report ready');
  return { url: `/reports/${job.id}.${job.data.format}` };
});
```

---

## Best Practices

### Separation of Concerns

```
src/
├── api/
│   ├── routes/
│   │   ├── emails.ts
│   │   └── reports.ts
│   └── index.ts
├── queues/
│   ├── definitions.ts    # Queue instances
│   └── index.ts
├── workers/
│   ├── email.worker.ts
│   ├── report.worker.ts
│   └── index.ts
└── index.ts              # Entry point
```

### Queue Definitions

```typescript
// queues/definitions.ts
import { Queue } from 'bunqueue/client';

export const queues = {
  emails: new Queue('emails', {
    defaultJobOptions: {
      attempts: 3,
      backoff: 5000,
      removeOnComplete: 100,
    },
  }),
  reports: new Queue('reports', {
    defaultJobOptions: {
      timeout: 300000,
    },
  }),
  notifications: new Queue('notifications', {
    defaultJobOptions: {
      attempts: 5,
      backoff: 1000,
    },
  }),
} as const;

export type QueueName = keyof typeof queues;
```

### Graceful Shutdown

```typescript
import { queues } from './queues';
import { workers } from './workers';

async function shutdown() {
  console.log('Shutting down...');

  // Stop accepting new jobs
  for (const worker of Object.values(workers)) {
    worker.pause();
  }

  // Wait for active jobs to complete
  await Promise.all(
    Object.values(workers).map((w) => w.close())
  );

  // Close queue connections
  await Promise.all(
    Object.values(queues).map((q) => q.close())
  );

  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```
