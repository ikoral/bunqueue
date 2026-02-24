---
title: Introduction to bunqueue Job Queue
description: Learn what bunqueue is, its core features, and why it's the fastest SQLite job queue for Bun. Built for AI agents with native MCP server. Zero Redis dependency
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/getting-started.png
---


**bunqueue** is a high-performance job queue written in TypeScript, designed specifically for the [Bun](https://bun.sh) runtime. Built for AI agents and agentic workflows with a native MCP server.

## Why bunqueue?

- **Native Bun** - Built from the ground up for Bun, leveraging `bun:sqlite` for maximum performance
- **Zero Redis** - No external dependencies. SQLite provides persistence with WAL mode for concurrent access
- **BullMQ-Compatible API** - Familiar patterns if you're migrating from BullMQ
- **Production Ready** - Stall detection, DLQ, rate limiting, webhooks, and S3 backups
- **MCP Server for AI Agents** - 70 MCP tools included. AI agents can schedule tasks, manage pipelines, and monitor queues via natural language

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

| | Embedded | TCP Server |
|---|----------|------------|
| **Use case** | Single process apps | Multi-process / Microservices |
| **Setup** | Zero config | Run `bunqueue start` |
| **Option** | `embedded: true` | Default (no option) |
| **Persistence** | `DATA_PATH` env var | `--data-path` flag |

### Embedded Mode

Use bunqueue as a library directly in your application:

```typescript
import { Queue, Worker } from 'bunqueue/client';

// ⚠️ BOTH must have embedded: true
const queue = new Queue('tasks', { embedded: true });
const worker = new Worker('tasks', async (job) => {
  // Process job
}, { embedded: true });
```

Best for:
- Single-process applications
- Serverless functions
- Simple use cases

### Server Mode

Run bunqueue as a standalone server:

```bash
# Start the server
bunqueue start --data-path ./data/queue.db
```

Then connect from your application:

```typescript
import { Queue, Worker } from 'bunqueue/client';

// No embedded option = connects to localhost:6789
const queue = new Queue('tasks');
const worker = new Worker('tasks', async (job) => {
  // Process job
});
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
| Durable writes | ✅ | ✅ (Redis AOF) |
| MCP server (AI agents) | ✅ (70 tools) | ❌ |

## Next Steps

- [Installation](/guide/installation/) - Get bunqueue installed
- [Quick Start](/guide/quickstart/) - Create your first queue
- [MCP Server](/guide/mcp/) - Connect AI agents to your queues
