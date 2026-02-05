<p align="center">
  <a href="https://egeominotti.github.io/bunqueue/">
    <img src=".github/banner.svg" alt="bunqueue" width="400" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/egeominotti/bunqueue/stargazers"><img src="https://img.shields.io/github/stars/egeominotti/bunqueue?style=flat" alt="GitHub Stars"></a>
  <a href="https://www.npmjs.com/package/bunqueue"><img src="https://img.shields.io/npm/dm/bunqueue" alt="npm downloads"></a>
  <a href="https://github.com/egeominotti/bunqueue/actions"><img src="https://github.com/egeominotti/bunqueue/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/egeominotti/bunqueue/releases"><img src="https://img.shields.io/github/v/release/egeominotti/bunqueue" alt="Release"></a>
  <a href="https://github.com/egeominotti/bunqueue/blob/main/LICENSE"><img src="https://img.shields.io/github/license/egeominotti/bunqueue" alt="License"></a>
</p>

<p align="center">
  <strong>High-performance job queue for Bun. Zero external dependencies.</strong>
</p>

<p align="center">
  <a href="https://egeominotti.github.io/bunqueue/"><strong>Documentation</strong></a> ·
  <a href="https://egeominotti.github.io/bunqueue/guide/benchmarks/"><strong>Benchmarks</strong></a>
</p>

---

## Why bunqueue?

| Library | Requires |
|---------|----------|
| BullMQ | Redis |
| Agenda | MongoDB |
| pg-boss | PostgreSQL |
| **bunqueue** | **Nothing** |

- **BullMQ-compatible API** — Same `Queue`, `Worker`, `QueueEvents`
- **Zero dependencies** — No Redis, no MongoDB
- **SQLite persistence** — Survives restarts, WAL mode for concurrent access
- **Up to 286K ops/sec** — [Verified benchmarks](https://egeominotti.github.io/bunqueue/guide/benchmarks/)

## When to use bunqueue

**Great for:**
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

## Server Mode (Docker)

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
const worker = new Worker('tasks', async (job) => {
  return { done: true };
}, { connection: { host: 'localhost', port: 6789 } });

await queue.add('process', { data: 'hello' });
```

## Quick Example

```typescript
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('emails', { embedded: true });

const worker = new Worker('emails', async (job) => {
  console.log('Processing:', job.data);
  return { sent: true };
}, { embedded: true });

await queue.add('welcome', { to: 'user@example.com' });
```

## Performance

SQLite handles surprisingly high throughput for single-node deployments:

| Mode | Peak Throughput | Use Case |
|------|-----------------|----------|
| Embedded | 286K ops/sec | Same process |
| TCP | 149K ops/sec | Distributed workers |

> Run `bun run bench` to verify on your hardware. [Full benchmark methodology →](https://egeominotti.github.io/bunqueue/guide/benchmarks/)

## Monitoring

```bash
# Start with Prometheus + Grafana
docker compose --profile monitoring up -d
```

- **Grafana**: http://localhost:3000 (admin/bunqueue)
- **Prometheus**: http://localhost:9090

## Documentation

**[Read the full documentation →](https://egeominotti.github.io/bunqueue/)**

- [Quick Start](https://egeominotti.github.io/bunqueue/guide/quickstart/)
- [Queue API](https://egeominotti.github.io/bunqueue/guide/queue/)
- [Worker API](https://egeominotti.github.io/bunqueue/guide/worker/)
- [Server Mode](https://egeominotti.github.io/bunqueue/guide/server/)
- [Benchmarks](https://egeominotti.github.io/bunqueue/guide/benchmarks/)
- [CLI Reference](https://egeominotti.github.io/bunqueue/guide/cli/)

## License

MIT
