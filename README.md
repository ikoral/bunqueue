<p align="center">
  <img src=".github/banner.svg" alt="bunqueue - High-performance job queue for Bun" width="700" />
</p>

<p align="center">
  <a href="https://github.com/egeominotti/bunqueue/actions"><img src="https://github.com/egeominotti/bunqueue/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/egeominotti/bunqueue/releases"><img src="https://img.shields.io/github/v/release/egeominotti/bunqueue" alt="Release"></a>
  <a href="https://github.com/egeominotti/bunqueue/blob/main/LICENSE"><img src="https://img.shields.io/github/license/egeominotti/bunqueue" alt="License"></a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#sdk">SDK</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#installation">Installation</a> •
  <a href="#api-reference">API</a> •
  <a href="#docker">Docker</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/bunqueue"><img src="https://img.shields.io/npm/v/bunqueue?label=bunqueue" alt="bunqueue npm"></a>
  <a href="https://www.npmjs.com/package/flashq"><img src="https://img.shields.io/npm/v/flashq?label=flashq" alt="flashq npm"></a>
  <a href="https://www.npmjs.com/package/flashq"><img src="https://img.shields.io/npm/dm/flashq" alt="npm downloads"></a>
</p>

---

## Quick Install

bunqueue requires two packages: the **server** and the **SDK**.

```bash
# Install both packages
bun add bunqueue flashq
```

| Package | Description |
|---------|-------------|
| [bunqueue](https://www.npmjs.com/package/bunqueue) | Job queue server |
| [flashq](https://www.npmjs.com/package/flashq) | TypeScript SDK for clients |

### Start Server

```bash
# Option 1: Run directly
bunqueue

# Option 2: Run via npx
npx bunqueue

# Option 3: Docker
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue
```

### Use SDK

```typescript
import { Queue, Worker } from 'flashq';

// Producer: add jobs
const queue = new Queue('emails');
await queue.add('send-welcome', { to: 'user@example.com' });

// Consumer: process jobs
const worker = new Worker('emails', async (job) => {
  console.log('Sending email to:', job.data.to);
  return { sent: true };
});
```

---

## Features

- **Blazing Fast** — Built on Bun runtime with native SQLite, optimized for maximum throughput
- **Persistent Storage** — SQLite with WAL mode for durability and concurrent access
- **Priority Queues** — FIFO, LIFO, and priority-based job ordering
- **Delayed Jobs** — Schedule jobs to run at specific times
- **Cron Scheduling** — Recurring jobs with cron expressions or fixed intervals
- **Retry & Backoff** — Automatic retries with exponential backoff
- **Dead Letter Queue** — Failed jobs preserved for inspection and retry
- **Job Dependencies** — Define parent-child relationships and execution order
- **Progress Tracking** — Real-time progress updates for long-running jobs
- **Rate Limiting** — Per-queue rate limits and concurrency control
- **Webhooks** — HTTP callbacks on job events
- **Real-time Events** — WebSocket and Server-Sent Events (SSE) support
- **Prometheus Metrics** — Built-in metrics endpoint for monitoring
- **Authentication** — Token-based auth for secure access
- **Dual Protocol** — TCP (high performance) and HTTP/REST (compatibility)
- **Full-Featured CLI** — Manage queues, jobs, cron, and more from the command line

## CLI

bunqueue includes a powerful CLI for managing the server and executing commands.

### Server Mode

```bash
# Start server with defaults
bunqueue

# Start with options
bunqueue start --tcp-port 6789 --http-port 6790 --data-path ./data/queue.db
```

### Client Commands

```bash
# Push a job
bunqueue push emails '{"to":"user@test.com","subject":"Hello"}'
bunqueue push tasks '{"action":"sync"}' --priority 10 --delay 5000

# Pull and process jobs
bunqueue pull emails --timeout 5000
bunqueue ack 12345 --result '{"sent":true}'
bunqueue fail 12345 --error "SMTP timeout"

# Job management
bunqueue job get 12345
bunqueue job progress 12345 50 --message "Processing..."
bunqueue job cancel 12345

# Queue control
bunqueue queue list
bunqueue queue pause emails
bunqueue queue resume emails
bunqueue queue drain emails

# Cron jobs
bunqueue cron list
bunqueue cron add hourly-cleanup -q maintenance -d '{"task":"cleanup"}' -s "0 * * * *"
bunqueue cron delete hourly-cleanup

# DLQ management
bunqueue dlq list emails
bunqueue dlq retry emails
bunqueue dlq purge emails

# Monitoring
bunqueue stats
bunqueue metrics
bunqueue health
```

### Global Options

```bash
-H, --host <host>    # Server host (default: localhost)
-p, --port <port>    # TCP port (default: 6789)
-t, --token <token>  # Authentication token
--json               # Output as JSON
--help               # Show help
--version            # Show version
```

## SDK (flashq)

The [flashq](https://www.npmjs.com/package/flashq) SDK provides a type-safe TypeScript interface for bunqueue.

```bash
bun add flashq
```

> **Prerequisites:** A running bunqueue server (see [Quick Install](#quick-install))

### Basic Usage

```typescript
import { Queue, Worker } from 'flashq';

// Create a queue
const queue = new Queue('my-queue', {
  connection: { host: 'localhost', port: 6789 }
});

// Add a job
await queue.add('process-data', { userId: 123, action: 'sync' });

// Add with options
await queue.add('send-email',
  { to: 'user@example.com', subject: 'Hello' },
  {
    priority: 10,
    delay: 5000,        // 5 seconds
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  }
);

// Create a worker
const worker = new Worker('my-queue', async (job) => {
  console.log('Processing:', job.name, job.data);

  // Update progress
  await job.updateProgress(50);

  // Do work...

  return { success: true };
}, {
  connection: { host: 'localhost', port: 6789 },
  concurrency: 5
});

// Handle events
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});
```

### Cron Jobs

```typescript
import { Queue } from 'flashq';

const queue = new Queue('scheduled', {
  connection: { host: 'localhost', port: 6789 }
});

// Every hour
await queue.upsertJobScheduler('hourly-report',
  { pattern: '0 * * * *' },
  { name: 'generate-report', data: { type: 'hourly' } }
);

// Every 5 minutes
await queue.upsertJobScheduler('health-check',
  { every: 300000 },
  { name: 'ping', data: {} }
);
```

### Job Dependencies (Flows)

```typescript
import { FlowProducer } from 'flashq';

const flow = new FlowProducer({
  connection: { host: 'localhost', port: 6789 }
});

// Create a flow with parent-child dependencies
await flow.add({
  name: 'final-step',
  queueName: 'pipeline',
  data: { step: 'aggregate' },
  children: [
    {
      name: 'step-1',
      queueName: 'pipeline',
      data: { step: 'fetch' }
    },
    {
      name: 'step-2',
      queueName: 'pipeline',
      data: { step: 'transform' }
    }
  ]
});
```

### Real-time Events

```typescript
import { QueueEvents } from 'flashq';

const events = new QueueEvents('my-queue', {
  connection: { host: 'localhost', port: 6789 }
});

events.on('completed', ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed with:`, returnvalue);
});

events.on('failed', ({ jobId, failedReason }) => {
  console.error(`Job ${jobId} failed:`, failedReason);
});

events.on('progress', ({ jobId, data }) => {
  console.log(`Job ${jobId} progress:`, data);
});
```

For more examples, see the [SDK documentation](https://www.npmjs.com/package/flashq).

## Quick Start

### Start the Server

```bash
# Using Bun directly
bun run src/main.ts

# Or with Docker
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue
```

### Push a Job (HTTP)

```bash
curl -X POST http://localhost:6790/queues/emails/jobs \
  -H "Content-Type: application/json" \
  -d '{"data": {"to": "user@example.com", "subject": "Hello"}}'
```

### Pull a Job (HTTP)

```bash
curl http://localhost:6790/queues/emails/jobs
```

### Acknowledge Completion

```bash
curl -X POST http://localhost:6790/jobs/1/ack \
  -H "Content-Type: application/json" \
  -d '{"result": {"sent": true}}'
```

## Installation

### Server + SDK

bunqueue is composed of two packages:

| Package | Description | Install |
|---------|-------------|---------|
| **bunqueue** | Job queue server | `bun add bunqueue` |
| **flashq** | TypeScript SDK | `bun add flashq` |

```bash
# Install both
bun add bunqueue flashq
```

### Quick Setup

```bash
# 1. Start the server
bunqueue

# 2. Use the SDK in your app
```

```typescript
import { Queue, Worker } from 'flashq';

const queue = new Queue('tasks');
await queue.add('my-job', { data: 'hello' });

const worker = new Worker('tasks', async (job) => {
  console.log(job.data);
  return { done: true };
});
```

### From Source

```bash
git clone https://github.com/egeominotti/bunqueue.git
cd bunqueue
bun install
bun run start
```

### Build Binary

```bash
bun run build
./dist/bunqueue
```

### Docker

```bash
docker pull ghcr.io/egeominotti/bunqueue
docker run -d \
  -p 6789:6789 \
  -p 6790:6790 \
  -v bunqueue-data:/app/data \
  ghcr.io/egeominotti/bunqueue
```

### Docker Compose

```yaml
version: "3.8"
services:
  bunqueue:
    image: ghcr.io/egeominotti/bunqueue
    ports:
      - "6789:6789"
      - "6790:6790"
    volumes:
      - bunqueue-data:/app/data
    environment:
      - AUTH_TOKENS=your-secret-token

volumes:
  bunqueue-data:
```

## Usage

### TCP Protocol (High Performance)

Connect via TCP for maximum throughput. Commands are newline-delimited JSON.

```bash
# Connect with netcat
nc localhost 6789

# Push a job
{"cmd":"PUSH","queue":"tasks","data":{"action":"process"}}

# Pull a job
{"cmd":"PULL","queue":"tasks"}

# Acknowledge
{"cmd":"ACK","id":"1"}
```

### HTTP REST API

```bash
# Push job
curl -X POST http://localhost:6790/queues/tasks/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "data": {"action": "process"},
    "priority": 10,
    "delay": 5000,
    "maxAttempts": 5
  }'

# Pull job (with timeout)
curl "http://localhost:6790/queues/tasks/jobs?timeout=30000"

# Get job by ID
curl http://localhost:6790/jobs/123

# Fail a job
curl -X POST http://localhost:6790/jobs/123/fail \
  -H "Content-Type: application/json" \
  -d '{"error": "Processing failed"}'

# Get stats
curl http://localhost:6790/stats
```

### WebSocket (Real-time)

```javascript
const ws = new WebSocket('ws://localhost:6790/ws');

ws.onmessage = (event) => {
  const job = JSON.parse(event.data);
  console.log('Job event:', job);
};

// Subscribe to specific queue
const wsQueue = new WebSocket('ws://localhost:6790/ws/queues/emails');
```

### Server-Sent Events (SSE)

```javascript
const events = new EventSource('http://localhost:6790/events');

events.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data);
};

// Filter by queue
const queueEvents = new EventSource('http://localhost:6790/events/queues/emails');
```

### Job Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `data` | any | required | Job payload |
| `priority` | number | 0 | Higher = processed first |
| `delay` | number | 0 | Delay in milliseconds |
| `maxAttempts` | number | 3 | Max retry attempts |
| `backoff` | number | 1000 | Initial backoff (ms), doubles each retry |
| `ttl` | number | null | Time-to-live in milliseconds |
| `timeout` | number | null | Job processing timeout |
| `uniqueKey` | string | null | Deduplication key |
| `jobId` | string | null | Custom job identifier |
| `dependsOn` | string[] | [] | Job IDs that must complete first |
| `tags` | string[] | [] | Tags for filtering |
| `groupId` | string | null | Group identifier |
| `lifo` | boolean | false | Last-in-first-out ordering |
| `removeOnComplete` | boolean | false | Auto-delete on completion |
| `removeOnFail` | boolean | false | Auto-delete on failure |

### Cron Jobs

```bash
# Cron expression (every hour)
curl -X POST http://localhost:6790/cron \
  -d '{"cmd":"Cron","name":"hourly-cleanup","queue":"maintenance","data":{"task":"cleanup"},"schedule":"0 * * * *"}'

# Fixed interval (every 5 minutes)
curl -X POST http://localhost:6790/cron \
  -d '{"cmd":"Cron","name":"health-check","queue":"monitoring","data":{"check":"ping"},"repeatEvery":300000}'

# With execution limit
curl -X POST http://localhost:6790/cron \
  -d '{"cmd":"Cron","name":"one-time-migration","queue":"migrations","data":{},"repeatEvery":0,"maxLimit":1}'
```

## API Reference

### Core Operations

| Command | Description |
|---------|-------------|
| `PUSH` | Add a job to a queue |
| `PUSHB` | Batch push multiple jobs |
| `PULL` | Get the next job from a queue |
| `PULLB` | Batch pull multiple jobs |
| `ACK` | Mark job as completed |
| `ACKB` | Batch acknowledge jobs |
| `FAIL` | Mark job as failed |

### Query Operations

| Command | Description |
|---------|-------------|
| `GetJob` | Get job by ID |
| `GetState` | Get job state |
| `GetResult` | Get job result |
| `GetJobs` | List jobs with filters |
| `GetJobCounts` | Count jobs by state |
| `GetJobByCustomId` | Find job by custom ID |
| `GetProgress` | Get job progress |
| `GetLogs` | Get job logs |

### Job Management

| Command | Description |
|---------|-------------|
| `Cancel` | Cancel a pending job |
| `Progress` | Update job progress |
| `Update` | Update job data |
| `ChangePriority` | Change job priority |
| `Promote` | Move delayed job to waiting |
| `MoveToDelayed` | Delay a waiting job |
| `Discard` | Discard a job |
| `Heartbeat` | Send job heartbeat |
| `AddLog` | Add log entry to job |

### Queue Control

| Command | Description |
|---------|-------------|
| `Pause` | Pause queue processing |
| `Resume` | Resume queue processing |
| `IsPaused` | Check if queue is paused |
| `Drain` | Remove all waiting jobs |
| `Obliterate` | Remove all queue data |
| `Clean` | Remove old jobs |
| `ListQueues` | List all queues |
| `RateLimit` | Set queue rate limit |
| `SetConcurrency` | Set max concurrent jobs |

### Dead Letter Queue

| Command | Description |
|---------|-------------|
| `Dlq` | Get failed jobs |
| `RetryDlq` | Retry failed jobs |
| `PurgeDlq` | Clear failed jobs |

### Scheduling

| Command | Description |
|---------|-------------|
| `Cron` | Create/update cron job |
| `CronDelete` | Delete cron job |
| `CronList` | List all cron jobs |

### Workers & Webhooks

| Command | Description |
|---------|-------------|
| `RegisterWorker` | Register a worker |
| `UnregisterWorker` | Unregister a worker |
| `ListWorkers` | List active workers |
| `AddWebhook` | Add webhook endpoint |
| `RemoveWebhook` | Remove webhook |
| `ListWebhooks` | List webhooks |

### Monitoring

| Command | Description |
|---------|-------------|
| `Stats` | Get server statistics |
| `Metrics` | Get job metrics |
| `Prometheus` | Prometheus format metrics |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_PORT` | 6789 | TCP protocol port |
| `HTTP_PORT` | 6790 | HTTP/WebSocket port |
| `HOST` | 0.0.0.0 | Bind address |
| `AUTH_TOKENS` | - | Comma-separated auth tokens |
| `DATA_PATH` | - | SQLite database path (in-memory if not set) |
| `CORS_ALLOW_ORIGIN` | * | Allowed CORS origins |

### Authentication

Enable authentication by setting `AUTH_TOKENS`:

```bash
AUTH_TOKENS=token1,token2 bun run start
```

**HTTP:**
```bash
curl -H "Authorization: Bearer token1" http://localhost:6790/stats
```

**TCP:**
```json
{"cmd":"Auth","token":"token1"}
```

**WebSocket:**
```json
{"cmd":"Auth","token":"token1"}
```

## Monitoring

### Health Check

```bash
curl http://localhost:6790/health
# {"ok":true,"status":"healthy"}
```

### Prometheus Metrics

```bash
curl http://localhost:6790/prometheus
```

Metrics include:
- `bunqueue_jobs_total{queue,state}` — Job counts by state
- `bunqueue_jobs_processed_total{queue}` — Total processed jobs
- `bunqueue_jobs_failed_total{queue}` — Total failed jobs
- `bunqueue_queue_latency_seconds{queue}` — Processing latency

### Statistics

```bash
curl http://localhost:6790/stats
```

```json
{
  "ok": true,
  "stats": {
    "waiting": 150,
    "active": 10,
    "delayed": 25,
    "completed": 10000,
    "failed": 50,
    "dlq": 5,
    "totalPushed": 10235,
    "totalPulled": 10085,
    "totalCompleted": 10000,
    "totalFailed": 50
  }
}
```

## Docker

### Build

```bash
docker build -t bunqueue .
```

### Run

```bash
# Basic
docker run -p 6789:6789 -p 6790:6790 bunqueue

# With persistence
docker run -p 6789:6789 -p 6790:6790 \
  -v bunqueue-data:/app/data \
  -e DATA_PATH=/app/data/bunqueue.db \
  bunqueue

# With authentication
docker run -p 6789:6789 -p 6790:6790 \
  -e AUTH_TOKENS=secret1,secret2 \
  bunqueue
```

### Docker Compose

```bash
# Production
docker compose up -d

# Development (hot reload)
docker compose --profile dev up bunqueue-dev
```

## Deployment

bunqueue requires a **persistent server** with filesystem access for SQLite. It is **not compatible** with serverless platforms like Vercel or Cloudflare Workers.

### Compatible Platforms

| Platform | Bun | SQLite | TCP | Notes |
|----------|:---:|:------:|:---:|-------|
| [Fly.io](https://fly.io) | ✅ | ✅ | ✅ | Recommended - persistent volumes, global deployment |
| [Railway](https://railway.app) | ✅ | ✅ | ✅ | Easy deploy from GitHub |
| [Render](https://render.com) | ✅ | ✅ | ✅ | Docker support, persistent disks |
| [DigitalOcean](https://digitalocean.com) | ✅ | ✅ | ✅ | App Platform or Droplets |
| Any VPS | ✅ | ✅ | ✅ | Full control |

### Fly.io (Recommended)

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Launch (uses existing Dockerfile)
fly launch

# Create persistent volume for SQLite
fly volumes create bunqueue_data --size 1

# Set secrets
fly secrets set AUTH_TOKENS=your-secret-token

# Deploy
fly deploy
```

Add to `fly.toml`:
```toml
[mounts]
  source = "bunqueue_data"
  destination = "/app/data"

[env]
  DATA_PATH = "/app/data/bunqueue.db"
```

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

```bash
# Or via CLI
railway login
railway init
railway up
```

### Not Compatible

| Platform | Reason |
|----------|--------|
| Vercel | Serverless functions, no persistent filesystem, no TCP |
| Cloudflare Workers | V8 isolates (not Bun), no filesystem, no TCP |
| AWS Lambda | Serverless, no persistent storage |
| Netlify Functions | Serverless, no filesystem |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        bunqueue Server                          │
├─────────────────────────────────────────────────────────────┤
│   HTTP/WS (Bun.serve)    │    TCP Protocol (Bun.listen)    │
├─────────────────────────────────────────────────────────────┤
│                      Core Engine                            │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐     │
│  │  Queues  │ │ Workers  │ │ Scheduler │ │   DLQ    │     │
│  │ (32 shards) │          │ │  (Cron)   │ │          │     │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘     │
├─────────────────────────────────────────────────────────────┤
│               SQLite (WAL mode, 256MB mmap)                 │
└─────────────────────────────────────────────────────────────┘
```

### Performance Optimizations

- **32 Shards** — Lock contention minimized with FNV-1a hash distribution
- **WAL Mode** — Concurrent reads during writes
- **Memory-mapped I/O** — 256MB mmap for fast access
- **Batch Operations** — Bulk inserts and updates
- **Bounded Collections** — Automatic memory cleanup

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run linter
bun run lint

# Format code
bun run format

# Type check
bun run typecheck

# Run all checks
bun run check
```

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with <a href="https://bun.sh">Bun</a> 🥟
</p>
