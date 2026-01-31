---
title: Quick Start
description: Get up and running in 5 minutes
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/getting-started.png
---


This guide will get you up and running with bunqueue in 5 minutes.

:::caution[Important]
Both `Queue` and `Worker` **must** have `embedded: true` to use embedded mode.
Without it, they default to TCP mode and try to connect to a bunqueue server.
:::

## Create a Queue

```typescript
import { Queue } from 'bunqueue/client';

// Create a typed queue
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const emailQueue = new Queue<EmailJob>('emails', { embedded: true });
```

## Add Jobs

```typescript
// Add a single job
const job = await emailQueue.add('send-email', {
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up.'
});

console.log(`Job created: ${job.id}`);

// Add with options
await emailQueue.add('send-email', data, {
  priority: 10,        // Higher = processed first
  delay: 5000,         // Wait 5 seconds before processing
  attempts: 3,         // Retry up to 3 times
  backoff: 1000,       // Wait 1 second between retries
});

// Add multiple jobs (batch optimized)
await emailQueue.addBulk([
  { name: 'send-email', data: { to: 'a@test.com', subject: 'Hi', body: '...' } },
  { name: 'send-email', data: { to: 'b@test.com', subject: 'Hi', body: '...' } },
]);
```

## Create a Worker

```typescript
import { Worker } from 'bunqueue/client';

const worker = new Worker<EmailJob>('emails', async (job) => {
  console.log(`Processing: ${job.name}`);

  // Update progress
  await job.updateProgress(50, 'Sending email...');

  // Do the work
  await sendEmail(job.data);

  // Log messages
  await job.log('Email sent successfully');

  // Return a result
  return { sent: true, timestamp: Date.now() };
}, {
  embedded: true,  // Required for embedded mode
  concurrency: 5,  // Process 5 jobs in parallel
});
```

## Handle Events

```typescript
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});

worker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});

worker.on('active', (job) => {
  console.log(`Job ${job.id} started`);
});
```

## Full Example

```typescript
import { Queue, Worker, shutdownManager } from 'bunqueue/client';

interface EmailJob {
  to: string;
  subject: string;
}

// Producer - must have embedded: true
const queue = new Queue<EmailJob>('emails', { embedded: true });

// Add some jobs
await queue.add('welcome', { to: 'new@user.com', subject: 'Welcome!' });
await queue.add('newsletter', { to: 'sub@user.com', subject: 'News' });

// Consumer - must have embedded: true
const worker = new Worker<EmailJob>('emails', async (job) => {
  console.log(`Sending ${job.data.subject} to ${job.data.to}`);
  await job.updateProgress(100);
  return { sent: true };
}, { embedded: true, concurrency: 3 });

worker.on('completed', (job) => {
  console.log(`✓ ${job.id}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await worker.close();
  shutdownManager();
  process.exit(0);
});
```

## With Persistence (SQLite)

To persist jobs across restarts, set `DATA_PATH` before importing bunqueue:

```typescript
// Set DATA_PATH FIRST
import { mkdirSync } from 'fs';
mkdirSync('./data', { recursive: true });
process.env.DATA_PATH = './data/bunqueue.db';

// Then import
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('tasks', { embedded: true });
const worker = new Worker('tasks', processor, { embedded: true });
```

:::note
Without `DATA_PATH`, bunqueue runs in-memory (no persistence).
:::

## Next Steps

- [Queue API](/bunqueue/guide/queue/) - Full queue operations
- [Worker API](/bunqueue/guide/worker/) - Worker configuration
- [Stall Detection](/bunqueue/guide/stall-detection/) - Handle unresponsive jobs
- [DLQ](/bunqueue/guide/dlq/) - Dead letter queue management
