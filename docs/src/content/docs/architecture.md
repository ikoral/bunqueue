---
title: Architecture
description: Deep dive into bunqueue's internal architecture, sharding, SQLite persistence, and design decisions
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og-image.png
---

# Architecture Overview

bunqueue is a high-performance job queue server built for Bun. This document provides a comprehensive look at its internal architecture, data flows, and design decisions.

## System Architecture

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
│   │  │              N Shards (auto-detected)                │   │           │
│   │  │  ┌─────────┬─────────┬─────────┬─────────┐          │   │           │
│   │  │  │ Shard 0 │ Shard 1 │   ...   │ Shard N │          │   │           │
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

---

## Sharding Architecture

bunqueue uses a dynamic sharding architecture that auto-detects the optimal number of shards based on CPU cores, maximizing concurrency while minimizing lock contention.

### Shard Distribution

```typescript
// Auto-calculated at startup based on CPU cores
// Must be power of 2 for fast bitwise operations, capped at 64
function calculateShardCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  let shards = 1;
  while (shards < cores && shards < 64) {
    shards *= 2;
  }
  return shards;
}

const SHARD_COUNT = calculateShardCount(); // e.g., 4, 8, 16, 32, 64
const SHARD_MASK = SHARD_COUNT - 1;        // Fast bitwise AND instead of modulo

// Queue sharding by queue name
function shardIndex(queueName: string): number {
  return fnv1aHash(queueName) & SHARD_MASK;
}

// Processing sharding by job ID
function processingShardIndex(jobId: bigint): number {
  return Number(jobId & BigInt(SHARD_MASK));
}

// Examples:
// 4 cores  → 4 shards  (SHARD_MASK = 0x03)
// 10 cores → 16 shards (SHARD_MASK = 0x0f)
// 20 cores → 32 shards (SHARD_MASK = 0x1f)
// 64+ cores → 64 shards (SHARD_MASK = 0x3f)
```

### Why FNV-1a Hash?
- Fast (~10-15 CPU cycles per string)
- Good distribution across shards
- Predictable for testing

### Shard Composition

Each shard contains:

```
Shard
├── queues: Map<string, IndexedPriorityQueue>
├── uniqueKeyManager: UniqueKeyManager
├── dlqManager: DlqShard
├── limiterManager: LimiterManager
├── dependencyTracker: DependencyTracker
├── temporalManager: TemporalManager
├── stats: ShardStats (queuedJobs, delayedJobs, dlqJobs)
├── activeGroups: Map<string, Set<string>> (FIFO groups)
└── waiters: Array<{ resolve, cancelled }>
```

---

## Job Lifecycle

### 1. PUSH (Job Creation)

```
Client.add(job)
       │
       ▼
┌──────────────────┐
│ Generate UUID7   │  ◄── Monotonic, time-ordered ID
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Custom ID Check  │  ◄── Idempotency via customIdMap (LRU)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Unique Key Check │  ◄── Deduplication with TTL support
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Acquire Shard Lock (shardIndex = hash(queue))    │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐     ┌─────────────────────────┐
│ Has Dependencies?│────►│ Add to waitingDeps      │
└────────┬─────────┘ Yes │ Register in depIndex    │
         │ No            └─────────────────────────┘
         ▼
┌──────────────────┐
│ Push to PQueue   │  ◄── 4-ary heap insert O(log₄ n)
│ Update jobIndex  │
│ Increment stats  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Release Lock     │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Persist to SQLite (async, via WriteBuffer)       │
│ • Buffered: 10ms batches, ~100k jobs/sec         │
│ • Durable: immediate write, ~10k jobs/sec        │
└──────────────────────────────────────────────────┘
```

### 2. PULL (Job Acquisition)

```
Worker.pull(queue)
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Acquire Shard Lock (queue shard)                 │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Check Paused?    │────► Return null if paused
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Check Rate Limit │────► Return null if exceeded
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Check Concurrency│────► Return null if at limit
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Pop from PQueue (skip expired, delayed, groups)  │
│ • O(log₄ n) with lazy stale entry cleanup        │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Release Shard    │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Acquire Processing Lock (jobId shard)            │
│ Add to processingShards[procIdx]                 │
│ Update jobIndex to 'processing'                  │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Mark Active in DB│
└──────────────────┘
```

### 3. ACK (Job Completion)

```
Worker.ack(jobId, result)
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Queue in AckBatcher (100ms interval, batch=50)   │
└────────┬─────────────────────────────────────────┘
         │ Flush
         ▼
┌──────────────────────────────────────────────────┐
│ Group by Processing Shard                        │
│ One lock per shard (not per job!)                │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Extract from processingShards (with lock)        │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Group by Queue Shard                             │
│ Release resources (unique key, FIFO group, etc.) │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Finalize (critical ordering):                    │
│ 1. Store result in jobResults (LRU)              │
│ 2. Store result in SQLite                        │
│ 3. Update jobIndex to 'completed'                │
│ 4. Add to completedJobs Set ◄── LAST (signal!)   │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Notify deps      │  ◄── Wake jobs waiting on this
│ Broadcast event  │
└──────────────────┘
```

### 4. FAIL (Job Failure)

```
Worker.fail(jobId, error)
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Extract from processingShards                    │
│ job.attempts++                                   │
└────────┬─────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Can Retry?       │
│ attempts < max   │
└────────┬─────────┘
         │
    ┌────┴────┐
    │ Yes     │ No
    ▼         ▼
┌────────┐ ┌──────────────────────────────────────┐
│ Retry  │ │ removeOnFail?                        │
│        │ └────────┬─────────────────────────────┘
│ runAt= │     ┌────┴────┐
│ now +  │     │ Yes     │ No
│ backoff│     ▼         ▼
│        │ ┌────────┐ ┌──────────────────────────┐
│ Push   │ │ Delete │ │ Add to DLQ               │
│ to     │ │ job    │ │ reason: max_attempts     │
│ queue  │ │ index  │ │ Update jobIndex to 'dlq' │
└────────┘ └────────┘ └──────────────────────────┘
```

### Backoff Calculation

```typescript
backoff = baseBackoff * 2^attempts
// Example: 1000ms base
// Attempt 1: 1000ms
// Attempt 2: 2000ms
// Attempt 3: 4000ms
// Attempt 4: 8000ms
```

---

## Lock Hierarchy

**CRITICAL: Always acquire locks in this order to prevent deadlocks:**

```
1. jobIndex (Map, read-only)
2. completedJobs (Set, read first)
3. shardLocks[N]     ← Per-shard lock
4. processingLocks[N] ← Per-processing-shard lock
```

### Correct Pattern

```typescript
// CORRECT: read first, then acquire lock
const completed = completedJobs.has(depId);  // Read first
const shard = await shards[idx].acquire();   // Then acquire
try {
  // ... work
} finally {
  shard.release();  // Always release
}
```

### Deadlock Scenario (WRONG)

```typescript
// WRONG - potential deadlock
// Thread A: holds processingLock, waits for shardLock
// Thread B: holds shardLock, waits for processingLock
```

### RWLock Implementation

- Multiple readers OR single writer
- Writer priority to prevent reader starvation
- O(1) timeout cancellation using marked entries
- Fast path optimization (no Promise if lock available)

---

## Persistence Layer

### SQLite Configuration

```sql
PRAGMA journal_mode = WAL;       -- Write-Ahead Logging
PRAGMA synchronous = NORMAL;     -- Balance safety/performance
PRAGMA cache_size = -64000;      -- 64MB cache
PRAGMA temp_store = MEMORY;      -- Temp tables in RAM
PRAGMA mmap_size = 268435456;    -- 256MB memory-mapped I/O
```

### WriteBuffer (10ms Batching)

```
Job arrives
     │
     ▼
┌──────────────────┐
│ Add to buffer    │
└────────┬─────────┘
         │
    ┌────┴────────────────┐
    │                     │
    ▼                     ▼
Buffer full (100)    Timer fires (10ms)
    │                     │
    └──────────┬──────────┘
               ▼
┌──────────────────────────────────────────────────┐
│ Multi-row INSERT                                 │
│ INSERT INTO jobs VALUES (...), (...), ...        │
│ • Prepared statement cache (1-100 rows)          │
│ • 50-100x faster than individual INSERTs         │
└──────────────────────────────────────────────────┘
```

### Throughput vs Durability

| Mode | Throughput | Data Loss Risk | Use Case |
|------|-----------|----------------|----------|
| Buffered (default) | ~100k jobs/sec | Up to 10ms of jobs | Emails, notifications |
| Durable | ~10k jobs/sec | None | Payments, critical events |

---

## TCP Protocol

### Wire Format

```
┌─────────────────┬─────────────────┐
│  4 bytes (u32)  │   N bytes data  │
│  Big-endian     │   msgpack frame │
│  length prefix  │                 │
└─────────────────┴─────────────────┘
```

### Connection Lifecycle

```
┌──────────────┐
│ DISCONNECTED │
└──────┬───────┘
       │ connect()
       ▼
┌──────────────┐
│ CONNECTING   │
└──────┬───────┘
       │ Success
       ▼
┌──────────────────────────┐
│ CONNECTED                │
│ • Health tracking        │──── Ping every 30s
│ • Command processing     │
└──────────┬───────────────┘
           │ Error / Close
           ▼
┌──────────────────────────┐
│ Reconnecting             │
│ • Exponential backoff    │
│ • Max 30s delay          │
│ • Jitter: ±30%           │
└──────────────────────────┘
```

### Connection Pool

- Default: 4 connections per pool
- Load-aware client selection (prefer connected)
- Parallel command distribution
- Shared pool management with reference counting

### Authentication Flow

```
Client                              Server
  │                                   │
  ├─── TCP Connect ────────────────────>
  │                                   │
  ├─── Auth { token: '...' } ─────────>
  │                                   │
  │                    [Constant-time comparison]
  │                    [Sets authenticated: true]
  │                                   │
  │  <─── { ok: true } ────────────────┤
  │                                   │
  ├─── Subsequent Commands ──────────>
```

---

## Background Tasks

### Task Schedule

| Task | Interval | Purpose |
|------|----------|---------|
| Cleanup | 10s | Orphan removal, compaction, memory trimming |
| Timeout check | 5s | Fail jobs exceeding timeout |
| Dependency processing | 100ms | Unblock dependent jobs |
| Stall detection | 5s | Two-phase stall check |
| DLQ maintenance | 60s | Auto-retry, expiration cleanup |
| Lock expiration | 5s | Remove expired locks |
| Cron scheduler | 1s | Execute due cron jobs |

### Stall Detection (Two-Phase)

```
Tick N:
  │
  ▼
┌──────────────────────────────────────┐
│ Phase 1: Confirm previous candidates │
│ If still stalled → Action (retry/DLQ)│
└────────────────────┬─────────────────┘
                     │
                     ▼
┌──────────────────────────────────────┐
│ Phase 2: Mark new candidates         │
│ Will be confirmed on Tick N+1        │
└──────────────────────────────────────┘
```

Why two-phase? Prevents false positives from transient delays.

### DLQ Maintenance

```typescript
interface DlqConfig {
  autoRetry: boolean;           // Enable auto-retry
  autoRetryInterval: 1_hour;    // Retry interval
  maxAutoRetries: 3;            // Max retries from DLQ
  maxAge: 7_days;               // Auto-purge age
  maxEntries: 10_000;           // Cap per queue
}
```

DLQ entry metadata:
- `reason`: explicit_fail, max_attempts, timeout, stalled, ttl_expired, worker_lost
- `retryCount`: DLQ-specific retry counter
- `nextRetryAt`: Scheduled retry time
- `expiresAt`: Auto-purge deadline

---

## Data Structures

### IndexedPriorityQueue

Hybrid 4-ary heap + Map for O(1) lookups with O(log₄ n) operations.

```
┌─────────────────────────────────────┐
│ Heap (4-ary MinHeap)                │
│ HeapEntry { jobId, priority, gen }  │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│ Index (Map<JobId, {job, gen}>)      │
│ O(1) find, has, remove              │
└─────────────────────────────────────┘
```

**Lazy Deletion**: Generation tracking invalidates stale heap entries without expensive removals.

### TemporalManager

Three-layer temporal management:

```
┌─────────────────────────────────────┐
│ delayedHeap (MinHeap by runAt)      │
│ O(k) refresh for k ready jobs       │
├─────────────────────────────────────┤
│ delayedRunAt (Map for staleness)    │
│ O(1) stale detection                │
├─────────────────────────────────────┤
│ temporalIndex (SkipList by created) │
│ O(log n + k) range queries          │
└─────────────────────────────────────┘
```

### Memory-Bounded Collections

| Collection | Max Size | Eviction |
|------------|----------|----------|
| completedJobs | 50,000 | FIFO batch (10%) |
| jobResults | 5,000 | LRU |
| jobLogs | 10,000 | LRU |
| customIdMap | 50,000 | LRU |

---

## Performance Characteristics

### Operation Complexity

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| PUSH | O(log₄ n) | Heap insert + shard lock |
| PULL | O(log₄ n) | Heap pop + processing lock |
| ACK (single) | O(1) | Two locks, constant work |
| ACK (batch) | O(shards) | Lock per shard, not O(n) |
| Job lookup | O(1) | Direct jobIndex access |
| Stats | O(1) | Pre-counted shardStats |
| cleanQueue | O(log n + k) | SkipList range scan |
| Dependency resolve | O(1) | dependencyIndex lookup |

### Memory Characteristics

- Per-shard: ~1KB base + jobs
- Per-connection: ~100KB base
- Command queue: O(n) pending commands
- Frame buffer: Dynamic, max 64MB

---

## Error Recovery

### Crash Recovery

On startup, QueueManager reloads state from SQLite:

```typescript
recover(): {
  // Load pending jobs
  for (job of storage.loadPendingJobs()) {
    shard.getQueue(job.queue).push(job);
    jobIndex.set(job.id, { type: 'queue', ... });
  }

  // Load DLQ entries
  for (queue, entries of storage.loadDlq()) {
    shard.restoreDlqEntry(queue, entry);
  }
}
```

### Client Disconnection

When a client disconnects, server releases all owned jobs:

```typescript
async close(socket) {
  const clientId = socket.data.state.clientId;

  // Release jobs with retry logic
  releaseClientJobsWithRetry(queueManager, clientId)
    .then((released) => {
      log.info('Released jobs', { clientId, released });
    });
}
```

### WriteBuffer Failure

On flush failure, jobs are re-added to buffer:

```typescript
try {
  batchManager.insertJobsBatch(jobs);
} catch (err) {
  // Re-add to prevent data loss
  this.buffer = jobs.concat(this.buffer);
  throw err;
}
```

---

## Design Decisions

### Why Dynamic Shard Count?

- **Auto-scales with CPU cores** (power of 2, max 64)
- Balances parallelism vs memory overhead
- Bitwise mask faster than modulo
- Examples: 4 cores → 4 shards, 10 cores → 16 shards, 64+ cores → 64 shards

### Why 4-ary Heap?

- Better cache locality than binary heap
- Children stored closer in memory
- Fewer cache misses during bubbleDown

### Why Lazy Deletion?

- Avoids O(n) heap compaction on every remove
- Generation tracking invalidates stale entries
- Compact only when stale ratio > 20%

### Why Two-Phase Stall Detection?

- Prevents false positives from transient delays
- State persists across ticks for confirmation
- Reduces unnecessary retries

### Why WriteBuffer?

- Single-row INSERT: ~10k/sec
- Multi-row INSERT: ~100k/sec
- 10ms latency acceptable for most use cases
- `durable: true` bypasses for critical jobs
