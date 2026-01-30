---
title: Introduction
description: What is bunqueue and why use it
---


**bunqueue** is a high-performance job queue written in TypeScript, designed specifically for the [Bun](https://bun.sh) runtime.

## Why bunqueue?

- **Native Bun** - Built from the ground up for Bun, leveraging `bun:sqlite` for maximum performance
- **Zero Redis** - No external dependencies. SQLite provides persistence with WAL mode for concurrent access
- **BullMQ-Compatible API** - Familiar patterns if you're migrating from BullMQ
- **Production Ready** - Stall detection, DLQ, rate limiting, webhooks, and S3 backups

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      bunqueue server                        │
├─────────────────────────────────────────────────────────────┤
│  HTTP API (Bun.serve)  │  TCP Protocol (Bun.listen)        │
├─────────────────────────────────────────────────────────────┤
│                     Core Engine                             │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐         │
│  │ Queues  │ │ Workers │ │ Scheduler│ │   DLQ   │         │
│  └─────────┘ └─────────┘ └──────────┘ └─────────┘         │
├─────────────────────────────────────────────────────────────┤
│   bun:sqlite (WAL mode)    │   S3 Backup (optional)        │
└─────────────────────────────────────────────────────────────┘
```

## Two Modes of Operation

### Embedded Mode

Use bunqueue as a library directly in your application:

```typescript
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('tasks');
const worker = new Worker('tasks', async (job) => {
  // Process job
});
```

Best for:
- Single-process applications
- Serverless functions
- Simple use cases

### Server Mode

Run bunqueue as a standalone server:

```bash
bunqueue start --data-path ./data/queue.db
```

Best for:
- Multi-process workers
- Microservices architecture
- Language-agnostic clients (HTTP API)

## Feature Comparison with BullMQ

| Feature | bunqueue | BullMQ |
|---------|----------|--------|
| Runtime | Bun | Node.js |
| Storage | SQLite | Redis |
| External deps | None | Redis server |
| Priority queues | ✅ | ✅ |
| Delayed jobs | ✅ | ✅ |
| Retries with backoff | ✅ | ✅ |
| Cron/repeatable jobs | ✅ | ✅ |
| Rate limiting | ✅ | ✅ |
| Stall detection | ✅ | ✅ |
| Parent-child flows | ✅ | ✅ |
| Advanced DLQ | ✅ | Basic |
| S3 backups | ✅ | ❌ |
| Sandboxed workers | ✅ | ✅ |

## Next Steps

- [Installation](/bunqueue/guide/installation/) - Get bunqueue installed
- [Quick Start](/bunqueue/guide/quickstart/) - Create your first queue
