---
title: Changelog
description: Release notes and version history
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/getting-started.png
---

All notable changes to bunqueue are documented here.

## [2.1.0] - 2026-02-04

### Performance
- **TCP Pipelining** - Major throughput improvement for TCP client operations:
  - Client-side: Multiple commands in flight per connection (up to 100 by default)
  - Server-side: Parallel command processing with `Promise.all()`
  - reqId-based response matching for correct command-response pairing
  - **125,000 ops/sec** in pipelining benchmarks (vs ~20,000 before)
  - Configurable via `pipelining: boolean` and `maxInFlight: number` options
- **SQLite indexes for high-throughput operations** - Added 4 new indexes for 30-50% faster queries:
  - `idx_jobs_state_started`: Stall detection now O(log n) instead of O(n) table scan
  - `idx_jobs_group_id`: Fast lookup for group operations
  - `idx_jobs_pending_priority`: Compound index for priority-ordered job retrieval
  - `idx_dlq_entered_at`: DLQ expiration cleanup now O(log n)
- **Date.now() caching in pull loop** - Reduced syscalls by caching timestamp per iteration (+3-5% throughput)

### Added
- **Hello command** for protocol version negotiation (`cmd: 'Hello'`)
- **Protocol version 2** with pipelining capability support
- **Semaphore utility** for server-side concurrency limiting (`src/shared/semaphore.ts`)
- Comprehensive pipelining test suites:
  - `test/protocol-reqid.test.ts` - 7 tests for reqId handling
  - `test/client-pipelining.test.ts` - 7 tests for client pipelining
  - `test/server-pipelining.test.ts` - 7 tests for server parallel processing
  - `test/backward-compat.test.ts` - 10 tests for backward compatibility
- **Fair benchmark comparison** (`bench/comparison/run.ts`):
  - Both bunqueue and BullMQ use identical parallel push strategy
  - Queue cleanup with `obliterate()` between tests
  - Results: **1.3x Push**, **3.2x Bulk Push**, **1.7x Process** vs BullMQ
- **New ConnectionOptions** - Added `pingInterval`, `commandTimeout`, `pipelining`, `maxInFlight` to public API

### Fixed
- **SQLITE_BUSY under high concurrency** - Added `PRAGMA busy_timeout = 5000` to wait for locks instead of failing immediately
- **"Database has closed" errors during shutdown** - Added `stopped` flag to WriteBuffer to prevent flush attempts after stop()
- **Critical: Worker pendingJobs race condition** - Concurrent `tryProcess()` calls could overwrite each other's job buffers, causing ~30% job loss under high concurrency. Now preserves existing buffered jobs when pulling new batches.
- **Connection options not passed through** - Worker, Queue, and FlowProducer now correctly pass `pingInterval`, `commandTimeout`, `pipelining`, and `maxInFlight` options to the TCP connection pool.

### Changed
- Schema version bumped to 5 (auto-migrates existing databases)
- TCP client now includes `reqId` in all commands for response matching
- Server processes multiple frames in parallel (max 50 concurrent per connection)
- **Documentation**: Rewrote comparison page with real benchmark data and methodology explanation

## [2.0.9] - 2026-02-03

### Fixed
- **Critical: Memory leak in EventsManager** - Cancelled waiters in `waitForJobCompletion()` were never removed from the `completionWaiters` map on timeout. Now properly cleaned up when timeout fires.
- **Critical: Lost notification TOCTOU race** - Fixed race condition in pull.ts where `notify()` could fire between `tryPullFromShard()` returning null and `waitForJob()` being called. Added `pendingNotification` flag to Shard to capture notifications when no waiters exist.
- **Critical: WriteBuffer data loss** - Added exponential backoff (100ms → 30s), max 10 retries, critical error callback, `stopGracefully()` method, and enhanced error callback with retry information. Previously, persistent errors caused infinite retries and shutdown lost pending jobs.
- **Critical: CustomIdMap race condition** - Concurrent pushes with same customId could create duplicates. Moved customIdMap check inside shard write lock for atomic check-and-insert.

### Added
- Comprehensive test suites for all bug fixes:
  - `test/bug-memory-leak-waiters.test.ts` - 5 tests verifying memory leak fix
  - `test/bug-lost-notification.test.ts` - 4 tests verifying notification fix
  - `test/bug-writebuffer-dataloss.test.ts` - 10 tests verifying WriteBuffer fix
  - `test/bug-verification-remaining.test.ts` - 7 tests verifying CustomId fix and JS concurrency model

## [2.0.3] - 2026-02-02

### Changed
- **Major refactor: Split queue.ts into modular architecture** (1955 → 485 lines)
  - Follows single responsibility principle with 14 focused modules
  - New modules: operations/add.ts, operations/counts.ts, operations/query.ts, operations/management.ts, operations/cleanup.ts, operations/control.ts
  - New modules: jobMove.ts, jobProxy.ts, bullmqCompat.ts, scheduler.ts, dlq.ts, stall.ts, rateLimit.ts, deduplication.ts, workers.ts, queueTypes.ts
  - All 894 unit tests, 25 TCP test suites, and 32 embedded test suites pass

### Fixed
- `getJob()` now properly awaits async manager.getJob() call
- `getJobCounts()` now uses queue-specific counts instead of global stats
- `promoteJobs()` implements correct iteration over delayed jobs
- `addBulk()` properly passes BullMQ v5 options (lifo, stackTraceLimit, keepLogs, etc.)
- `toPublicJob()` used for full job options support in getJob()
- `extendJobLock()` passes token parameter correctly

## [2.0.2] - 2026-02-02

### Fixed
- **Critical: Complete recovery logic for deduplication after restart** - Fixed all recovery scenarios that caused duplicate jobs after server restart:
  - **jobId deduplication** (`customIdMap`) - Now properly populated on recovery
  - **uniqueKey TTL deduplication** - Now restored with TTL settings via `registerUniqueKeyWithTtl()`
  - **Dependency recovery** - Now checks SQLite `job_results` table (not just in-memory `completedJobs`)
  - **Counter consistency** - Fixed `incrementQueued()` only called for main queue jobs, not `waitingDeps`

### Added
- `loadCompletedJobIds()` method in SQLite storage for dependency recovery
- `hasResult()` method to check if job result exists in SQLite
- Comprehensive recovery test suite (`test/recoveryLogic.test.ts`) with 8 tests covering all scenarios

## [2.0.1] - 2026-02-02

### Fixed
- **Critical: jobId deduplication not working after restart** - The `customIdMap` was not populated when recovering jobs from SQLite on server startup. This caused `getDeduplicationJobId()` to return `null` and allowed duplicate jobs with the same `jobId` to be created.

## [2.0.0] - 2026-02-02

### Added
- **Complete BullMQ v5 API Compatibility** - Full feature parity with BullMQ v5
  - **Worker Advanced Methods**
    - `rateLimit(expireTimeMs)` - Apply rate limiting to worker
    - `isRateLimited()` - Check if worker is currently rate limited
    - `startStalledCheckTimer()` - Start stalled job check timer
    - `delay(ms, abortController?)` - Delay worker processing with optional abort
  - **Job Advanced Methods**
    - `discard()` - Mark job as discarded
    - `getFailedChildrenValues()` - Get failed children job values
    - `getIgnoredChildrenFailures()` - Get ignored children failures
    - `removeChildDependency()` - Remove child dependency from parent
    - `removeDeduplicationKey()` - Remove deduplication key
    - `removeUnprocessedChildren()` - Remove unprocessed children jobs
  - **JobOptions**
    - `continueParentOnFailure` - Continue parent job when child fails
    - `ignoreDependencyOnFailure` - Ignore dependency on failure
    - `timestamp` - Custom job timestamp
  - **DeduplicationOptions**
    - `extend` - Extend TTL on duplicate
    - `replace` - Replace existing job on duplicate
- **Comprehensive Test Coverage** - 27 unit tests + 32 embedded script tests for new features

### Changed
- Major version bump to 2.0.0 reflecting complete BullMQ v5 compatibility
- Updated TypeScript types for all new features

## [1.9.9] - 2026-02-01

### Added
- **Comprehensive Functional Test Suite** - 28 new test files covering all major features
  - 14 embedded mode tests + 14 TCP mode tests
  - Tests for: advanced DLQ, job management, monitoring, rate limiting, stall detection, webhooks, queue groups, and more
  - All 24 embedded test suites pass (143/143 individual tests)

### Changed
- **BullMQ-Style Idempotency** - `jobId` option now returns existing job instead of throwing error
  - Duplicate job submissions are idempotent (same behavior as BullMQ)
  - Cleaner handling of retry scenarios without error handling
- Improved documentation for `jobId` deduplication behavior

### Fixed
- Embedded test suite now properly uses embedded mode (was incorrectly trying TCP)
- Fixed `getJobCounts()` in tests to use queue-specific `getJobs()` method
- Fixed async `getJob()` calls in job management tests
- Fixed PROMOTE, CHANGE PRIORITY, and MOVE TO DELAYED test logic

## [1.9.8] - 2026-01-31

### Changed
- **msgpackr Binary Protocol** - Switched TCP protocol from JSON to msgpackr binary
  - ~30% faster serialization/deserialization
  - Smaller message sizes

## [1.9.6] - 2026-01-31

### Added
- **Durable Writes** - New `durable: true` option for critical jobs
  - Bypasses write buffer for immediate disk persistence
  - Guarantees no data loss on process crash
  - Use for payments, orders, and critical events

### Changed
- **Reduced write buffer flush interval** from 50ms to 10ms
  - Smaller data loss window for non-durable jobs
  - Better balance between throughput and safety

## [1.9.4] - 2026-01-31

### Added
- **5 BullMQ-Compatible Features**
  - **Timezone support for cron jobs** - IANA timezones (e.g., "Europe/Rome", "America/New_York")
  - **`getCountsPerPriority()`** - Get job counts grouped by priority level
  - **`getJobs()` with pagination** - Filter by state, paginate with `start`/`end`, sort with `asc`
  - **`retryCompleted()`** - Re-queue completed jobs for reprocessing
  - **Advanced deduplication** - TTL-based unique keys with `extend` and `replace` strategies

### Changed
- **Documentation improvements**
  - Clear comparison table for Embedded vs TCP Server modes
  - Danger box warning about mixed modes causing "Command timeout" error
  - Added "Connecting from Client" section to Server guide

## [1.9.3] - 2026-01-31

### Added
- **Unix Socket Support** - TCP and HTTP servers can now bind to Unix sockets
  - Configure via `TCP_SOCKET_PATH` and `HTTP_SOCKET_PATH` environment variables
  - CLI flags `--tcp-socket` and `--http-socket`
  - Lower latency for local connections
- Socket status line in startup banner

### Fixed
- Test alignment for shard drain return type

## [1.9.2] - 2026-01-30

### Fixed
- **Critical Memory Leak** - Resolved `temporalIndex` leak causing 5.5M object retention after 1M jobs
  - Added `cleanOrphanedTemporalEntries()` method to Shard
  - Memory now properly released after job completion with `removeOnComplete: true`
  - `heapUsed` drops to ~6MB after processing (vs 264MB before fix)

### Changed
- Improved error logging in ackBatcher flush operations

## [1.9.1] - 2026-01-29

### Added
- **Two-Phase Stall Detection** - BullMQ-style stall detection to prevent false positives
  - Jobs marked as candidates on first check, confirmed stalled on second
  - Prevents requeuing jobs that complete between checks
- `stallTimeout` support in client push options
- Advanced health checks for TCP connections

### Fixed
- Defensive checks and cleanup for TCP pool and worker
- Server banner alignment between CLI and main.ts

### Changed
- Modularized client code into separate TCP, Worker, Queue, and Sandboxed modules

## [1.9.0] - 2026-01-28

### Added
- **TCP Client** - High-performance TCP client for remote server connections
  - Connection pooling with configurable pool size
  - Heartbeat keepalive mechanism
  - Batch pull/ACK operations (PULLB, ACKB with results)
  - Long polling support
  - Ping/pong health checks
- 4.7x faster push throughput with optimized TCP client

### Changed
- Connection pool enabled by default for TCP clients
- Improved ESLint compliance across TCP client code

## [1.6.8] - 2026-01-27

### Fixed
- Renamed bunq to bunqueue in Dockerfile
- CLI version now read dynamically from package.json

### Changed
- Centralized version in `shared/version.ts`

## [1.6.7] - 2026-01-26

### Added
- Dynamic version badge in documentation
- Mobile-responsive layout improvements
- Comprehensive stress tests

## [1.6.6] - 2026-01-25

### Fixed
- Counter updates when recovering jobs from SQLite on restart

## [1.6.5] - 2026-01-24

### Fixed
- Production readiness improvements with critical fixes

## [1.6.4] - 2026-01-23

### Fixed
- SQLite persistence for DLQ entries
- Client SDK persistence issues

## [1.6.3] - 2026-01-22

### Added
- **MCP Server** - Model Context Protocol server for AI assistant integration
  - Queue management tools for Claude, Cursor, and other AI assistants
  - BigInt serialization handling in stats

### Fixed
- Deployment guide documentation corrections

## [1.6.2] - 2026-01-21

### Added
- **SandboxedWorker** - Isolated worker processes for crash protection
- Hono and Elysia integration guides
- Section-specific OG images and sitemap

### Changed
- Enhanced SEO with Open Graph and Twitter meta tags
- Improved mobile responsiveness in documentation

## [1.6.1] - 2026-01-20

### Added
- Bunny ASCII art in server startup and CLI help
- Professional benchmark charts using QuickChart.io
- BullMQ vs bunqueue comparison benchmarks

### Changed
- Optimized event subscriptions and batch operations
- Replaced Math.random UUID with Bun.randomUUIDv7 (10x faster)
- High-impact algorithm optimizations

## [1.6.0] - 2026-01-19

### Added
- **Stall Detection** - Automatic recovery of unresponsive jobs
  - Configurable stall interval and max stalls
  - Grace period after job start
  - Automatic retry or move to DLQ
- **Advanced DLQ** - Enhanced Dead Letter Queue
  - Full metadata (reason, error, attempt history)
  - Auto-retry with exponential backoff
  - Filtering by reason, age, retriability
  - Statistics endpoint
  - Auto-purge expired entries
- **Worker Heartbeats** - Configurable heartbeat interval
- **Repeatable Jobs** - Support for recurring jobs with intervals or limits
- **Flow Producer** - Parent-child job relationships
- **Queue Groups** - Bulk operations across multiple queues

### Changed
- Updated banner to "written in TypeScript"
- Version now read from package.json dynamically

### Fixed
- DLQ entry return type consistency

## [1.5.0] - 2026-01-15

### Added
- S3 backup with configurable retention
- Support for Cloudflare R2, MinIO, DigitalOcean Spaces
- Backup CLI commands (now, list, restore, status)

### Changed
- Improved backup compression
- Better error messages for S3 configuration

## [1.4.0] - 2026-01-10

### Added
- Rate limiting per queue
- Concurrency limiting per queue
- Prometheus metrics endpoint
- Health check endpoint

### Changed
- Optimized batch operations (3x faster)
- Reduced memory usage for large queues

## [1.3.0] - 2026-01-05

### Added
- Cron job scheduling
- Webhook notifications
- Job progress tracking
- Job logs

### Fixed
- Memory leak in event listeners
- Race condition in batch acknowledgment

## [1.2.0] - 2025-12-28

### Added
- Priority queues
- Delayed jobs
- Retry with exponential backoff
- Job timeout

### Changed
- Improved SQLite schema with indexes
- Better error handling

## [1.1.0] - 2025-12-20

### Added
- TCP protocol for high-performance clients
- HTTP API with WebSocket support
- Authentication tokens
- CORS configuration

## [1.0.0] - 2025-12-15

### Added
- Initial release
- Queue and Worker classes
- SQLite persistence with WAL mode
- Basic DLQ support
- CLI for server and client operations
