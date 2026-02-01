---
title: Migration from BullMQ
description: Step-by-step guide to migrate from BullMQ to bunqueue
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/api-reference.png
---


This guide helps you migrate from BullMQ to bunqueue with minimal code changes.

## Overview

bunqueue provides a BullMQ-compatible API, making migration straightforward for most use cases.

| BullMQ | bunqueue | Notes |
|--------|----------|-------|
| `new Queue()` | `new Queue()` | ✅ Same API |
| `new Worker()` | `new Worker()` | ✅ Same API |
| `QueueEvents` | `QueueEvents` | ✅ Same API |
| `FlowProducer` | `FlowProducer` | ✅ Same API |
| `jobId` deduplication | `jobId` deduplication | ✅ Same behavior (idempotent) |
| Redis connection | Not needed | ✅ Simpler |

## Step 1: Install bunqueue

```bash
# Remove BullMQ and Redis
bun remove bullmq ioredis

# Install bunqueue
bun add bunqueue
```

## Step 2: Update Imports

```typescript
// Before (BullMQ)
import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis();
const queue = new Queue('my-queue', { connection });

// After (bunqueue)
import { Queue, Worker, QueueEvents } from 'bunqueue/client';

const queue = new Queue('my-queue', { embedded: true });
// No connection needed - uses in-process SQLite!
```

:::caution[Persistence Setup]
For data persistence in embedded mode, set the `DATA_PATH` environment variable:
```bash
export DATA_PATH=./data/bunq.db
```
Without this, data is stored in-memory only and will be lost on restart.
:::

## Step 3: Remove Redis Configuration

```typescript
// Before (BullMQ)
const queue = new Queue('emails', {
  connection: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

// After (bunqueue)
const queue = new Queue('emails', {
  embedded: true,
  defaultJobOptions: {
    attempts: 3,
    backoff: 1000, // Base delay for exponential backoff
  },
});
```

## Step 4: Update Worker

```typescript
// Before (BullMQ)
const worker = new Worker('emails', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
}, {
  connection,
  concurrency: 5,
  limiter: { max: 100, duration: 1000 },
});

// After (bunqueue)
const worker = new Worker('emails', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
}, {
  embedded: true,
  concurrency: 5,
  // Rate limiting is set on queue via server mode, not worker
});

// Set rate limit separately
queue.setRateLimit(100); // 100 jobs/sec
```

## Step 5: Update Events

Events work the same way:

```typescript
// Same in both BullMQ and bunqueue
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

worker.on('progress', (job, progress) => {
  console.log(`Job ${job.id}: ${progress}%`);
});
```

## Step 6: Update Job Options

```typescript
// Before (BullMQ)
await queue.add('task', data, {
  priority: 1,
  delay: 5000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
  jobId: 'custom-id',
});

// After (bunqueue) - Almost identical
// Queue created with: new Queue('tasks', { embedded: true })
await queue.add('task', data, {
  priority: 1,
  delay: 5000,
  attempts: 3,
  backoff: 1000, // Base delay (exponential: 1s, 2s, 4s, 8s...)
  removeOnComplete: true,
  removeOnFail: false,
  jobId: 'custom-id',
});
```

## API Differences

### Backoff Configuration

```typescript
// BullMQ supports both types
backoff: { type: 'exponential', delay: 1000 }
backoff: { type: 'fixed', delay: 5000 }

// bunqueue only supports exponential backoff
backoff: 1000 // Base delay in ms
```

:::note[Exponential Only]
bunqueue uses exponential backoff exclusively. The value is the base delay:
- Attempt 1 fails → wait 1000ms (1s)
- Attempt 2 fails → wait 2000ms (2s)
- Attempt 3 fails → wait 4000ms (4s)
- Formula: `delay * 2^(attempt-1)`

If you need fixed delays, implement custom retry logic in your processor.
:::

### Rate Limiting

```typescript
// BullMQ (on worker)
new Worker('queue', processor, {
  limiter: { max: 100, duration: 1000 }
});

// bunqueue (server mode only - via CLI or TCP)
// Rate limiting is not available in embedded mode
bunqueue rate-limit set my-queue 100
```

:::note
Rate limiting in bunqueue is a server-side feature, configured via CLI or TCP protocol. It's not available when using embedded mode directly.
:::

### Sandboxed Processors

```typescript
// BullMQ sandboxed processors
new Worker('queue', './processor.js', { connection });

// bunqueue SandboxedWorker (isolated Bun Worker processes)
import { SandboxedWorker } from 'bunqueue/client';

const worker = new SandboxedWorker('queue', {
  embedded: true,
  processor: './processor.ts',
  concurrency: 4,
  timeout: 30000,
});
worker.start();
```

### Repeatable Jobs

```typescript
// BullMQ
await queue.add('task', data, {
  repeat: { cron: '0 * * * *' }
});

// bunqueue (queue created with embedded: true)
await queue.add('task', data, {
  repeat: { pattern: '0 * * * *' }
});
// Or use interval
await queue.add('task', data, {
  repeat: { every: 3600000 }
});
```

## Features Comparison

| Feature | BullMQ | bunqueue | Notes |
|---------|--------|----------|-------|
| Sandboxed processors | ✅ | ✅ | Use `SandboxedWorker` |
| Redis Cluster | ✅ | ❌ | Single instance |
| Redis Streams | ✅ | ❌ | SQLite storage |
| Rate limit per worker | ✅ | ❌ | Queue-level rate limit |

## Migration Checklist

- [ ] Remove `bullmq` and `ioredis` packages
- [ ] Install `bunqueue`
- [ ] Update imports to `bunqueue/client`
- [ ] Remove all Redis connection configuration
- [ ] Update backoff configuration (simplified)
- [ ] Move rate limiting from worker to queue
- [ ] Update sandboxed processors to use `SandboxedWorker`
- [ ] Update repeat config (`cron` → `pattern`)
- [ ] Test all job processing
- [ ] Remove Redis server from infrastructure

## Getting Help

If you encounter issues during migration:

- [GitHub Issues](https://github.com/egeominotti/bunqueue/issues)
- [GitHub Discussions](https://github.com/egeominotti/bunqueue/discussions)
