---
title: "HTTP REST API Reference"
description: "Complete HTTP API reference for bunqueue — 76 endpoints covering jobs, queues, DLQ, crons, webhooks, workers, rate limiting, and real-time events."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/server-mode.png
---

The HTTP API runs on port `6790` by default (`HTTP_PORT` env var). All request and response bodies are JSON (`Content-Type: application/json`) unless noted otherwise.

Every successful response includes `"ok": true`. Every error response includes `"ok": false` and an `"error"` string.

---

## Authentication

When `AUTH_TOKENS` is configured, all endpoints (except health probes and CORS preflight) require a Bearer token:

```bash
# Environment variable (comma-separated for multiple tokens)
AUTH_TOKENS=secret-token-1,secret-token-2
```

```bash
# Usage
curl -H "Authorization: Bearer secret-token-1" http://localhost:6790/stats
```

Token comparison uses constant-time equality to prevent timing attacks.

**Endpoints that skip authentication:**

| Endpoint | Reason |
|---|---|
| `GET /health` | Health check for load balancers |
| `GET /healthz`, `GET /live` | Kubernetes liveness probe |
| `GET /ready` | Kubernetes readiness probe |
| `OPTIONS *` | CORS preflight |

`GET /prometheus` optionally requires auth when `requireAuthForMetrics` is enabled.

**Unauthorized response** (`401`):

```json
{ "ok": false, "error": "Unauthorized" }
```

---

## CORS

Configured via `CORS_ALLOW_ORIGIN` (default: `*`).

Preflight (`OPTIONS`) returns:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

---

## Error Responses

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request — invalid JSON, missing required fields, validation failure |
| `401` | Unauthorized — missing or invalid Bearer token |
| `404` | Not found — unknown endpoint, job not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Rate Limiting

Per-IP rate limiting using a sliding window. Client IP is resolved from `X-Forwarded-For` > `X-Real-IP` > `unknown`.

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `Infinity` | Max requests per window per IP |
| `RATE_LIMIT_CLEANUP_MS` | `60000` | Cleanup interval for expired entries |

---

## Jobs

### Push a Job

```
POST /queues/:queue/jobs
```

```bash
curl -X POST http://localhost:6790/queues/emails/jobs \
  -H "Content-Type: application/json" \
  -d '{"data": {"to": "user@test.com", "subject": "Welcome"}, "priority": 10}'
```

**Request body** — only `data` is required:

| Field | Type | Default | Description |
|---|---|---|---|
| `data` | `any` | *(required)* | Job payload |
| `priority` | `number` | `0` | Higher = processed sooner |
| `delay` | `number` | `0` | Delay before available (ms) |
| `attempts` | `number` | `3` | Max retry attempts |
| `backoff` | `number` | `1000` | Retry backoff (ms) |
| `ttl` | `number` | — | Time-to-live from creation (ms) |
| `timeout` | `number` | — | Processing timeout (ms) |
| `uniqueKey` | `string` | — | Deduplication key |
| `jobId` | `string` | — | Custom ID (idempotent upsert) |
| `tags` | `string[]` | `[]` | Metadata tags |
| `groupId` | `string` | — | Group identifier for per-group concurrency |
| `lifo` | `boolean` | `false` | Last-in-first-out ordering |
| `removeOnComplete` | `boolean` | `false` | Auto-remove on completion |
| `removeOnFail` | `boolean` | `false` | Auto-remove on failure |
| `durable` | `boolean` | `false` | Bypass write buffer, immediate disk write |
| `dependsOn` | `string[]` | `[]` | Job IDs that must complete first |
| `repeat` | `object` | — | `{ every: ms, limit: n }` or `{ cron: "..." }` |

**Response** (`200`):

```json
{ "ok": true, "id": "019ce9d7-6983-7000-946f-48737be2b0f9" }
```

**Error** (`400`):

```json
{ "ok": false, "error": "Invalid JSON body" }
```

---

### Push Jobs in Bulk

```
POST /queues/:queue/jobs/bulk
```

```bash
curl -X POST http://localhost:6790/queues/emails/jobs/bulk \
  -H "Content-Type: application/json" \
  -d '{"jobs": [{"data": {"x": 1}}, {"data": {"x": 2}, "priority": 5}]}'
```

Each item in `jobs` supports all the same fields as a single push.

**Response** (`200`):

```json
{ "ok": true, "ids": ["id-1", "id-2"] }
```

---

### Pull a Job

```
GET /queues/:queue/jobs[?timeout=ms]
```

```bash
# Immediate return (no wait)
curl http://localhost:6790/queues/emails/jobs

# Long-poll for up to 5 seconds
curl http://localhost:6790/queues/emails/jobs?timeout=5000
```

**Response with job** (`200`):

```json
{
  "ok": true,
  "job": {
    "id": "019ce9d7-6983-7000-946f-48737be2b0f9",
    "queue": "emails",
    "data": { "to": "user@test.com" },
    "priority": 10,
    "createdAt": 1700000000000,
    "runAt": 1700000000000,
    "attempts": 0,
    "maxAttempts": 3,
    "progress": 0,
    "tags": []
  }
}
```

**No job available** (`200`):

```json
{ "ok": true, "job": null }
```

---

### Pull Jobs in Batch

```
POST /queues/:queue/jobs/pull-batch
```

```bash
curl -X POST http://localhost:6790/queues/emails/jobs/pull-batch \
  -H "Content-Type: application/json" \
  -d '{"count": 10, "timeout": 5000}'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `count` | `number` | Yes | Number of jobs to pull |
| `timeout` | `number` | No | Long-poll timeout (ms) |
| `owner` | `string` | No | Lock owner identifier |
| `lockTtl` | `number` | No | Lock time-to-live (ms) |

**Response** (`200`):

```json
{ "ok": true, "jobs": [{ ... }, { ... }], "tokens": ["tok-1", "tok-2"] }
```

---

### Get a Job

```
GET /jobs/:id
```

```bash
curl http://localhost:6790/jobs/019ce9d7-6983-7000-946f-48737be2b0f9
```

**Response** (`200`):

```json
{
  "ok": true,
  "job": {
    "id": "019ce9d7-6983-7000-946f-48737be2b0f9",
    "queue": "emails",
    "data": { "to": "user@test.com" },
    "priority": 0,
    "createdAt": 1700000000000,
    "runAt": 1700000000000,
    "attempts": 0,
    "maxAttempts": 3,
    "backoff": 1000,
    "progress": 0,
    "tags": [],
    "lifo": false,
    "removeOnComplete": false,
    "removeOnFail": false
  }
}
```

**Not found** (`404`):

```json
{ "ok": false, "error": "Job not found" }
```

---

### Get Job by Custom ID

```
GET /jobs/custom/:customId
```

```bash
curl http://localhost:6790/jobs/custom/email-user-123
```

Looks up a job by the `jobId` specified at push time.

---

### Get Job State

```
GET /jobs/:id/state
```

```bash
curl http://localhost:6790/jobs/019ce9d7-.../state
```

**Response** (`200`):

```json
{ "ok": true, "id": "019ce9d7-...", "state": "waiting" }
```

States: `waiting` | `delayed` | `active` | `completed` | `failed`

---

### Get Job Result

Retrieve the result of a completed job.

```
GET /jobs/:id/result
```

**Response** (`200`):

```json
{ "ok": true, "id": "019ce9d7-...", "result": { "sent": true, "messageId": "abc-123" } }
```

---

### Cancel a Job

```
DELETE /jobs/:id
```

```bash
curl -X DELETE http://localhost:6790/jobs/019ce9d7-...
```

**Response** (`200`): `{ "ok": true }`

---

### Acknowledge a Job

Mark a job as successfully completed, optionally storing a result.

```
POST /jobs/:id/ack
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../ack \
  -H "Content-Type: application/json" \
  -d '{"result": {"sent": true, "messageId": "abc-123"}}'
```

**Response** (`200`): `{ "ok": true }`

**Error** (`400`): `{ "ok": false, "error": "Job not found or not active" }`

---

### Acknowledge Jobs in Batch

```
POST /jobs/ack-batch
```

```bash
curl -X POST http://localhost:6790/jobs/ack-batch \
  -H "Content-Type: application/json" \
  -d '{"ids": ["id-1", "id-2", "id-3"], "results": [{"a": 1}, null, {"c": 3}]}'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | `string[]` | Yes | Job IDs to acknowledge |
| `results` | `unknown[]` | No | Per-job results (positional) |
| `tokens` | `string[]` | No | Lock tokens (positional) |

---

### Fail a Job

Mark a job as failed. If retry attempts remain, it's re-queued with exponential backoff. Otherwise it moves to the DLQ.

```
POST /jobs/:id/fail
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../fail \
  -H "Content-Type: application/json" \
  -d '{"error": "SMTP connection refused"}'
```

---

### Update Job Data

Edit the JSON payload of a job in-place (waiting, delayed, or active).

```
PUT /jobs/:id/data
```

```bash
curl -X PUT http://localhost:6790/jobs/019ce9d7-.../data \
  -H "Content-Type: application/json" \
  -d '{"data": {"to": "new@email.com", "subject": "Updated subject"}}'
```

**Response** (`200`): `{ "ok": true }`

**Error** (`400`): `{ "ok": false, "error": "Job not found or cannot be updated" }`

---

### Change Job Priority

```
PUT /jobs/:id/priority
```

```bash
curl -X PUT http://localhost:6790/jobs/019ce9d7-.../priority \
  -H "Content-Type: application/json" \
  -d '{"priority": 100}'
```

Only works on queued jobs (waiting/delayed).

---

### Promote a Delayed Job

Move a delayed job to waiting state for immediate processing.

```
POST /jobs/:id/promote
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../promote
```

**Error** (`400`): `{ "ok": false, "error": "Job not found or not delayed" }`

---

### Move to Waiting

Alias for Promote.

```
POST /jobs/:id/move-to-wait
```

---

### Move to Delayed

Move an active job back to delayed state.

```
POST /jobs/:id/move-to-delayed
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../move-to-delayed \
  -H "Content-Type: application/json" \
  -d '{"delay": 60000}'
```

---

### Change Delay

Update the delay of a delayed job.

```
PUT /jobs/:id/delay
```

```json
{ "delay": 30000 }
```

---

### Discard to DLQ

Move a job directly to the Dead Letter Queue.

```
POST /jobs/:id/discard
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../discard
```

---

### Wait for Job Completion

Long-poll until a job completes or the timeout expires.

```
POST /jobs/:id/wait
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../wait \
  -H "Content-Type: application/json" \
  -d '{"timeout": 30000}'
```

**Response** (`200`):

```json
{ "ok": true, "completed": true, "result": { "sent": true } }
```

---

### Get/Update Job Progress

**Get:**

```
GET /jobs/:id/progress
```

```json
{ "ok": true, "progress": 75, "message": "Processing attachments..." }
```

**Update:**

```
POST /jobs/:id/progress
```

```json
{ "progress": 75, "message": "Processing attachments..." }
```

---

### Get Children Values

Get the results of child jobs in a flow/pipeline.

```
GET /jobs/:id/children
```

```json
{ "ok": true, "values": { "child-1": { "result": "..." }, "child-2": { "result": "..." } } }
```

---

### Job Heartbeat

Send a heartbeat to prevent stall detection from marking the job as stalled.

```
POST /jobs/:id/heartbeat
```

```json
{ "token": "lock-token", "duration": 30000 }
```

Both fields are optional.

---

### Job Heartbeat Batch

```
POST /jobs/heartbeat-batch
```

```json
{ "ids": ["id-1", "id-2"], "tokens": ["tok-1", "tok-2"] }
```

---

### Extend Lock

Extend the lock TTL on an active job.

```
POST /jobs/:id/extend-lock
```

```json
{ "duration": 30000, "token": "lock-token" }
```

---

### Extend Locks (Batch)

```
POST /jobs/extend-locks
```

```json
{
  "ids": ["id-1", "id-2"],
  "tokens": ["tok-1", "tok-2"],
  "durations": [30000, 60000]
}
```

---

### Job Logs

Structured logging attached to individual jobs.

**Add a log entry:**

```
POST /jobs/:id/logs
```

```bash
curl -X POST http://localhost:6790/jobs/019ce9d7-.../logs \
  -H "Content-Type: application/json" \
  -d '{"message": "Connecting to SMTP server...", "level": "info"}'
```

Levels: `info` | `warn` | `error`

**Get all logs:**

```
GET /jobs/:id/logs
```

**Clear logs:**

```
DELETE /jobs/:id/logs
```

---

## Queues

### List All Queues

```
GET /queues
```

```bash
curl http://localhost:6790/queues
```

**Response** (`200`):

```json
{ "ok": true, "queues": ["emails", "notifications", "reports"] }
```

---

### List Jobs by State

```
GET /queues/:queue/jobs/list[?state=waiting&limit=10&offset=0]
```

```bash
curl "http://localhost:6790/queues/emails/jobs/list?state=waiting&limit=20"
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `state` | `string` | all | `waiting`, `delayed`, `active` |
| `limit` | `number` | all | Max jobs to return |
| `offset` | `number` | `0` | Skip N jobs |

**Response** (`200`):

```json
{ "ok": true, "jobs": [{ "id": "...", "data": { ... }, "priority": 5, "createdAt": 1700000000000 }] }
```

---

### Get Job Counts

```
GET /queues/:queue/counts
```

```bash
curl http://localhost:6790/queues/emails/counts
```

**Response** (`200`):

```json
{
  "ok": true,
  "counts": { "waiting": 150, "active": 12, "delayed": 30, "completed": 5000, "failed": 3 }
}
```

---

### Get Total Count

```
GET /queues/:queue/count
```

**Response** (`200`):

```json
{ "ok": true, "count": 192 }
```

---

### Get Counts per Priority

```
GET /queues/:queue/priority-counts
```

**Response** (`200`):

```json
{ "ok": true, "queue": "emails", "counts": { "0": 100, "5": 30, "10": 12 } }
```

---

### Check If Paused

```
GET /queues/:queue/paused
```

**Response** (`200`):

```json
{ "ok": true, "paused": false }
```

---

### Pause a Queue

Stop processing new jobs. Active jobs continue to completion.

```
POST /queues/:queue/pause
```

```bash
curl -X POST http://localhost:6790/queues/emails/pause
```

---

### Resume a Queue

```
POST /queues/:queue/resume
```

```bash
curl -X POST http://localhost:6790/queues/emails/resume
```

---

### Drain a Queue

Remove all waiting and delayed jobs. Active jobs are not affected.

```
POST /queues/:queue/drain
```

```bash
curl -X POST http://localhost:6790/queues/emails/drain
```

**Response** (`200`):

```json
{ "ok": true, "count": 150 }
```

---

### Obliterate a Queue

Completely destroy a queue and remove all its jobs from memory.

```
POST /queues/:queue/obliterate
```

```bash
curl -X POST http://localhost:6790/queues/emails/obliterate
```

:::caution
This is irreversible. All jobs in the queue are permanently deleted.
:::

---

### Clean a Queue

Remove jobs older than a grace period, optionally filtered by state.

```
POST /queues/:queue/clean
```

```bash
curl -X POST http://localhost:6790/queues/emails/clean \
  -H "Content-Type: application/json" \
  -d '{"grace": 86400000, "state": "waiting", "limit": 500}'
```

| Field | Type | Default | Description |
|---|---|---|---|
| `grace` | `number` | `0` | Only remove jobs older than this (ms) |
| `state` | `string` | all | `waiting` or `delayed` |
| `limit` | `number` | `1000` | Max jobs to remove per call |

**Response** (`200`):

```json
{ "ok": true, "count": 42 }
```

---

### Promote All Delayed Jobs

Move all (or N) delayed jobs in a queue to waiting state.

```
POST /queues/:queue/promote-jobs
```

```bash
curl -X POST http://localhost:6790/queues/emails/promote-jobs \
  -H "Content-Type: application/json" \
  -d '{"count": 50}'
```

Omit `count` to promote all delayed jobs.

---

### Retry Completed Jobs

Re-queue completed jobs for reprocessing.

```
POST /queues/:queue/retry-completed
```

```bash
# Retry a specific job
curl -X POST http://localhost:6790/queues/emails/retry-completed \
  -H "Content-Type: application/json" \
  -d '{"id": "019ce9d7-..."}'

# Retry all completed jobs
curl -X POST http://localhost:6790/queues/emails/retry-completed
```

---

## Dead Letter Queue (DLQ)

Jobs that exhaust all retry attempts or are explicitly discarded land in the DLQ.

### List DLQ Jobs

```
GET /queues/:queue/dlq[?count=100]
```

```bash
curl "http://localhost:6790/queues/emails/dlq?count=50"
```

**Response** (`200`):

```json
{
  "ok": true,
  "jobs": [
    { "id": "...", "data": { ... }, "attempts": 3, "createdAt": 1700000000000 }
  ]
}
```

---

### Retry DLQ Jobs

```
POST /queues/:queue/dlq/retry
```

```bash
# Retry a specific DLQ job
curl -X POST http://localhost:6790/queues/emails/dlq/retry \
  -H "Content-Type: application/json" \
  -d '{"jobId": "019ce9d7-..."}'

# Retry all DLQ jobs
curl -X POST http://localhost:6790/queues/emails/dlq/retry
```

**Response** (`200`):

```json
{ "ok": true, "count": 5 }
```

---

### Purge DLQ

Remove all jobs from the DLQ permanently.

```
POST /queues/:queue/dlq/purge
```

```bash
curl -X POST http://localhost:6790/queues/emails/dlq/purge
```

**Response** (`200`):

```json
{ "ok": true, "count": 12 }
```

---

## Rate Limiting & Concurrency

Per-queue controls for throughput and parallelism.

### Set Rate Limit

```
PUT /queues/:queue/rate-limit
```

```bash
curl -X PUT http://localhost:6790/queues/emails/rate-limit \
  -H "Content-Type: application/json" \
  -d '{"limit": 100}'
```

### Clear Rate Limit

```
DELETE /queues/:queue/rate-limit
```

```bash
curl -X DELETE http://localhost:6790/queues/emails/rate-limit
```

### Set Concurrency Limit

```
PUT /queues/:queue/concurrency
```

```bash
curl -X PUT http://localhost:6790/queues/emails/concurrency \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}'
```

### Clear Concurrency Limit

```
DELETE /queues/:queue/concurrency
```

---

## Queue Configuration

### Stall Detection

**Get current config:**

```
GET /queues/:queue/stall-config
```

**Update config:**

```
PUT /queues/:queue/stall-config
```

```bash
curl -X PUT http://localhost:6790/queues/emails/stall-config \
  -H "Content-Type: application/json" \
  -d '{"config": {"stallInterval": 30000, "maxStalls": 3, "gracePeriod": 5000}}'
```

### DLQ Configuration

**Get current config:**

```
GET /queues/:queue/dlq-config
```

**Update config:**

```
PUT /queues/:queue/dlq-config
```

```bash
curl -X PUT http://localhost:6790/queues/emails/dlq-config \
  -H "Content-Type: application/json" \
  -d '{"config": {"autoRetry": true, "maxAge": 604800000, "maxEntries": 10000}}'
```

---

## Cron Jobs

### List All Crons

```
GET /crons
```

```bash
curl http://localhost:6790/crons
```

**Response** (`200`):

```json
{
  "ok": true,
  "crons": [
    { "name": "daily-cleanup", "queue": "maintenance", "schedule": "0 2 * * *", "nextRun": 1700100000000, "executions": 42 }
  ]
}
```

---

### Add a Cron Job

```
POST /crons
```

```bash
curl -X POST http://localhost:6790/crons \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-cleanup",
    "queue": "maintenance",
    "data": {"task": "cleanup-stale-sessions"},
    "schedule": "0 2 * * *",
    "timezone": "America/New_York",
    "priority": 5,
    "maxLimit": 100
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique cron identifier |
| `queue` | `string` | Yes | Target queue |
| `data` | `any` | Yes | Job payload |
| `schedule` | `string` | * | Cron expression (e.g. `"*/5 * * * *"`) |
| `repeatEvery` | `number` | * | Repeat interval in ms |
| `timezone` | `string` | No | IANA timezone (default: UTC) |
| `priority` | `number` | No | Job priority |
| `maxLimit` | `number` | No | Max total executions |

\* Either `schedule` or `repeatEvery` is required.

---

### Get a Cron Job

```
GET /crons/:name
```

```bash
curl http://localhost:6790/crons/daily-cleanup
```

---

### Delete a Cron Job

```
DELETE /crons/:name
```

```bash
curl -X DELETE http://localhost:6790/crons/daily-cleanup
```

---

## Webhooks

### List All Webhooks

```
GET /webhooks
```

```bash
curl http://localhost:6790/webhooks
```

---

### Add a Webhook

```
POST /webhooks
```

```bash
curl -X POST http://localhost:6790/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/hooks/bunqueue",
    "events": ["completed", "failed"],
    "queue": "emails",
    "secret": "whsec_abc123"
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | Webhook endpoint URL |
| `events` | `string[]` | Yes | Event types to subscribe to |
| `queue` | `string` | No | Filter to specific queue |
| `secret` | `string` | No | HMAC signing secret |

**Response** (`200`):

```json
{
  "ok": true,
  "data": { "webhookId": "wh-abc123", "url": "https://...", "events": ["completed", "failed"], "createdAt": 1700000000000 }
}
```

---

### Remove a Webhook

```
DELETE /webhooks/:id
```

```bash
curl -X DELETE http://localhost:6790/webhooks/wh-abc123
```

---

### Enable/Disable a Webhook

```
PUT /webhooks/:id/enabled
```

```bash
curl -X PUT http://localhost:6790/webhooks/wh-abc123/enabled \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

## Workers

### List All Workers

```
GET /workers
```

```bash
curl http://localhost:6790/workers
```

**Response** (`200`):

```json
{
  "ok": true,
  "data": {
    "workers": [
      { "id": "w-1", "name": "email-worker", "queues": ["emails"], "lastSeen": 1700000000000, "activeJobs": 3, "processedJobs": 1500, "failedJobs": 12 }
    ],
    "stats": { "total": 4, "active": 3 }
  }
}
```

---

### Register a Worker

```
POST /workers
```

```bash
curl -X POST http://localhost:6790/workers \
  -H "Content-Type: application/json" \
  -d '{"name": "email-worker-1", "queues": ["emails", "notifications"]}'
```

---

### Unregister a Worker

```
DELETE /workers/:id
```

```bash
curl -X DELETE http://localhost:6790/workers/w-1
```

---

### Worker Heartbeat

Keep a worker's registration alive.

```
POST /workers/:id/heartbeat
```

```bash
curl -X POST http://localhost:6790/workers/w-1/heartbeat
```

---

## Monitoring

### Health Check

Detailed health info including queue counts, connections, and memory.

```
GET /health
```

No authentication required.

**Response** (`200`):

```json
{
  "ok": true,
  "status": "healthy",
  "uptime": 86400,
  "version": "2.6.13",
  "queues": { "waiting": 150, "active": 12, "delayed": 30, "completed": 50000, "dlq": 3 },
  "connections": { "tcp": 8, "ws": 4, "sse": 2 },
  "memory": { "heapUsed": 45, "heapTotal": 64, "rss": 82 }
}
```

Memory in MB. Uptime in seconds.

---

### Liveness Probes

```
GET /healthz
GET /live
```

Returns plain text `OK` with status `200`. No auth.

---

### Readiness Probe

```
GET /ready
```

```json
{ "ok": true, "ready": true }
```

No auth.

---

### Ping

```
GET /ping
```

```json
{ "ok": true, "data": { "pong": true, "time": 1700000000000 } }
```

---

### Stats

Server statistics with throughput counters, memory, and internal collection sizes.

```
GET /stats
```

```bash
curl http://localhost:6790/stats
```

**Response** (`200`):

```json
{
  "ok": true,
  "stats": {
    "waiting": 150, "active": 12, "delayed": 30, "completed": 50000, "dlq": 3,
    "totalPushed": 100000, "totalPulled": 99500, "totalCompleted": 98000, "totalFailed": 200,
    "uptime": 86400
  },
  "memory": { "heapUsed": 45, "heapTotal": 64, "rss": 82, "external": 2, "arrayBuffers": 1 },
  "collections": { "jobIndex": 1500, "completedJobs": 5000, "processingTotal": 12, "queuedTotal": 150, "temporalIndexTotal": 30 }
}
```

---

### Metrics (JSON)

```
GET /metrics
```

```json
{
  "ok": true,
  "metrics": { "totalPushed": 100000, "totalPulled": 99500, "totalCompleted": 98000, "totalFailed": 200 }
}
```

---

### Prometheus Metrics

```
GET /prometheus
```

Returns `text/plain; version=0.0.4` for Prometheus scraping. Includes per-queue gauges and latency histograms.

Optionally requires auth (`requireAuthForMetrics`).

---

### Storage Status

```
GET /storage
```

Returns disk health. When `diskFull` is `true`, the server stops accepting new jobs.

```json
{ "ok": true, "diskFull": false }
```

---

### Force Garbage Collection

```
POST /gc
```

Triggers Bun GC and `compactMemory()`. Returns before/after heap stats.

```json
{
  "ok": true,
  "before": { "heapUsed": 52, "heapTotal": 64, "rss": 90 },
  "after": { "heapUsed": 45, "heapTotal": 64, "rss": 85 }
}
```

---

### Heap Stats

```
GET /heapstats
```

Detailed V8/JSC heap breakdown. Returns top 20 object types by count. Useful for debugging memory leaks.

---

## Real-time Events

### Server-Sent Events (SSE)

```
GET /events
GET /events/queues/:queue
```

```javascript
const events = new EventSource('http://localhost:6790/events/queues/emails');
events.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.connected) return; // initial connection message
  console.log(`[${data.eventType}] Job ${data.jobId}`);
};
```

For authenticated SSE, use a library like `@microsoft/fetch-event-source` (native `EventSource` does not support custom headers).

### WebSocket

```
ws://localhost:6790/ws
ws://localhost:6790/ws/queues/:queue
```

WebSocket clients receive the same events as SSE and can send commands as JSON:

```javascript
const ws = new WebSocket('ws://localhost:6790/ws');
ws.onopen = () => {
  ws.send(JSON.stringify({ cmd: 'PUSH', queue: 'emails', data: { to: 'user@test.com' }, reqId: '1' }));
};
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.reqId) console.log('Response:', msg);        // command response
  else if (msg.eventType) console.log('Event:', msg);  // broadcast event
};
```

Authentication via `Authorization: Bearer` header at handshake, or `{ "cmd": "Auth", "token": "..." }` after connect.

When a WebSocket disconnects, all jobs owned by that client are released back to the queue.

### Event Types

| eventType | Description |
|---|---|
| `pushed` | Job added to queue |
| `pulled` | Job pulled for processing |
| `completed` | Job completed successfully |
| `failed` | Job processing failed |
| `progress` | Job progress updated |
| `stalled` | Job detected as stalled |
| `removed` | Job removed |
| `delayed` | Job moved to delayed state |
| `duplicated` | Duplicate job detected |
| `retried` | Job retried |
| `waiting-children` | Job waiting for children |
| `drained` | Queue was drained |

---

## Endpoint Summary

### Jobs (30 endpoints)

| Method | Path | Description |
|---|---|---|
| `POST` | `/queues/:q/jobs` | Push a job |
| `POST` | `/queues/:q/jobs/bulk` | Push jobs in bulk |
| `GET` | `/queues/:q/jobs` | Pull a job |
| `POST` | `/queues/:q/jobs/pull-batch` | Pull jobs in batch |
| `GET` | `/jobs/:id` | Get job by ID |
| `GET` | `/jobs/custom/:customId` | Get job by custom ID |
| `DELETE` | `/jobs/:id` | Cancel a job |
| `POST` | `/jobs/:id/ack` | Acknowledge a job |
| `POST` | `/jobs/ack-batch` | Acknowledge batch |
| `POST` | `/jobs/:id/fail` | Fail a job |
| `GET` | `/jobs/:id/state` | Get job state |
| `GET` | `/jobs/:id/result` | Get job result |
| `GET` | `/jobs/:id/progress` | Get progress |
| `POST` | `/jobs/:id/progress` | Update progress |
| `PUT` | `/jobs/:id/data` | Update job data |
| `PUT` | `/jobs/:id/priority` | Change priority |
| `POST` | `/jobs/:id/promote` | Promote delayed job |
| `POST` | `/jobs/:id/move-to-wait` | Move to waiting |
| `POST` | `/jobs/:id/move-to-delayed` | Move to delayed |
| `PUT` | `/jobs/:id/delay` | Change delay |
| `POST` | `/jobs/:id/discard` | Discard to DLQ |
| `POST` | `/jobs/:id/wait` | Wait for completion |
| `GET` | `/jobs/:id/children` | Get children values |
| `POST` | `/jobs/:id/heartbeat` | Job heartbeat |
| `POST` | `/jobs/heartbeat-batch` | Job heartbeat batch |
| `POST` | `/jobs/:id/extend-lock` | Extend lock |
| `POST` | `/jobs/extend-locks` | Extend locks batch |
| `GET` | `/jobs/:id/logs` | Get logs |
| `POST` | `/jobs/:id/logs` | Add log |
| `DELETE` | `/jobs/:id/logs` | Clear logs |

### Queues (13 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET` | `/queues` | List all queues |
| `GET` | `/queues/:q/jobs/list` | List jobs by state |
| `GET` | `/queues/:q/counts` | Job counts per state |
| `GET` | `/queues/:q/count` | Total job count |
| `GET` | `/queues/:q/priority-counts` | Counts per priority |
| `GET` | `/queues/:q/paused` | Check if paused |
| `POST` | `/queues/:q/pause` | Pause queue |
| `POST` | `/queues/:q/resume` | Resume queue |
| `POST` | `/queues/:q/drain` | Drain queue |
| `POST` | `/queues/:q/obliterate` | Obliterate queue |
| `POST` | `/queues/:q/clean` | Clean old jobs |
| `POST` | `/queues/:q/promote-jobs` | Promote delayed jobs |
| `POST` | `/queues/:q/retry-completed` | Retry completed jobs |

### DLQ (3 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET` | `/queues/:q/dlq` | List DLQ jobs |
| `POST` | `/queues/:q/dlq/retry` | Retry DLQ jobs |
| `POST` | `/queues/:q/dlq/purge` | Purge DLQ |

### Rate Limiting & Concurrency (4 endpoints)

| Method | Path | Description |
|---|---|---|
| `PUT` | `/queues/:q/rate-limit` | Set rate limit |
| `DELETE` | `/queues/:q/rate-limit` | Clear rate limit |
| `PUT` | `/queues/:q/concurrency` | Set concurrency |
| `DELETE` | `/queues/:q/concurrency` | Clear concurrency |

### Configuration (4 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET/PUT` | `/queues/:q/stall-config` | Stall detection config |
| `GET/PUT` | `/queues/:q/dlq-config` | DLQ config |

### Crons (4 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET` | `/crons` | List crons |
| `POST` | `/crons` | Add cron |
| `GET` | `/crons/:name` | Get cron |
| `DELETE` | `/crons/:name` | Delete cron |

### Webhooks (4 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET` | `/webhooks` | List webhooks |
| `POST` | `/webhooks` | Add webhook |
| `DELETE` | `/webhooks/:id` | Remove webhook |
| `PUT` | `/webhooks/:id/enabled` | Toggle webhook |

### Workers (4 endpoints)

| Method | Path | Description |
|---|---|---|
| `GET` | `/workers` | List workers |
| `POST` | `/workers` | Register worker |
| `DELETE` | `/workers/:id` | Unregister worker |
| `POST` | `/workers/:id/heartbeat` | Worker heartbeat |

### Monitoring (11 endpoints)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET` | `/healthz` | No | Liveness probe |
| `GET` | `/live` | No | Liveness probe |
| `GET` | `/ready` | No | Readiness probe |
| `GET` | `/ping` | Yes | Ping/pong |
| `GET` | `/stats` | Yes | Server statistics |
| `GET` | `/metrics` | Yes | Throughput metrics |
| `GET` | `/prometheus` | Optional | Prometheus metrics |
| `GET` | `/storage` | Yes | Storage health |
| `POST` | `/gc` | Yes | Force GC + compact |
| `GET` | `/heapstats` | Yes | Heap statistics |

### Real-time (4 channels)

| Protocol | Path | Description |
|---|---|---|
| SSE | `/events` | All events |
| SSE | `/events/queues/:q` | Queue-filtered events |
| WebSocket | `/ws` | Bidirectional (all) |
| WebSocket | `/ws/queues/:q` | Bidirectional (filtered) |

:::tip[Related]
- [TCP Protocol Reference](/api/tcp/) — binary TCP protocol (same 76 commands)
- [TypeScript Types](/api/types/) — type definitions for all APIs
- [Server Mode](/guide/server/) — run the HTTP API server
:::
