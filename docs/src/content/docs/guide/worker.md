---
title: Worker
description: Worker class API reference
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/worker.png
---

The `Worker` class processes jobs from a queue.

:::caution[Important]
In embedded mode, the Worker **must** have `embedded: true`.
Without it, the Worker defaults to TCP mode and tries to connect to a bunqueue server.
:::

## Creating a Worker

```typescript
import { Worker } from 'bunqueue/client';

const worker = new Worker('my-queue', async (job) => {
  // Process the job
  return { success: true };
}, { embedded: true });
```

## Options

```typescript
const worker = new Worker('queue', processor, {
  // Mode
  embedded: true,           // Required for embedded mode

  // Concurrency
  concurrency: 5,           // Process 5 jobs in parallel (default: 1)

  // Startup
  autorun: true,            // Start automatically (default: true)

  // Heartbeats & Stall Detection
  heartbeatInterval: 10000, // Send heartbeat every 10s (default: 10000, 0 = disabled)

  // Batch Pulling (performance optimization)
  batchSize: 10,            // Jobs to pull per request (default: 10, max: 1000)
  pollTimeout: 5000,        // Long-poll timeout in ms (default: 0, max: 30000)

  // Lock-Based Ownership (BullMQ-style)
  useLocks: true,           // Enable job locks (default: true)

  // TCP Connection (server mode only)
  connection: {
    host: 'localhost',
    port: 6789,
    token: 'secret',
    poolSize: 4,
  },
});
```

### Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedded` | `boolean` | `false` | Use in-process mode |
| `concurrency` | `number` | `1` | Parallel job processing |
| `autorun` | `boolean` | `true` | Start automatically |
| `heartbeatInterval` | `number` | `10000` | Heartbeat interval in ms (0 = disabled) |
| `batchSize` | `number` | `10` | Jobs to pull per batch (max: 1000) |
| `pollTimeout` | `number` | `0` | Long-poll timeout in ms (max: 30000) |
| `useLocks` | `boolean` | `true` | Enable BullMQ-style job locks |

## Job Object

Inside the processor, you have access to the job object:

```typescript
const worker = new Worker('queue', async (job) => {
  job.id;           // Job ID
  job.name;         // Job name
  job.data;         // Job data
  job.queueName;    // Queue name
  job.attemptsMade; // Current attempt number
  job.timestamp;    // When job was created
  job.progress;     // Current progress (0-100)

  // Update progress
  await job.updateProgress(50, 'Halfway done');

  // Log messages
  await job.log('Processing step 1');

  return result;
}, { embedded: true });
```

## Events

```typescript
worker.on('ready', () => {
  console.log('Worker is ready');
});

worker.on('active', (job) => {
  console.log(`Started: ${job.id}`);
});

worker.on('completed', (job, result) => {
  console.log(`Completed: ${job.id}`, result);
});

worker.on('failed', (job, error) => {
  console.error(`Failed: ${job.id}`, error.message);
});

worker.on('progress', (job, progress) => {
  console.log(`Progress: ${job.id} - ${progress}%`);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('closed', () => {
  console.log('Worker closed');
});
```

## Control

```typescript
// Start processing (if autorun: false)
worker.run();

// Pause processing
worker.pause();

// Resume processing
worker.resume();

// Stop the worker
await worker.close();      // Wait for active jobs
await worker.close(true);  // Force close immediately
```

## Heartbeats

Workers automatically send heartbeats while processing jobs. This enables stall detection - if a job doesn't receive a heartbeat within the configured interval, it's considered stalled.

```typescript
const worker = new Worker('queue', processor, {
  embedded: true,
  heartbeatInterval: 5000, // Send heartbeat every 5 seconds
});
```

**Tip:** The `heartbeatInterval` should be less than the queue's `stallInterval` to avoid false positives.

See [Stall Detection](/bunqueue/guide/stall-detection/) for more details.

## Lock-Based Ownership

When `useLocks: true` (default), workers use BullMQ-style lock tokens:

- Each job gets a unique lock token when pulled
- Workers must provide the token when acknowledging/failing jobs
- Prevents job theft between workers
- Lock is renewed via heartbeats

For high-throughput scenarios where stall detection is sufficient, you can disable locks:

```typescript
const worker = new Worker('queue', processor, {
  embedded: true,
  useLocks: false, // Rely on stall detection only
});
```

## Batch Pulling

For better performance with many jobs, use batch pulling:

```typescript
const worker = new Worker('queue', processor, {
  embedded: true,
  batchSize: 100,     // Pull 100 jobs at once
  pollTimeout: 5000,  // Wait up to 5s for jobs (long polling)
});
```

## Error Handling

```typescript
const worker = new Worker('queue', async (job) => {
  try {
    await riskyOperation();
  } catch (error) {
    // Job will be retried if attempts remain
    throw error;
  }
}, { embedded: true });

// Handle at worker level
worker.on('failed', (job, error) => {
  if (job.attemptsMade >= 3) {
    // Final failure - alert someone
    alertOps(job, error);
  }
});
```

## SandboxedWorker

For CPU-intensive tasks or jobs that might crash, use `SandboxedWorker` to run processors in **isolated Bun Worker processes**.

```typescript
import { SandboxedWorker } from 'bunqueue/client';

const worker = new SandboxedWorker('cpu-intensive', {
  processor: './processor.ts',  // Path to processor file
  concurrency: 4,               // 4 parallel worker processes
  timeout: 60000,               // 60s timeout per job (default: 30000)
  maxMemory: 256,               // MB per worker (default: 256)
  maxRestarts: 10,              // Auto-restart limit (default: 10)
  autoRestart: true,            // Auto-restart crashed workers (default: true)
  pollInterval: 10,             // Job poll interval in ms (default: 10)
});

worker.start();
```

**Processor file** (`processor.ts`):

```typescript
export default async (job: {
  id: string;
  data: any;
  queue: string;
  attempts: number;
  progress: (value: number) => void;
}) => {
  job.progress(50);
  const result = await heavyComputation(job.data);
  job.progress(100);
  return result;
};
```

### When to Use SandboxedWorker

| Use Case | Worker | SandboxedWorker |
|----------|--------|-----------------|
| Fast I/O tasks | ✅ | ❌ |
| CPU-intensive | ❌ | ✅ |
| Untrusted code | ❌ | ✅ |
| Memory leak protection | ❌ | ✅ |
| Crash isolation | ❌ | ✅ |

### SandboxedWorker API

```typescript
// Start the worker pool
worker.start();

// Get stats
const stats = worker.getStats();
// { total: 4, busy: 2, idle: 2, restarts: 0 }

// Graceful shutdown
await worker.stop();
```

## Complete Example

```typescript
import { Queue, Worker, shutdownManager } from 'bunqueue/client';

interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const queue = new Queue<EmailJob>('emails', { embedded: true });

const worker = new Worker<EmailJob>('emails', async (job) => {
  console.log(`Sending email to: ${job.data.to}`);

  await job.updateProgress(50, 'Composing email...');
  await job.log(`Subject: ${job.data.subject}`);

  // Simulate sending
  await new Promise(r => setTimeout(r, 100));

  await job.updateProgress(100, 'Sent!');
  return { sent: true, timestamp: Date.now() };
}, {
  embedded: true,
  concurrency: 5,
  heartbeatInterval: 5000,
});

worker.on('completed', (job, result) => {
  console.log(`✓ Email sent: ${job.id}`);
});

worker.on('failed', (job, error) => {
  console.error(`✗ Email failed: ${job.id} - ${error.message}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await worker.close();
  shutdownManager();
  process.exit(0);
});
```
