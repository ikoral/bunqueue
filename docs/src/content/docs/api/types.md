---
title: TypeScript Types
description: Complete TypeScript type definitions for bunqueue
---

# TypeScript Types

bunqueue is written in TypeScript and provides comprehensive type definitions.

## Job Types

### Job

The main job interface.

```typescript
interface Job<T = any> {
  /** Unique job identifier */
  readonly id: string;

  /** Queue name */
  readonly queue: string;

  /** Job name/type */
  readonly name: string;

  /** Job payload data */
  readonly data: T;

  /** Current job state */
  state: JobState;

  /** Number of attempts made */
  attemptsMade: number;

  /** Job options */
  readonly opts: JobOptions;

  /** Creation timestamp */
  readonly timestamp: number;

  /** When job started processing */
  processedOn?: number;

  /** When job completed/failed */
  finishedOn?: number;

  /** Current progress (0-100) */
  progress: number;

  /** Progress message */
  progressMessage?: string;

  /** Return value after completion */
  returnvalue?: any;

  /** Error if failed */
  failedReason?: string;

  /** Stack trace if failed */
  stacktrace?: string[];

  /** Parent job ID (for flows) */
  parentId?: string;

  /** Update job progress */
  updateProgress(progress: number, message?: string): Promise<void>;

  /** Add log entry */
  log(message: string): Promise<void>;

  /** Get job logs */
  getLogs(): Promise<JobLog[]>;

  /** Get parent job data */
  getParent(): Promise<Job | null>;

  /** Get children values */
  getChildrenValues(): Promise<Record<string, any>>;

  /** Check if job is active */
  isActive(): boolean;

  /** Check if job is completed */
  isCompleted(): boolean;

  /** Check if job is failed */
  isFailed(): boolean;

  /** Retry this job */
  retry(): Promise<void>;

  /** Remove this job */
  remove(): Promise<void>;

  /** Convert to JSON */
  toJSON(): JobJSON;
}
```

### JobState

```typescript
type JobState =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed';
```

### JobOptions

```typescript
interface JobOptions {
  /** Custom job ID (must be unique) */
  jobId?: string;

  /** Job priority (higher = processed first) */
  priority?: number;

  /** Delay before processing (ms) */
  delay?: number;

  /** Maximum retry attempts */
  attempts?: number;

  /** Backoff delay between retries (ms) */
  backoff?: number;

  /** Remove job after completion */
  removeOnComplete?: boolean | number;

  /** Remove job after failure */
  removeOnFail?: boolean | number;

  /** Job timeout (ms) */
  timeout?: number;

  /** Time-to-live (ms) */
  ttl?: number;

  /** Unique key for deduplication */
  uniqueKey?: string;

  /** Use LIFO instead of FIFO */
  lifo?: boolean;

  /** Job tags for filtering */
  tags?: string[];

  /** Repeat configuration */
  repeat?: RepeatOptions;

  /** Parent job ID */
  parentId?: string;

  /** Dependent job IDs */
  dependsOn?: string[];
}
```

### RepeatOptions

```typescript
interface RepeatOptions {
  /** Cron pattern (e.g., "0 * * * *") */
  pattern?: string;

  /** Interval in milliseconds */
  every?: number;

  /** Maximum number of executions */
  limit?: number;

  /** Start date */
  startDate?: Date | number;

  /** End date */
  endDate?: Date | number;

  /** Timezone */
  tz?: string;
}
```

### JobJSON

```typescript
interface JobJSON {
  id: string;
  name: string;
  data: any;
  opts: JobOptions;
  progress: number;
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: any;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}
```

### JobLog

```typescript
interface JobLog {
  timestamp: number;
  message: string;
  level: 'info' | 'warn' | 'error';
}
```

## Queue Types

### QueueOptions

```typescript
interface QueueOptions {
  /** Connection settings for server mode */
  connection?: ConnectionOptions;

  /** Default job options */
  defaultJobOptions?: JobOptions;

  /** Queue prefix */
  prefix?: string;
}
```

### ConnectionOptions

```typescript
interface ConnectionOptions {
  /** Server host */
  host?: string;

  /** TCP port */
  port?: number;

  /** Auth token */
  token?: string;
}
```

### JobCounts

```typescript
interface JobCounts {
  waiting: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  paused: number;
}
```

### QueueStats

```typescript
interface QueueStats {
  name: string;
  counts: JobCounts;
  throughput: {
    completed: number;
    failed: number;
  };
  latency: {
    avg: number;
    p50: number;
    p99: number;
  };
}
```

## Worker Types

### WorkerOptions

```typescript
interface WorkerOptions {
  /** Connection settings for server mode */
  connection?: ConnectionOptions;

  /** Number of concurrent jobs */
  concurrency?: number;

  /** Rate limit (jobs per second) */
  rateLimit?: number;

  /** Lock duration for jobs (ms) */
  lockDuration?: number;

  /** Lock renewal interval (ms) */
  lockRenewTime?: number;

  /** Use sandboxed processor (not supported) */
  useWorkerThreads?: boolean;

  /** Auto-run on creation */
  autorun?: boolean;
}
```

### Processor

```typescript
type Processor<T = any, R = any> = (job: Job<T>) => Promise<R>;
```

### WorkerListener

```typescript
interface WorkerListener {
  completed: (job: Job, result: any) => void;
  failed: (job: Job, error: Error) => void;
  progress: (job: Job, progress: number) => void;
  error: (error: Error) => void;
  ready: () => void;
  paused: () => void;
  resumed: () => void;
  closed: () => void;
  stalled: (jobId: string) => void;
}
```

## Stall Detection Types

### StallConfig

```typescript
interface StallConfig {
  /** Enable stall detection */
  enabled: boolean;

  /** Heartbeat interval (ms) */
  stallInterval?: number;

  /** Max stalls before sending to DLQ */
  maxStalls?: number;
}
```

## DLQ Types

### DlqConfig

```typescript
interface DlqConfig {
  /** Enable DLQ */
  enabled: boolean;

  /** Max entries to keep */
  maxSize?: number;

  /** Auto-retry after delay (ms) */
  autoRetryDelay?: number;

  /** Max auto-retries */
  maxAutoRetries?: number;
}
```

### DlqEntry

```typescript
interface DlqEntry {
  id: string;
  jobId: string;
  queue: string;
  data: any;
  error: string;
  failedAt: number;
  attempts: number;
  failureReason: FailureReason;
  metadata?: Record<string, any>;
}
```

### DlqFilter

```typescript
interface DlqFilter {
  queue?: string;
  reason?: FailureReason;
  since?: number;
  until?: number;
  limit?: number;
}
```

### DlqStats

```typescript
interface DlqStats {
  total: number;
  byReason: Record<FailureReason, number>;
  byQueue: Record<string, number>;
  oldestEntry?: number;
  newestEntry?: number;
}
```

### FailureReason

```typescript
type FailureReason =
  | 'max_attempts'
  | 'max_stalls'
  | 'timeout'
  | 'unrecoverable'
  | 'manual';
```

## Flow Types

### FlowJob

```typescript
interface FlowJob {
  /** Job name */
  name: string;

  /** Queue name */
  queueName: string;

  /** Job data */
  data: any;

  /** Job options */
  opts?: JobOptions;

  /** Child jobs */
  children?: FlowJob[];
}
```

### FlowOpts

```typescript
interface FlowOpts {
  /** Prefix for all queues */
  prefix?: string;

  /** Connection settings */
  connection?: ConnectionOptions;
}
```

### FlowResult

```typescript
interface FlowResult {
  /** Root job */
  job: Job;

  /** All child jobs */
  children: Job[];
}
```

## Event Types

### QueueEventsOptions

```typescript
interface QueueEventsOptions {
  /** Connection settings */
  connection?: ConnectionOptions;
}
```

### QueueEventListener

```typescript
interface QueueEventListener {
  added: (args: { jobId: string; name: string }) => void;
  active: (args: { jobId: string; prev?: string }) => void;
  completed: (args: { jobId: string; result: any }) => void;
  failed: (args: { jobId: string; error: string }) => void;
  progress: (args: { jobId: string; progress: number }) => void;
  delayed: (args: { jobId: string; delay: number }) => void;
  removed: (args: { jobId: string }) => void;
  waiting: (args: { jobId: string }) => void;
  stalled: (args: { jobId: string }) => void;
  drained: () => void;
  paused: () => void;
  resumed: () => void;
}
```

## Server Types

### ServerOptions

```typescript
interface ServerOptions {
  /** TCP port */
  tcpPort?: number;

  /** HTTP port */
  httpPort?: number;

  /** Database path */
  dataPath?: string;

  /** Auth tokens */
  authTokens?: string[];

  /** Enable S3 backup */
  s3Backup?: S3BackupOptions;
}
```

### S3BackupOptions

```typescript
interface S3BackupOptions {
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  interval?: number;
  retention?: number;
  prefix?: string;
}
```

## Utility Types

### BulkJobOptions

```typescript
interface BulkJobOptions<T = any> {
  name: string;
  data: T;
  opts?: JobOptions;
}
```

### CleanOptions

```typescript
interface CleanOptions {
  /** Grace period (ms) */
  grace: number;

  /** Job states to clean */
  state?: JobState | JobState[];

  /** Maximum jobs to clean */
  limit?: number;
}
```

### MetricsOptions

```typescript
interface MetricsOptions {
  /** Time range (ms) */
  start?: number;
  end?: number;

  /** Aggregation interval */
  interval?: 'minute' | 'hour' | 'day';
}
```

### HealthStatus

```typescript
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  queues: number;
  jobs: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
  };
  database: {
    size: number;
    wal_size: number;
  };
}
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
