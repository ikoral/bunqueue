---
title: Changelog
description: Release notes and version history
---


All notable changes to bunqueue are documented here.

## [1.6.0] - 2026-01-30

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

## [1.5.0] - 2026-01-28

### Added
- S3 backup with configurable retention
- Support for Cloudflare R2, MinIO, DigitalOcean Spaces
- Backup CLI commands (now, list, restore, status)

### Changed
- Improved backup compression
- Better error messages for S3 configuration

## [1.4.0] - 2026-01-25

### Added
- Rate limiting per queue
- Concurrency limiting per queue
- Prometheus metrics endpoint
- Health check endpoint

### Changed
- Optimized batch operations (3x faster)
- Reduced memory usage for large queues

## [1.3.0] - 2026-01-20

### Added
- Cron job scheduling
- Webhook notifications
- Job progress tracking
- Job logs

### Fixed
- Memory leak in event listeners
- Race condition in batch acknowledgment

## [1.2.0] - 2026-01-15

### Added
- Priority queues
- Delayed jobs
- Retry with exponential backoff
- Job timeout

### Changed
- Improved SQLite schema with indexes
- Better error handling

## [1.1.0] - 2026-01-10

### Added
- TCP protocol for high-performance clients
- HTTP API with WebSocket support
- Authentication tokens
- CORS configuration

## [1.0.0] - 2026-01-05

### Added
- Initial release
- Queue and Worker classes
- SQLite persistence with WAL mode
- Basic DLQ support
- CLI for server and client operations
