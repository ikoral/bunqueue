---
name: bunqueue-dev
description: Internal skill for contributing to bunqueue - architecture, testing, code conventions, and development workflow
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# bunqueue Development Guide

You are working on **bunqueue**, a high-performance job queue for Bun with SQLite persistence.

## Architecture

bunqueue uses a sharded priority queue architecture:
- **Shards**: Auto-detected from CPU cores (power of 2, max 64). Jobs are assigned via `fnv1aHash(queue) & SHARD_MASK`
- **Persistence**: SQLite in WAL mode with a 10ms WriteBuffer for batching writes
- **Transport**: TCP (msgpack) on port 6789, HTTP on port 6790
- **Two modes**: Embedded (in-process) and TCP (client-server)

### Request Flow
1. **PUSH**: Client -> TcpPool -> TcpServer -> QueueManager -> Shard -> PriorityQueue -> WriteBuffer -> SQLite
2. **PULL**: Client -> TcpServer -> QueueManager -> Shard -> PriorityQueue.pop()
3. **ACK**: Client -> TcpServer -> AckBatcher -> Shard.complete() -> jobResults (LRU)
4. **FAIL**: Client -> TcpServer -> Shard.fail() -> retry (backoff) OR -> DLQ

### Directory Structure
```
src/
  cli/              # CLI interface
  client/           # SDK (Queue, Worker, FlowProducer, Bunqueue)
    queue/          # Queue with DLQ, stall detection
    worker/         # Worker with heartbeat, ack batching
    tcp/            # Connection pool, reconnection
  domain/           # Pure business logic
    queue/          # Shard, PriorityQueue, DlqShard, UniqueKeyManager
  application/      # Use cases and managers
    operations/     # push, pull, ack, query, queueControl
  infrastructure/   # Persistence, server, scheduler, backup
  shared/           # Utilities (hash, lock, lru, skipList, minHeap)
```

## Code Conventions

- **MAX 300 lines per file** - split if larger
- One concern per file (Single Responsibility)
- Export only what's needed
- Lock hierarchy: `jobIndex` -> `completedJobs` -> `shards[N]` -> `processingShards[N]`

## Testing (MANDATORY before any commit)

```bash
bun test                                # Unit tests (~5000 tests)
bun scripts/tcp/run-all-tests.ts        # TCP integration tests (~50 suites)
bun scripts/embedded/run-all-tests.ts   # Embedded integration tests (~35 suites)
```

All three must pass. No exceptions.

## Bug Fixing Process

NEVER fix a bug directly. Always:
1. Write a test that reproduces the bug
2. Launch subagents to fix the bug
3. Prove the fix with a passing test

## Publishing

After every commit:
1. Bump version in `package.json`
2. Update changelog in `docs/src/content/docs/changelog.md`
3. `git push origin main`
4. `bun publish`
