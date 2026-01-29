# bunqueue 🐰

High-performance job queue server for Bun. SQLite persistence, cron jobs, priorities, DLQ. Zero external dependencies.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      bunqueue server                            │
├─────────────────────────────────────────────────────────────┤
│  HTTP API (Bun.serve)  │  TCP Protocol (Bun.listen)        │
├─────────────────────────────────────────────────────────────┤
│                     Core Engine                             │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐         │
│  │ Queues  │ │ Workers │ │ Scheduler│ │   DLQ   │         │
│  └─────────┘ └─────────┘ └──────────┘ └─────────┘         │
├─────────────────────────────────────────────────────────────┤
│              bun:sqlite (WAL mode)                          │
└─────────────────────────────────────────────────────────────┘
```

## Code Guidelines

### File Size & Modularity

- **MAX 300 lines per file** - split if larger
- One concern per file (Single Responsibility)
- Export only what's needed (minimize public API)

### Clean Architecture Layers

```
src/
├── cli/             # Command-line interface
│   ├── index.ts     # Entry point, mode detection
│   ├── client.ts    # TCP client for server communication
│   ├── output.ts    # Output formatting (table/json)
│   ├── help.ts      # Help text generator
│   └── commands/    # Command builders (core, job, queue, etc.)
├── domain/          # Pure business logic, zero dependencies
│   ├── types/       # Job, Queue, Command types
│   └── errors/      # Domain errors
├── application/     # Use cases, orchestration
│   ├── commands/    # Push, Pull, Ack, Fail handlers
│   └── queries/     # GetJob, GetStats, etc.
├── infrastructure/  # External concerns
│   ├── persistence/ # SQLite implementation
│   ├── server/      # TCP, HTTP, WebSocket
│   └── background/  # Cron, cleanup tasks
└── shared/          # Utilities, constants
```

### Deadlock Prevention

**Lock Hierarchy (ALWAYS acquire in this order):**

1. `jobIndex` (Map, fast lookups)
2. `completedJobs` (Set, read before shard write)
3. `shards[N]` (per-shard lock)
4. `processingShards[N]` (per-processing lock)

**Rules:**

- NEVER hold shard lock while acquiring completedJobs
- ALWAYS acquire completedJobs.read BEFORE shard.write
- Use async locks with timeout (5s max)
- Release locks in reverse order of acquisition

```typescript
// CORRECT
const completed = completedJobs.has(depId); // Read first
const shard = await shards[idx].acquire(); // Then acquire
try {
  // ... work
} finally {
  shard.release(); // Always release
}

// WRONG - potential deadlock
const shard = await shards[idx].acquire();
const completed = completedJobs.has(depId); // Reading while holding shard!
```

### Memory Leak Prevention

**Bounded Collections:**

```typescript
const MAX_COMPLETED_JOBS = 50_000;
const MAX_JOB_RESULTS = 5_000;
const MAX_JOB_LOGS = 1_000;
const CLEANUP_THRESHOLD = 0.5; // Remove 50% when full
```

**Cleanup Rules:**

- Run cleanup every 10 seconds
- Remove oldest entries when threshold exceeded
- Clear job logs on completion if `removeOnComplete`
- Clear debounce cache entries on expiry
- Unindex jobs immediately on delete

**Event Listeners:**

- Always use `AbortController` for cancellable operations
- Remove event listeners in cleanup/shutdown
- Use WeakMap for object associations when possible

### Sharding Strategy

**32 Shards for Queues:**

```typescript
const SHARD_COUNT = 32;
const SHARD_MASK = 0x1f; // 31

function shardIndex(queueName: string): number {
  return fnv1aHash(queueName) & SHARD_MASK;
}
```

**32 Shards for Processing:**

```typescript
function processingShardIndex(jobId: bigint): number {
  return Number(jobId & BigInt(SHARD_MASK));
}
```

### TypeScript Best Practices

**Strict Types:**

```typescript
// Use branded types for IDs
type JobId = bigint & { readonly __brand: 'JobId' };
type QueueName = string & { readonly __brand: 'QueueName' };

// Use const enums for performance
const enum JobState {
  Waiting = 'waiting',
  Delayed = 'delayed',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed',
}
```

**Immutability:**

```typescript
// Prefer readonly
interface Job {
  readonly id: JobId;
  readonly queue: QueueName;
  readonly data: unknown;
  // Mutable fields explicit
  attempts: number;
  progress: number;
}
```

**Error Handling:**

```typescript
// Use Result type instead of throwing
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

// Domain errors
class JobNotFoundError extends Error {
  constructor(public readonly jobId: JobId) {
    super(`Job ${jobId} not found`);
  }
}
```

### Performance Patterns

**Batch Operations:**

```typescript
// Prefer batch over loop
await db.exec(`INSERT INTO jobs VALUES ${jobs.map(j => '(?, ?, ?)').join(',')}`);

// NOT this
for (const job of jobs) {
  await db.exec('INSERT INTO jobs VALUES (?, ?, ?)', ...);
}
```

**Object Pooling:**

```typescript
// Reuse buffers for serialization
const bufferPool = new BufferPool(1024, 100);
const buf = bufferPool.acquire();
try {
  // ... use buffer
} finally {
  bufferPool.release(buf);
}
```

**Avoid Closures in Hot Paths:**

```typescript
// Pre-bind functions
const boundHandler = this.handleJob.bind(this);

// NOT this in loops
jobs.forEach((job) => this.handleJob(job)); // Creates closure each time
```

## SQLite Schema

```sql
-- Enable WAL mode for concurrent reads
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;  -- 64MB
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;  -- 256MB

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    queue TEXT NOT NULL,
    data TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    run_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    backoff INTEGER NOT NULL DEFAULT 1000,
    ttl INTEGER,
    timeout INTEGER,
    unique_key TEXT,
    custom_id TEXT,
    depends_on TEXT,
    parent_id INTEGER,
    children_ids TEXT,
    tags TEXT,
    state TEXT NOT NULL DEFAULT 'waiting',
    lifo INTEGER NOT NULL DEFAULT 0,
    group_id TEXT,
    progress INTEGER DEFAULT 0,
    progress_msg TEXT,
    remove_on_complete INTEGER DEFAULT 0,
    remove_on_fail INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs(run_at) WHERE state IN ('waiting', 'delayed');
CREATE INDEX IF NOT EXISTS idx_jobs_unique ON jobs(queue, unique_key) WHERE unique_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_custom_id ON jobs(custom_id) WHERE custom_id IS NOT NULL;

-- Job results
CREATE TABLE IF NOT EXISTS job_results (
    job_id INTEGER PRIMARY KEY,
    result TEXT,
    completed_at INTEGER NOT NULL
);

-- Dead letter queue
CREATE TABLE IF NOT EXISTS dlq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    queue TEXT NOT NULL,
    data TEXT NOT NULL,
    error TEXT,
    failed_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dlq_queue ON dlq(queue);

-- Cron jobs
CREATE TABLE IF NOT EXISTS cron_jobs (
    name TEXT PRIMARY KEY,
    queue TEXT NOT NULL,
    data TEXT NOT NULL,
    schedule TEXT,
    repeat_every INTEGER,
    priority INTEGER NOT NULL DEFAULT 0,
    next_run INTEGER NOT NULL,
    executions INTEGER NOT NULL DEFAULT 0,
    max_limit INTEGER
);

-- Sequence for job IDs
CREATE TABLE IF NOT EXISTS sequences (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sequences (name, value) VALUES ('job_id', 0);
```

## Protocol Commands

### Core Operations

| Command | Description             |
| ------- | ----------------------- |
| `PUSH`  | Add job to queue        |
| `PUSHB` | Batch push jobs         |
| `PULL`  | Get next job from queue |
| `PULLB` | Batch pull jobs         |
| `ACK`   | Mark job as completed   |
| `ACKB`  | Batch acknowledge       |
| `FAIL`  | Mark job as failed      |

### Query Operations

| Command        | Description            |
| -------------- | ---------------------- |
| `GetJob`       | Get job by ID          |
| `GetState`     | Get job state          |
| `GetResult`    | Get job result         |
| `GetJobs`      | List jobs with filters |
| `GetJobCounts` | Count jobs by state    |

### Queue Control

| Command      | Description             |
| ------------ | ----------------------- |
| `Pause`      | Pause queue processing  |
| `Resume`     | Resume queue processing |
| `Drain`      | Remove all waiting jobs |
| `Obliterate` | Remove all queue data   |

### DLQ Operations

| Command    | Description    |
| ---------- | -------------- |
| `Dlq`      | Get DLQ jobs   |
| `RetryDlq` | Retry DLQ jobs |
| `PurgeDlq` | Clear DLQ      |

### Scheduling

| Command      | Description     |
| ------------ | --------------- |
| `Cron`       | Add cron job    |
| `CronDelete` | Remove cron job |
| `CronList`   | List cron jobs  |

## Environment Variables

```bash
# Server ports
TCP_PORT=6789
HTTP_PORT=6790

# Authentication
AUTH_TOKENS=token1,token2

# Persistence
DATA_PATH=./data/flashq.db

# S3 Backup (optional)
S3_BACKUP_ENABLED=0
S3_ENDPOINT=
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY=
S3_SECRET_KEY=
```

## CLI Commands

The CLI supports two modes: **server** (starts bunqueue) and **client** (executes commands against a running server).

### Server Mode

```bash
bunqueue                                          # Start with defaults
bunqueue start --tcp-port 6789 --http-port 6790   # Custom ports
bunqueue start --data-path ./data/queue.db        # Persistent storage
```

### Client Mode

```bash
# Core operations
bunqueue push <queue> <json> [--priority N] [--delay ms]
bunqueue pull <queue> [--timeout ms]
bunqueue ack <id> [--result json]
bunqueue fail <id> [--error message]

# Job management
bunqueue job get|state|result|cancel|promote|discard <id>
bunqueue job progress <id> <0-100> [--message msg]
bunqueue job priority <id> <priority>
bunqueue job delay <id> <ms>
bunqueue job logs <id>
bunqueue job log <id> <message> [--level info|warn|error]

# Queue control
bunqueue queue list|pause|resume|drain|obliterate <queue>
bunqueue queue clean <queue> --grace <ms> [--state S]
bunqueue queue jobs <queue> [--state S] [--limit N]

# Rate limiting
bunqueue rate-limit set|clear <queue> [limit]
bunqueue concurrency set|clear <queue> [limit]

# DLQ
bunqueue dlq list|retry|purge <queue>

# Cron
bunqueue cron list
bunqueue cron add <name> -q <queue> -d <json> [-s "cron"] [-e ms]
bunqueue cron delete <name>

# Workers & Webhooks
bunqueue worker list|register|unregister
bunqueue webhook list|add|remove

# Monitoring
bunqueue stats|metrics|health
```

### Global Options

| Option | Description |
|--------|-------------|
| `-H, --host` | Server host (default: localhost) |
| `-p, --port` | TCP port (default: 6789) |
| `-t, --token` | Auth token |
| `--json` | Output as JSON |
| `--help` | Show help |
| `--version` | Show version |

## Testing Commands

```bash
# Run all tests
bun test

# Run specific test file
bun test test/cli.test.ts

# Run with coverage
bun test --coverage

# Benchmark
bun run bench
```

## Build & Deploy

```bash
# Development
bun run dev

# Build single executable
bun build --compile --minify src/main.ts --outfile bunqueue

# Docker
docker build -t bunqueue .
docker run -p 6789:6789 -p 6790:6790 bunqueue
```
