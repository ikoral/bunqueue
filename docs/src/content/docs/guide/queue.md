---
title: Queue
description: Queue class API reference
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/queue.png
---


The `Queue` class is used to add and manage jobs.

## Creating a Queue

```typescript
import { Queue } from 'bunqueue/client';

// Basic queue
const queue = new Queue('my-queue');

// Typed queue
interface TaskData {
  userId: number;
  action: string;
}
const typedQueue = new Queue<TaskData>('tasks');

// With default options
const queue = new Queue('emails', {
  defaultJobOptions: {
    attempts: 3,
    backoff: 1000,
    removeOnComplete: true,
  }
});
```

## Adding Jobs

### Single Job

```typescript
const job = await queue.add('job-name', { key: 'value' });

// With options
const job = await queue.add('job-name', data, {
  priority: 10,           // Higher priority = processed first
  delay: 5000,            // Delay in ms before processing
  attempts: 5,            // Max retry attempts
  backoff: 2000,          // Backoff between retries (ms)
  timeout: 30000,         // Job timeout (ms)
  jobId: 'custom-id',     // Custom job ID
  removeOnComplete: true, // Remove job data after completion
  removeOnFail: false,    // Keep failed jobs
});
```

### Bulk Add

```typescript
// Batch optimized - single lock, batch INSERT
const jobs = await queue.addBulk([
  { name: 'task-1', data: { id: 1 } },
  { name: 'task-2', data: { id: 2 }, opts: { priority: 10 } },
  { name: 'task-3', data: { id: 3 }, opts: { delay: 5000 } },
]);
```

### Repeatable Jobs

```typescript
// Repeat every 5 seconds
await queue.add('heartbeat', {}, {
  repeat: {
    every: 5000,
  }
});

// Repeat with limit
await queue.add('daily-report', {}, {
  repeat: {
    every: 86400000, // 24 hours
    limit: 30,       // Max 30 repetitions
  }
});

// Cron pattern (use server mode for cron)
await queue.add('weekly', {}, {
  repeat: {
    pattern: '0 9 * * MON', // Every Monday at 9am
  }
});
```

## Query Operations

```typescript
// Get job by ID
const job = await queue.getJob('job-id');

// Get job counts
const counts = queue.getJobCounts();
// { waiting: 10, active: 2, completed: 100, failed: 3 }
```

## Queue Control

```typescript
// Pause processing (workers stop pulling)
queue.pause();

// Resume processing
queue.resume();

// Remove all waiting jobs
queue.drain();

// Remove all queue data
queue.obliterate();

// Remove a specific job
queue.remove('job-id');
```

## Stall Configuration

```typescript
// Configure stall detection
queue.setStallConfig({
  enabled: true,
  stallInterval: 30000,  // 30 seconds
  maxStalls: 3,          // Move to DLQ after 3 stalls
  gracePeriod: 5000,     // 5 second grace period
});

// Get current config
const config = queue.getStallConfig();
```

See [Stall Detection](/bunqueue/guide/stall-detection/) for more details.

## DLQ Operations

```typescript
// Configure DLQ
queue.setDlqConfig({
  autoRetry: true,
  autoRetryInterval: 3600000,  // 1 hour
  maxAutoRetries: 3,
  maxAge: 604800000,           // 7 days
});

// Get current DLQ config
const dlqConfig = queue.getDlqConfig();

// Get DLQ entries
const entries = queue.getDlq();

// Filter entries
const stalledJobs = queue.getDlq({ reason: 'stalled' });
const recentFails = queue.getDlq({ newerThan: Date.now() - 3600000 });

// Get stats
const stats = queue.getDlqStats();
// { total, byReason, pendingRetry, expired, oldestEntry, newestEntry }

// Retry from DLQ
queue.retryDlq();           // Retry all
queue.retryDlq('job-id');   // Retry specific

// Retry by filter
queue.retryDlqByFilter({ reason: 'timeout', limit: 10 });

// Purge DLQ
queue.purgeDlq();
```

See [Dead Letter Queue](/bunqueue/guide/dlq/) for more details.

## Closing

```typescript
// Close the queue (no-op in embedded mode)
await queue.close();
```
