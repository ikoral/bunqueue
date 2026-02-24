<p align="center">
  <a href="https://bunqueue.dev/">
    <img src=".github/banner.svg" alt="bunqueue" width="400" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/egeominotti/bunqueue/stargazers"><img src="https://img.shields.io/github/stars/egeominotti/bunqueue?style=flat" alt="GitHub Stars"></a>
  <a href="https://www.npmjs.com/package/bunqueue"><img src="https://img.shields.io/npm/v/bunqueue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/bunqueue"><img src="https://img.shields.io/npm/dm/bunqueue" alt="npm downloads"></a>
  <a href="https://github.com/egeominotti/bunqueue/actions"><img src="https://github.com/egeominotti/bunqueue/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/types-TypeScript-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?logo=bun&logoColor=white" alt="Bun">
  <a href="https://bundlephobia.com/package/bunqueue"><img src="https://img.shields.io/bundlephobia/minzip/bunqueue" alt="Bundle Size"></a>
  <a href="https://github.com/egeominotti/bunqueue/blob/main/LICENSE"><img src="https://img.shields.io/github/license/egeominotti/bunqueue" alt="License"></a>
</p>

<p align="center">
  <strong>High-performance job queue for Bun. Built for AI agents and automation.<br/>Zero external dependencies. MCP-native.</strong>
</p>

<p align="center">
  <a href="https://bunqueue.dev/"><strong>Documentation</strong></a> ·
  <a href="https://bunqueue.dev/guide/benchmarks/"><strong>Benchmarks</strong></a> ·
  <a href="https://github.com/egeominotti/bunqueue/stargazers"><strong>Star on GitHub</strong></a>
</p>

---

## Why bunqueue?

| Library      | Requires    |
| ------------ | ----------- |
| BullMQ       | Redis       |
| Agenda       | MongoDB     |
| pg-boss      | PostgreSQL  |
| **bunqueue** | **Nothing** |

- **BullMQ-compatible API** — Same `Queue`, `Worker`, `QueueEvents`
- **Zero dependencies** — No Redis, no MongoDB
- **SQLite persistence** — Survives restarts, WAL mode for concurrent access
- **Up to 286K ops/sec** — [Verified benchmarks](https://bunqueue.dev/guide/benchmarks/)
- **MCP server included** — AI agents get full control: scheduling, monitoring, DLQ, cron, rate limits

## When to use bunqueue

**Great for:**

- **AI agents that need a scheduler** — cron jobs, delayed tasks, retries, all via MCP
- **Agentic workflows** — agents push jobs, workers process, agents monitor results
- Single-server deployments
- Prototypes and MVPs
- Moderate to high workloads (up to 286K ops/sec)
- Teams that want to avoid Redis operational overhead
- Embedded use cases (CLI tools, edge functions, serverless)

**Not ideal for:**

- Multi-region distributed systems requiring HA
- Workloads that need automatic failover today
- Systems already running Redis with existing infrastructure

## Why not just use BullMQ?

If you're already running Redis, BullMQ is great — battle-tested and feature-rich.

bunqueue is for when you **don't want to run Redis**. SQLite with WAL mode handles surprisingly high throughput for single-node deployments (tested up to 286K ops/sec). You get persistence, priorities, delays, retries, cron jobs, and DLQ — without the operational overhead of another service.

## Install

```bash
bun add bunqueue
```

> Requires [Bun](https://bun.sh) runtime. Node.js is not supported.

## Two Modes

bunqueue runs in two modes depending on your architecture:

|                  | Embedded                              | Server (TCP)                                 |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| **How it works** | Queue runs inside your process        | Standalone server, clients connect via TCP   |
| **Setup**        | `bun add bunqueue`                    | `docker run` or `bunqueue start`             |
| **Performance**  | 286K ops/sec                          | 149K ops/sec                                 |
| **Best for**     | Single-process apps, CLIs, serverless | Multiple workers, separate producer/consumer |
| **Scaling**      | Same process only                     | Multiple clients across machines             |

### Embedded Mode

Everything runs in your process. No server, no network, no setup.

```typescript
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('emails', { embedded: true });

const worker = new Worker(
  'emails',
  async (job) => {
    console.log('Processing:', job.data);
    return { sent: true };
  },
  { embedded: true }
);

await queue.add('welcome', { to: 'user@example.com' });
```

### Server Mode (TCP)

Run bunqueue as a standalone server. Multiple workers and producers connect via TCP.

```bash
# Start with persistent data
docker run -d -p 6789:6789 -p 6790:6790 \
  -v bunqueue-data:/app/data \
  ghcr.io/egeominotti/bunqueue:latest
```

Connect from your app:

```typescript
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('tasks', { connection: { host: 'localhost', port: 6789 } });

const worker = new Worker(
  'tasks',
  async (job) => {
    return { done: true };
  },
  { connection: { host: 'localhost', port: 6789 } }
);

await queue.add('process', { data: 'hello' });
```

## Performance

SQLite handles surprisingly high throughput for single-node deployments:

| Mode     | Peak Throughput | Use Case            |
| -------- | --------------- | ------------------- |
| Embedded | 286K ops/sec    | Same process        |
| TCP      | 149K ops/sec    | Distributed workers |

> Run `bun run bench` to verify on your hardware. [Full benchmark methodology →](https://bunqueue.dev/guide/benchmarks/)

## Built for AI Agents (MCP Server)

bunqueue is the **first job queue with native MCP support**. AI agents get a full-featured scheduler, task queue, and monitoring system — no glue code needed.

**What AI agents can do with bunqueue:**

- **Schedule tasks** — cron jobs, delayed execution, recurring workflows
- **Manage job pipelines** — push jobs, monitor progress, retry failures
- **Full pull/ack/fail cycle** — agents can consume and process jobs directly
- **Monitor everything** — stats, memory, Prometheus metrics, logs, DLQ
- **Control flow** — pause/resume queues, set rate limits, manage concurrency
- **66 MCP tools + 5 resources** — complete control over every feature

```bash
# One command to connect Claude Code
claude mcp add bunqueue -- bunx bunqueue-mcp
```

```json
// Claude Desktop / Cursor / Windsurf — add to MCP config
{
  "mcpServers": {
    "bunqueue": {
      "command": "bunx",
      "args": ["bunqueue-mcp"]
    }
  }
}
```

**Example agent interactions:**

- *"Schedule a cleanup job every day at 3 AM"*
- *"Add 500 email jobs to the queue with priority 10"*
- *"Show me all failed jobs and retry them"*
- *"Set rate limit to 50/sec on the api-calls queue"*
- *"What's the memory usage and queue throughput?"*

Supports **embedded** (local SQLite) and **TCP** (remote server) modes. [Full MCP documentation →](https://bunqueue.dev/guide/mcp/)

## Monitoring

```bash
# Start with Prometheus + Grafana
docker compose --profile monitoring up -d
```

- **Grafana**: http://localhost:3000 (admin/bunqueue)
- **Prometheus**: http://localhost:9090

## Documentation

**[Read the full documentation →](https://bunqueue.dev/)**

- [Quick Start](https://bunqueue.dev/guide/quickstart/)
- [Queue API](https://bunqueue.dev/guide/queue/)
- [Worker API](https://bunqueue.dev/guide/worker/)
- [Server Mode](https://bunqueue.dev/guide/server/)
- [MCP Server (AI Agents)](https://bunqueue.dev/guide/mcp/)
- [Benchmarks](https://bunqueue.dev/guide/benchmarks/)
- [CLI Reference](https://bunqueue.dev/guide/cli/)

## License

MIT
