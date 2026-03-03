---
title: "Worker API — Process Background Jobs with Concurrency & Retries"
description: "Configure bunqueue Workers for job processing: concurrency, heartbeats, batch pulling, lock-based ownership, and sandboxed isolation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/worker.png
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

All events are fully typed — TypeScript will autocomplete event names and infer callback parameter types.

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

worker.on('stalled', (jobId, reason) => {
  console.warn(`Stalled: ${jobId} (${reason})`);
});

worker.on('drained', () => {
  console.log('No more jobs in queue');
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('cancelled', ({ jobId, reason }) => {
  console.log(`Cancelled: ${jobId} - ${reason}`);
});

worker.on('closed', () => {
  console.log('Worker closed');
});
```

### Event Reference

| Event | Callback Parameters | Description |
|-------|-------------------|-------------|
| `ready` | `()` | Worker started polling |
| `active` | `(job: Job<T>)` | Job started processing |
| `completed` | `(job: Job<T>, result: R)` | Job completed successfully |
| `failed` | `(job: Job<T>, error: Error)` | Job processing failed |
| `progress` | `(job: Job<T> \| null, progress: number)` | Job progress updated |
| `stalled` | `(jobId: string, reason: string)` | Job stalled (no heartbeat) |
| `drained` | `()` | Queue has no more waiting jobs |
| `error` | `(error: Error)` | Worker-level error |
| `cancelled` | `({ jobId: string, reason: string })` | Job was cancelled |
| `closed` | `()` | Worker shut down |

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

See [Stall Detection](/guide/stall-detection/) for more details.

## Lock-Based Ownership

When `useLocks: true` (default), workers use BullMQ-style lock tokens:

- Each job gets a unique lock token when pulled
- Workers must provide the token when acknowledging/failing jobs
- Prevents job theft between workers
- Lock is renewed via heartbeats
- Heartbeats support a custom `duration` parameter to extend the lock for a specific TTL instead of using the default

:::note[When Locks Matter]
Locks are essential in **server mode** with multiple workers connecting via TCP. They prevent:
- Two workers processing the same job simultaneously
- A slow worker's job being "stolen" by a faster one
- Race conditions when workers restart

In **embedded mode** with a single process, locks add overhead but provide extra safety. You can disable them for maximum throughput:
:::

```typescript
const worker = new Worker('queue', processor, {
  embedded: true,
  useLocks: false, // Rely on stall detection only (embedded mode)
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

:::tip[Batch push and worker wakeup]
When jobs are pushed via `addBulk()` or `pushBatch`, each inserted job triggers a notification to waiting workers. This means if you push 100 jobs and 20 workers are idle with `pollTimeout`, all 20 workers wake up immediately — no need to wait for the poll timeout to expire.
:::

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

:::note[Crash Isolation]
Each job runs in a separate Bun Worker thread. If a job crashes (OOM, infinite loop, uncaught exception), only that worker is affected. The main process and other workers continue running. Crashed workers are automatically restarted up to `maxRestarts` times.
:::

:::tip[Processing large files]
If your jobs process large files (100MB+), increase `maxMemory` above the default of 256MB. For example, for 300MB files set `maxMemory: 512` or higher to avoid OOM crashes.
:::

```typescript
import { SandboxedWorker } from 'bunqueue/client';

// Embedded mode (in-process)
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

### TCP Mode

SandboxedWorker also supports TCP mode for connecting to a remote bunqueue server. Pass a `connection` option to enable it:

```typescript
import { SandboxedWorker } from 'bunqueue/client';

// TCP mode - connects to bunqueue server
const worker = new SandboxedWorker('cpu-intensive', {
  processor: './processor.ts',
  concurrency: 4,
  connection: {
    host: 'localhost',
    port: 6789,
    token: 'my-auth-token',   // Optional auth
  },
  heartbeatInterval: 10000,    // Lock renewal interval (default: 10000 for TCP)
});

worker.start();
```

:::tip[When to use TCP mode]
Use TCP mode when running bunqueue as a standalone server (systemd, Docker) and you need crash-isolated job processing. The worker processes run in isolated Bun Worker threads while communicating with the server over TCP.
:::

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

### SandboxedWorker Events

SandboxedWorker supports 7 events. Note that `stalled`, `drained`, and `cancelled` are **not available** — these are only on the regular Worker.

```typescript
worker.on('ready', () => {
  console.log('Worker pool is ready');
});

worker.on('active', (job) => {
  console.log(`Job ${job.id} dispatched to worker process`);
});

worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});

worker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('closed', () => {
  console.log('Worker pool stopped');
});
```

#### Event Reference

| Event | Callback Parameters | Description |
|-------|---------------------|-------------|
| `ready` | `()` | Worker pool started and all threads spawned |
| `active` | `(job: Job)` | Job dispatched to a worker thread |
| `completed` | `(job: Job, result: unknown)` | Job completed successfully |
| `failed` | `(job: Job, error: Error)` | Job failed, timed out, or worker crashed |
| `progress` | `(job: Job, progress: number)` | Job progress updated (0-100) |
| `error` | `(error: Error)` | Worker-level error (dispatch failure, heartbeat error, crash) |
| `closed` | `()` | Worker pool stopped |

:::caution[Events not available on SandboxedWorker]
`stalled`, `drained`, and `cancelled` events are only available on the regular `Worker`. If you need these, use a regular Worker instead.
:::

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

## CPU-Intensive Workers (TCP)

When processing CPU-heavy jobs over TCP, synchronous work can block the event loop and cause connection drops. See the dedicated [CPU-Intensive Workers](/guide/cpu-intensive-workers/) guide for connection tuning, yield patterns, and timeout reference.

:::tip[Related Guides]
- [Monitoring & Prometheus Metrics](/guide/monitoring/) - Monitor worker events and performance
- [Stall Detection & Recovery](/guide/stall-detection/) - Handle unresponsive workers
- [CPU-Intensive Workers](/guide/cpu-intensive-workers/) - Handle CPU-heavy jobs over TCP
:::

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
  await Bun.sleep(100);

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
