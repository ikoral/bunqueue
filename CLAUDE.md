# bunqueue

"When I report a bug, don't start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it with a passing test."

High-performance job queue server for Bun. SQLite persistence, cron jobs, priorities, DLQ, S3 backups.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                          │
│  Queue.add() ─────┐                              ┌───── Worker.process()    │
│  Queue.addBulk() ─┤                              │                          │
│                   ▼                              ▼                          │
│            ┌──────────┐                   ┌──────────┐                      │
│            │ TcpPool  │◄─── msgpack ────► │ TcpPool  │                      │
│            └────┬─────┘                   └────┬─────┘                      │
└─────────────────┼──────────────────────────────┼────────────────────────────┘
                  │ TCP :6789                    │
┌─────────────────┼──────────────────────────────┼────────────────────────────┐
│                 ▼           SERVER             ▼                            │
│          ┌───────────┐                  ┌───────────┐                       │
│          │ TcpServer │                  │ TcpServer │                       │
│          └─────┬─────┘                  └─────┬─────┘                       │
│                │                              │                             │
│                ▼                              ▼                             │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │                    QueueManager                             │           │
│   │  ┌─────────────────────────────────────────────────────┐   │           │
│   │  │                  32 Shards                           │   │           │
│   │  │  ┌─────────┬─────────┬─────────┬─────────┐          │   │           │
│   │  │  │ Shard 0 │ Shard 1 │   ...   │ Shard 31│          │   │           │
│   │  │  │┌───────┐│┌───────┐│         │┌───────┐│          │   │           │
│   │  │  ││PQueue ││PQueue ││         ││PQueue ││          │   │           │
│   │  │  │└───────┘│└───────┘│         │└───────┘│          │   │           │
│   │  │  └─────────┴─────────┴─────────┴─────────┘          │   │           │
│   │  └─────────────────────────────────────────────────────┘   │           │
│   │                           │                                 │           │
│   │  ┌────────────────────────┼────────────────────────────┐   │           │
│   │  │  jobIndex (Map)        │   completedJobs (Set)      │   │           │
│   │  │  customIdMap (LRU)     │   jobResults (LRU)         │   │           │
│   │  └────────────────────────┼────────────────────────────┘   │           │
│   └───────────────────────────┼─────────────────────────────────┘           │
│                               │                                             │
│   ┌───────────────────────────┼─────────────────────────────────┐           │
│   │                           ▼                                 │           │
│   │  ┌─────────────┐    ┌──────────┐    ┌─────────────┐        │           │
│   │  │ WriteBuffer │───►│ SQLite   │◄───│ ReadThrough │        │           │
│   │  │ (10ms batch)│    │ WAL Mode │    │   Cache     │        │           │
│   │  └─────────────┘    └──────────┘    └─────────────┘        │           │
│   │                      Persistence                            │           │
│   └─────────────────────────────────────────────────────────────┘           │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────┐             │
│   │  Background Tasks                                          │             │
│   │  • Scheduler (cron, delayed jobs)    • Stall detector     │             │
│   │  • DLQ maintenance (retry, expire)   • Lock expiration    │             │
│   │  • Cleanup (memory bounds)           • S3 backup          │             │
│   └───────────────────────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Request Flow:**

1. **PUSH**: Client → TcpPool → TcpServer → QueueManager → Shard[hash(queue)] → PriorityQueue → WriteBuffer → SQLite
2. **PULL**: Client → TcpServer → QueueManager → Shard → PriorityQueue.pop() → Job (state: active)
3. **ACK**: Client → TcpServer → AckBatcher → Shard.complete() → jobResults (LRU) + completedJobs (Set)
4. **FAIL**: Client → TcpServer → Shard.fail() → retry (backoff) OR → DLQ (max attempts)

## Directory Structure

```
src/
├── cli/              # CLI interface (commands/, client.ts, output.ts)
├── client/           # Embedded SDK (Queue, Worker, FlowProducer, QueueGroup)
│   ├── queue/        # Queue with DLQ, stall detection
│   ├── worker/       # Worker with heartbeat, ack batching
│   └── tcp/          # Connection pool, reconnection
├── domain/           # Pure business logic (types/, queue/)
│   └── queue/        # Shard, PriorityQueue, DlqShard, UniqueKeyManager
├── application/      # Use cases (operations/, managers)
│   ├── operations/   # push, pull, ack, query, queueControl
│   └── *Manager.ts   # DLQ, Events, Workers, JobLogs, Stats
├── infrastructure/   # External (persistence/, server/, scheduler/, backup/)
└── shared/           # Utilities (hash, lock, lru, skipList, minHeap)
```

## Code Guidelines

- **MAX 300 lines per file** - split if larger
- One concern per file (Single Responsibility)
- Export only what's needed

## Sharding (32 shards)

```typescript
const SHARD_MASK = 0x1f;
const shardIndex = (key: string) => fnv1aHash(key) & SHARD_MASK;
```

## Lock Hierarchy (acquire in order)

1. `jobIndex` → 2. `completedJobs` → 3. `shards[N]` → 4. `processingShards[N]`

```typescript
// CORRECT: read first, then acquire lock
const completed = completedJobs.has(id);
const shard = await shards[idx].acquire();
try {
  /* work */
} finally {
  shard.release();
}
```

## Memory Bounds

| Collection    | Max Size | Eviction   |
| ------------- | -------- | ---------- |
| completedJobs | 50,000   | FIFO batch |
| jobResults    | 5,000    | LRU        |
| jobLogs       | 10,000   | LRU        |
| customIdMap   | 50,000   | LRU        |

Cleanup runs every 10s. Evicts 50% when full.

## Environment Variables

```bash
# Server
TCP_PORT=6789              HTTP_PORT=6790
HOST=0.0.0.0               DATA_PATH=./data/bunq.db
AUTH_TOKENS=token1,token2  CORS_ALLOW_ORIGIN=*

# S3 Backup
S3_BACKUP_ENABLED=0        S3_BUCKET=my-bucket
S3_ACCESS_KEY_ID=          S3_SECRET_ACCESS_KEY=
S3_REGION=us-east-1        S3_ENDPOINT=
S3_BACKUP_INTERVAL=21600000  S3_BACKUP_RETENTION=7

# Timeouts
SHUTDOWN_TIMEOUT_MS=30000  STATS_INTERVAL_MS=30000
WORKER_TIMEOUT_MS=30000    LOCK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=3      WEBHOOK_RETRY_DELAY_MS=1000
```

## TCP Protocol Commands

**Core:** `PUSH`, `PUSHB`, `PULL`, `PULLB`, `ACK`, `ACKB`, `FAIL`

**Query:** `GetJob`, `GetState`, `GetResult`, `GetJobs`, `GetJobCounts`, `GetProgress`, `Count`

**Control:** `Pause`, `Resume`, `Drain`, `Obliterate`, `Clean`, `Cancel`, `Promote`, `Update`, `ChangePriority`

**DLQ:** `Dlq`, `RetryDlq`, `PurgeDlq`

**Cron:** `Cron`, `CronDelete`, `CronList`

**Monitor:** `Stats`, `Metrics`, `Prometheus`, `Ping`, `Heartbeat`, `JobHeartbeat`

**Workers:** `RegisterWorker`, `UnregisterWorker`, `ListWorkers`

**Webhooks:** `AddWebhook`, `RemoveWebhook`, `ListWebhooks`

**Rate:** `RateLimit`, `RateLimitClear`, `SetConcurrency`, `ClearConcurrency`

## CLI Usage

```bash
# Server
bunqueue start --tcp-port 6789 --data-path ./data/queue.db

# Client
bunqueue push <queue> <json> [--priority N] [--delay ms]
bunqueue pull <queue> [--timeout ms]
bunqueue ack <id> [--result json]
bunqueue fail <id> [--error msg]
bunqueue job get|state|cancel|promote|discard <id>
bunqueue queue pause|resume|drain|obliterate <queue>
bunqueue dlq list|retry|purge <queue>
bunqueue cron list|add|delete
bunqueue stats|metrics|health
```

## Client SDK

```typescript
import { Queue, Worker } from 'bunqueue/client';

// Queue
const queue = new Queue<T>('emails', { connection: { port: 6789 } });
await queue.add('send', { email: 'user@test.com' });
await queue.add('payment', data, { durable: true }); // Immediate disk write
queue.pause();
queue.resume();
queue.drain();
queue.obliterate();

// Worker
const worker = new Worker(
  'emails',
  async (job) => {
    await job.updateProgress(50);
    return { sent: true };
  },
  { concurrency: 5, heartbeatInterval: 10000 }
);

worker.on('completed', (job, result) => {});
worker.on('failed', (job, err) => {});

// Stall Detection (embedded only)
queue.setStallConfig({ stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 });

// DLQ (embedded only)
queue.setDlqConfig({ autoRetry: true, maxAge: 604800000, maxEntries: 10000 });
const entries = queue.getDlq({ reason: 'timeout' });
queue.retryDlq();
queue.purgeDlq();
```

## Job Options

```typescript
interface JobOptions {
  priority?: number; // Higher = sooner
  delay?: number; // ms before processing
  attempts?: number; // Max retries (default: 3)
  backoff?: number; // Retry backoff (default: 1000ms)
  timeout?: number; // Processing timeout
  jobId?: string; // Custom ID (idempotent)
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  durable?: boolean; // Bypass write buffer
}
```

## Worker Options

```typescript
interface WorkerOptions {
  concurrency?: number; // Parallel jobs (default: 1)
  heartbeatInterval?: number; // Stall detection (default: 10000, 0=disabled)
  batchSize?: number; // Pull batch (default: 10, max: 1000)
  pollTimeout?: number; // Long poll (default: 0, max: 30000)
  useLocks?: boolean; // Lock-based ownership (default: true)
}
```

## SQLite Schema (Key Tables)

```sql
-- Jobs: id, queue, data, priority, state, run_at, attempts, ...
CREATE INDEX idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX idx_jobs_run_at ON jobs(run_at) WHERE state IN ('waiting','delayed');

-- DLQ: id, job_id, queue, entry (msgpack blob), entered_at
-- Cron: name, queue, data, schedule, repeat_every, next_run, timezone
-- Results: job_id, result, completed_at
```

## Testing

```bash
bun test                           # All tests (706 tests)
bun scripts/tcp/run-all-tests.ts   # TCP tests (24 suites)
bun run bench                      # Benchmarks
```

## Performance

| Mode               | Throughput     | Data Loss Risk |
| ------------------ | -------------- | -------------- |
| Buffered (default) | ~100k jobs/sec | Up to 10ms     |
| Durable            | ~10k jobs/sec  | None           |

## Debug Endpoints

```bash
curl http://localhost:6790/health     # Health + memory
curl http://localhost:6790/heapstats  # Object breakdown
curl -X POST http://localhost:6790/gc # Force GC
```

## Memory Debugging

```typescript
import { heapStats } from 'bun:jsc';
Bun.gc(true);
const stats = heapStats();
console.log(stats.objectCount, stats.objectTypeCounts);

// Check internal collections
const mem = queueManager.getMemoryStats();
// jobIndex, completedJobs, processingTotal, queuedTotal, temporalIndexTotal
```

## Background Tasks

| Task            | Interval | Purpose                        |
| --------------- | -------- | ------------------------------ |
| Cleanup         | 10s      | Memory cleanup, orphan removal |
| Stall check     | 5s       | Detect unresponsive jobs       |
| Dependency      | 100ms    | Process job dependencies       |
| DLQ maintenance | 60s      | Auto-retry, expiration         |
| Lock expiration | 10s      | Remove expired locks           |
