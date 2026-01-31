<p align="center">
  <img src=".github/banner.svg" alt="bunqueue - High-performance job queue for Bun" width="700" />
</p>

<p align="center">
  <a href="https://github.com/egeominotti/bunqueue/actions"><img src="https://github.com/egeominotti/bunqueue/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/egeominotti/bunqueue/releases"><img src="https://img.shields.io/github/v/release/egeominotti/bunqueue" alt="Release"></a>
  <a href="https://github.com/egeominotti/bunqueue/blob/main/LICENSE"><img src="https://img.shields.io/github/license/egeominotti/bunqueue" alt="License"></a>
  <a href="https://www.npmjs.com/package/bunqueue"><img src="https://img.shields.io/npm/v/bunqueue" alt="npm"></a>
</p>

<p align="center">
  <strong>High-performance job queue for Bun. Zero external dependencies.</strong>
</p>

<p align="center">
  <a href="https://egeominotti.github.io/bunqueue/"><strong>Documentation</strong></a>
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
- **SQLite persistence** — Survives restarts
- **100K+ jobs/sec** — Built on Bun

## Install

```bash
bun add bunqueue
```

> Requires [Bun](https://bun.sh) runtime. Node.js is not supported.

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

## Documentation

**[Read the full documentation →](https://egeominotti.github.io/bunqueue/)**

- [Quick Start](https://egeominotti.github.io/bunqueue/guide/quickstart/)
- [Queue API](https://egeominotti.github.io/bunqueue/guide/queue/)
- [Worker API](https://egeominotti.github.io/bunqueue/guide/worker/)
- [Server Mode](https://egeominotti.github.io/bunqueue/guide/server/)
- [CLI Reference](https://egeominotti.github.io/bunqueue/guide/cli/)
- [Environment Variables](https://egeominotti.github.io/bunqueue/guide/env-vars/)

## License

MIT
