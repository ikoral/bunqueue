---
title: TypeScript Types
description: Complete TypeScript type definitions for bunqueue
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/api-reference.png
---

bunqueue is written in TypeScript and provides comprehensive type definitions.

## Job Types

### Job

The main job interface returned by Queue methods.

```typescript
interface Job<T = unknown> {
  /** Unique job identifier */
  id: string;

  /** Job name/type */
  name: string;

  /** Job payload data */
  data: T;

  /** Queue name */
  queueName: string;

  /** Number of attempts made */
  attemptsMade: number;

  /** Creation timestamp */
  timestamp: number;

  /** Current progress (0-100) */
  progress: number;

  /** Return value after completion */
  returnvalue?: unknown;

  /** Error message if failed */
  failedReason?: string;

  /** Update job progress */
  updateProgress(progress: number, message?: string): Promise<void>;

  /** Add log entry */
  log(message: string): Promise<void>;
}
```

### JobOptions

```typescript
interface JobOptions {
  /** Job priority (higher = processed first) */
  priority?: number;

  /** Delay before processing (ms) */
  delay?: number;

  /** Maximum retry attempts */
  attempts?: number;

  /** Backoff delay between retries (ms) */
  backoff?: number;

  /** Job timeout (ms) */
  timeout?: number;

  /** Custom job ID for deduplication (BullMQ-style idempotent).
   * If a job with this ID exists, returns existing job instead of creating duplicate. */
  jobId?: string;

  /** Remove job after completion */
  removeOnComplete?: boolean;

  /** Remove job after failure */
  removeOnFail?: boolean;

  /** Stall timeout in ms */
  stallTimeout?: number;

  /** Repeat configuration */
  repeat?: {
    /** Repeat every N milliseconds */
    every?: number;
    /** Maximum repetitions */
    limit?: number;
    /** Cron pattern (alternative to every) */
    pattern?: string;
  };
}
```

## Queue Types

### QueueOptions

```typescript
interface QueueOptions {
  /** Default job options for all jobs in this queue */
  defaultJobOptions?: JobOptions;
}
```

### JobCounts

```typescript
interface JobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}
```

## Worker Types

### WorkerOptions

```typescript
interface WorkerOptions {
  /** Number of concurrent jobs (default: 1) */
  concurrency?: number;

  /** Auto-run on creation (default: true) */
  autorun?: boolean;

  /** Heartbeat interval in ms (default: 10000) */
  heartbeatInterval?: number;
}
```

### Processor

```typescript
type Processor<T = unknown, R = unknown> = (job: Job<T>) => Promise<R> | R;
```

### Worker Events

```typescript
// Worker emits these events
worker.on('ready', () => void);
worker.on('active', (job: Job) => void);
worker.on('completed', (job: Job, result: any) => void);
worker.on('failed', (job: Job, error: Error) => void);
worker.on('progress', (job: Job, progress: number) => void);
worker.on('error', (error: Error) => void);
worker.on('closed', () => void);
```

## SandboxedWorker Types

### SandboxedWorkerOptions

```typescript
interface SandboxedWorkerOptions {
  /** Path to processor file */
  processor: string;

  /** Number of worker processes (default: 1) */
  concurrency?: number;

  /** Job timeout in ms (default: 30000) */
  timeout?: number;

  /** Max memory per worker in MB (default: 256, uses smol mode if <= 64) */
  maxMemory?: number;

  /** Max restarts before giving up (default: 10) */
  maxRestarts?: number;

  /** Auto-restart crashed workers (default: true) */
  autoRestart?: boolean;

  /** Poll interval in ms (default: 10) */
  pollInterval?: number;
}
```

### SandboxedWorker Stats

```typescript
interface SandboxedWorkerStats {
  total: number;    // Total worker processes
  busy: number;     // Currently processing
  idle: number;     // Available for work
  restarts: number; // Total restarts across all workers
}
```

## Stall Detection Types

### StallConfig

```typescript
interface StallConfig {
  /** Enable stall detection (default: true) */
  enabled?: boolean;

  /** Stall timeout in ms (default: 30000) */
  stallInterval?: number;

  /** Max stalls before moving to DLQ (default: 3) */
  maxStalls?: number;

  /** Grace period after job start in ms (default: 5000) */
  gracePeriod?: number;
}
```

## DLQ Types

### DlqConfig

```typescript
interface DlqConfig {
  /** Enable auto-retry from DLQ */
  autoRetry?: boolean;

  /** Auto-retry interval in ms (default: 3600000 = 1 hour) */
  autoRetryInterval?: number;

  /** Max auto-retries (default: 3) */
  maxAutoRetries?: number;

  /** Max age before auto-purge in ms (default: 7 days) */
  maxAge?: number | null;

  /** Max entries per queue (default: 10000) */
  maxEntries?: number;
}
```

### FailureReason

```typescript
type FailureReason =
  | 'explicit_fail'        // Job explicitly failed via job.fail() or thrown error
  | 'max_attempts_exceeded' // Exceeded retry attempts after all retries exhausted
  | 'timeout'              // Job processing timed out (exceeded job.timeout)
  | 'stalled'              // Job stalled (no heartbeat within stallInterval)
  | 'ttl_expired'          // Time-to-live expired before job could be processed
  | 'worker_lost'          // Worker disconnected while processing (TCP mode)
  | 'unknown';             // Catch-all for edge cases (e.g., corrupt job data, internal errors)
```

:::note[When is 'unknown' used?]
The `unknown` reason is a catch-all for rare edge cases:
- Job data corruption during serialization
- Internal queue manager errors
- Jobs recovered from database without failure metadata
- Race conditions during shutdown

If you see many `unknown` failures, check logs for underlying errors.
:::

### DlqEntry

```typescript
interface DlqEntry<T = unknown> {
  /** The failed job */
  job: Job<T>;

  /** When job entered DLQ */
  enteredAt: number;

  /** Failure reason */
  reason: FailureReason;

  /** Error message */
  error: string | null;

  /** Attempt history */
  attempts: Array<{
    attempt: number;
    startedAt: number;
    failedAt: number;
    reason: FailureReason;
    error: string | null;
    duration: number;
  }>;

  /** Number of retry attempts from DLQ */
  retryCount: number;

  /** Last retry timestamp */
  lastRetryAt: number | null;

  /** Next scheduled retry */
  nextRetryAt: number | null;

  /** When entry expires */
  expiresAt: number | null;
}
```

### DlqFilter

```typescript
interface DlqFilter {
  reason?: FailureReason;
  olderThan?: number;
  newerThan?: number;
  retriable?: boolean;
  expired?: boolean;
  limit?: number;
  offset?: number;
}
```

### DlqStats

```typescript
interface DlqStats {
  total: number;
  byReason: Record<FailureReason, number>;
  pendingRetry: number;
  expired: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}
```

## QueueEvents Types

### QueueEvents

```typescript
class QueueEvents extends EventEmitter {
  constructor(queueName: string);
  close(): void;
}

// Events emitted
events.on('waiting', ({ jobId }) => void);
events.on('active', ({ jobId }) => void);
events.on('completed', ({ jobId, returnvalue }) => void);
events.on('failed', ({ jobId, failedReason }) => void);
events.on('progress', ({ jobId, data }) => void);
events.on('stalled', ({ jobId }) => void);
```

## Generic Type Helpers

```typescript
// Type-safe job data
interface EmailJobData {
  to: string;
  subject: string;
  body: string;
}

const queue = new Queue<EmailJobData>('emails');

// TypeScript knows job.data has to, subject, body
const worker = new Worker<EmailJobData>('emails', async (job) => {
  const { to, subject, body } = job.data;
  return { sent: true };
});

// Type error: missing required field
await queue.add('send', { to: 'test@example.com' }); // Error!
```
