---
title: Migration from BullMQ
description: Step-by-step guide to migrate from BullMQ to bunqueue
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

const queue = new Queue('my-queue');
// No connection needed!
```

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
  defaultJobOptions: {
    attempts: 3,
    backoff: 1000, // Simplified backoff
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
  concurrency: 5,
  // Rate limiting is set on queue, not worker
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
await queue.add('task', data, {
  priority: 1,
  delay: 5000,
  attempts: 3,
  backoff: 1000, // Just the delay value
  removeOnComplete: true,
  removeOnFail: false,
  jobId: 'custom-id',
});
```

## API Differences

### Backoff Configuration

```typescript
// BullMQ
backoff: { type: 'exponential', delay: 1000 }
backoff: { type: 'fixed', delay: 5000 }

// bunqueue (simplified)
backoff: 1000 // Always exponential
```

### Rate Limiting

```typescript
// BullMQ (on worker)
new Worker('queue', processor, {
  limiter: { max: 100, duration: 1000 }
});

// bunqueue (on queue)
queue.setRateLimit(100);
```

### Sandboxed Processors

```typescript
// BullMQ sandboxed processors
new Worker('queue', './processor.js', { connection });

// bunqueue SandboxedWorker (isolated Bun Worker processes)
import { SandboxedWorker } from 'bunqueue/client';

const worker = new SandboxedWorker('queue', {
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

// bunqueue
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
