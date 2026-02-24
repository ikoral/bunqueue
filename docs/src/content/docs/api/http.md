---
title: "bunqueue HTTP REST API Reference"
description: "Complete HTTP API reference for bunqueue: job push/pull endpoints, health checks, Prometheus metrics, WebSocket events, and auth."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/server-mode.png
---

The HTTP API is available on port `6790` by default (configurable via `HTTP_PORT`). All request and response bodies use JSON (`Content-Type: application/json`) unless otherwise noted.

## Authentication

When `AUTH_TOKENS` is set, all endpoints (except health probes and CORS preflight) require a Bearer token.

```http
Authorization: Bearer <token>
```

Configure one or more tokens via the `AUTH_TOKENS` environment variable (comma-separated):

```bash
AUTH_TOKENS=secret-token-1,secret-token-2
```

Token comparison uses constant-time equality to prevent timing attacks.

**Endpoints that skip authentication:**

| Endpoint | Reason |
|---|---|
| `GET /health` | Health check |
| `GET /healthz` | Kubernetes liveness probe |
| `GET /live` | Kubernetes liveness probe |
| `GET /ready` | Kubernetes readiness probe |
| `POST /gc` | Debug endpoint |
| `GET /heapstats` | Debug endpoint |
| `OPTIONS *` | CORS preflight |

The `GET /prometheus` endpoint optionally requires auth when `requireAuthForMetrics` is enabled in the server configuration.

**Unauthorized response:**

```json
{ "ok": false, "error": "Unauthorized" }
```

Status code: `401`

---

## CORS

CORS is configured via the `CORS_ALLOW_ORIGIN` environment variable. The default is `*` (allow all origins).

**Preflight response** (`OPTIONS` on any path):

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

All JSON responses include the `Access-Control-Allow-Origin` header.

---

## Error Response Format

All errors follow a consistent format:

```json
{
  "ok": false,
  "error": "Description of the error"
}
```

**Standard status codes:**

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request (invalid JSON, missing fields, validation failure) |
| `401` | Unauthorized (missing or invalid token) |
| `404` | Not found (unknown endpoint or job not found) |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Rate Limiting

HTTP requests are rate-limited per client IP. The client IP is determined from the `X-Forwarded-For` or `X-Real-IP` headers, falling back to `"unknown"`.

Configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `Infinity` | Max requests per window per IP |
| `RATE_LIMIT_CLEANUP_MS` | `60000` | Cleanup interval for expired entries (ms) |

**Rate-limited response:**

```json
{ "ok": false, "error": "Rate limit exceeded" }
```

Status code: `429`

---

## Job Endpoints

### Push a Job

Add a new job to a queue.

```
POST /queues/:queue/jobs
```

**Request body:**

```json
{
  "data": { "to": "user@test.com", "subject": "Welcome" },
  "priority": 10,
  "delay": 5000,
  "maxAttempts": 5,
  "backoff": 2000,
  "ttl": 86400000,
  "timeout": 30000,
  "uniqueKey": "email-user-123",
  "jobId": "custom-id-1",
  "tags": ["email", "onboarding"],
  "groupId": "batch-1",
  "lifo": false,
  "removeOnComplete": false,
  "removeOnFail": false,
  "durable": false,
  "dependsOn": ["job-id-1", "job-id-2"],
  "repeat": { "every": 60000, "limit": 10 }
}
```

Only `data` is required. All other fields are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `data` | `any` | *(required)* | Job payload |
| `priority` | `number` | `0` | Higher value = processed sooner |
| `delay` | `number` | `0` | Delay before processing (ms) |
| `maxAttempts` | `number` | `3` | Maximum retry attempts |
| `backoff` | `number` | `1000` | Retry backoff delay (ms) |
| `ttl` | `number` | `null` | Time-to-live from creation (ms) |
| `timeout` | `number` | `null` | Processing timeout (ms) |
| `uniqueKey` | `string` | `null` | Deduplication key |
| `jobId` | `string` | `null` | Custom job ID (idempotent) |
| `tags` | `string[]` | `[]` | Metadata tags |
| `groupId` | `string` | `null` | Group identifier |
| `lifo` | `boolean` | `false` | Last-in-first-out ordering |
| `removeOnComplete` | `boolean` | `false` | Auto-remove on completion |
| `removeOnFail` | `boolean` | `false` | Auto-remove on failure |
| `durable` | `boolean` | `false` | Bypass write buffer for immediate disk persistence |
| `dependsOn` | `string[]` | `[]` | Job IDs that must complete first |
| `repeat` | `object` | `null` | Repeat configuration |

**Success response** (`200`):

```json
{ "ok": true, "id": "01924f5a-7b3c-7def-8a12-3456789abcde" }
```

**Error response** (`400`):

```json
{ "ok": false, "error": "Invalid JSON body" }
```

---

### Pull a Job

Pull the next available job from a queue.

```
GET /queues/:queue/jobs
```

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | `0` | Long-poll timeout in ms (0 = return immediately) |

**Example:**

```
GET /queues/emails/jobs?timeout=5000
```

**Success response with job** (`200`):

```json
{
  "ok": true,
  "job": {
    "id": "01924f5a-7b3c-7def-8a12-3456789abcde",
    "queue": "emails",
    "data": { "to": "user@test.com" },
    "priority": 10,
    "createdAt": 1700000000000,
    "attempts": 0,
    "maxAttempts": 3,
    "progress": 0
  },
  "token": "01924f5a-9c4d-7abc-b123-456789abcdef"
}
```

The `token` is a lock token for job ownership. Use it when acknowledging or failing the job.

**No job available** (`200`):

```json
{ "ok": true, "job": null, "token": null }
```

---

### Get a Job

Retrieve a job by ID.

```
GET /jobs/:id
```

**Success response** (`200`):

```json
{
  "ok": true,
  "job": {
    "id": "01924f5a-7b3c-7def-8a12-3456789abcde",
    "queue": "emails",
    "data": { "to": "user@test.com" },
    "priority": 0,
    "createdAt": 1700000000000,
    "runAt": 1700000000000,
    "startedAt": null,
    "completedAt": null,
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

### Cancel a Job

Cancel a job by ID.

```
DELETE /jobs/:id
```

**Success response** (`200`):

```json
{ "ok": true }
```

---

### Acknowledge a Job

Mark a job as completed, optionally with a result.

```
POST /jobs/:id/ack
```

**Request body** (optional):

```json
{
  "result": { "sent": true, "messageId": "abc-123" }
}
```

**Success response** (`200`):

```json
{ "ok": true }
```

**Error response** (`400`):

```json
{ "ok": false, "error": "Job not found or not active" }
```

---

### Fail a Job

Mark a job as failed, optionally with an error message.

```
POST /jobs/:id/fail
```

**Request body** (optional):

```json
{
  "error": "SMTP connection refused"
}
```

**Success response** (`200`):

```json
{ "ok": true }
```

If the job has remaining retry attempts, it will be re-queued with exponential backoff. Otherwise it moves to the dead-letter queue (DLQ).

---

## Monitoring Endpoints

### Health Check

Detailed health information including queue counts, connection counts, and memory usage.

```
GET /health
```

**Response** (`200`):

```json
{
  "ok": true,
  "status": "healthy",
  "uptime": 3600,
  "version": "2.1.8",
  "queues": {
    "waiting": 150,
    "active": 12,
    "delayed": 30,
    "completed": 5000,
    "dlq": 3
  },
  "connections": {
    "tcp": 0,
    "ws": 4,
    "sse": 2
  },
  "memory": {
    "heapUsed": 45,
    "heapTotal": 64,
    "rss": 82
  }
}
```

Memory values are in MB. Uptime is in seconds.

---

### Liveness Probes

Simple endpoints for Kubernetes liveness checks. No authentication required.

```
GET /healthz
GET /live
```

**Response** (`200`):

```
OK
```

Content-Type: `text/plain`

---

### Readiness Probe

Kubernetes readiness check. No authentication required.

```
GET /ready
```

**Response** (`200`):

```json
{ "ok": true, "ready": true }
```

---

### Stats

Detailed server statistics including throughput counters, memory usage, and internal collection sizes.

```
GET /stats
```

**Response** (`200`):

```json
{
  "ok": true,
  "stats": {
    "queued": 150,
    "processing": 12,
    "delayed": 30,
    "dlq": 3,
    "completed": 5000,
    "uptime": 3600,
    "pushPerSec": 245,
    "pullPerSec": 240,
    "totalPushed": 100000,
    "totalPulled": 99500,
    "totalCompleted": 98000,
    "totalFailed": 200
  },
  "memory": {
    "heapUsed": 45,
    "heapTotal": 64,
    "rss": 82,
    "external": 2,
    "arrayBuffers": 1
  },
  "collections": {
    "jobIndex": 1500,
    "completedJobs": 5000,
    "processingTotal": 12,
    "queuedTotal": 150,
    "temporalIndexTotal": 30
  }
}
```

---

### Metrics (JSON)

Aggregated throughput counters in JSON format.

```
GET /metrics
```

**Response** (`200`):

```json
{
  "ok": true,
  "metrics": {
    "totalPushed": 100000,
    "totalPulled": 99500,
    "totalCompleted": 98000,
    "totalFailed": 200
  }
}
```

> **Note:** This endpoint returns JSON, not Prometheus text format. For Prometheus scraping, use `/prometheus`.

---

### Prometheus Metrics

Prometheus-compatible text format for scraping.

```
GET /prometheus
```

Optionally requires authentication when `requireAuthForMetrics` is enabled.

**Response** (`200`):

```
Content-Type: text/plain; version=0.0.4; charset=utf-8
```

```
# HELP bunqueue_jobs_pushed_total Total jobs pushed
# TYPE bunqueue_jobs_pushed_total counter
bunqueue_jobs_pushed_total 100000
# HELP bunqueue_jobs_completed_total Total jobs completed
# TYPE bunqueue_jobs_completed_total counter
bunqueue_jobs_completed_total 98000

# Per-queue metrics with labels
bunqueue_queue_jobs_waiting{queue="emails"} 30
bunqueue_queue_jobs_active{queue="emails"} 5
bunqueue_queue_jobs_delayed{queue="emails"} 0
bunqueue_queue_jobs_dlq{queue="emails"} 2

# Latency histograms
# HELP bunqueue_push_duration_ms Push operation latency in ms
# TYPE bunqueue_push_duration_ms histogram
bunqueue_push_duration_ms_bucket{le="0.1"} 120
bunqueue_push_duration_ms_bucket{le="1"} 95000
bunqueue_push_duration_ms_bucket{le="+Inf"} 100000
bunqueue_push_duration_ms_sum 8500.2
bunqueue_push_duration_ms_count 100000
...
```

---

## Debug Endpoints

### Force Garbage Collection

Trigger garbage collection and memory compaction. No authentication required.

```
POST /gc
```

**Response** (`200`):

```json
{
  "ok": true,
  "before": {
    "heapUsed": 52,
    "heapTotal": 64,
    "rss": 90
  },
  "after": {
    "heapUsed": 45,
    "heapTotal": 64,
    "rss": 85
  }
}
```

Memory values are in MB.

---

### Heap Stats

Detailed heap statistics for debugging memory leaks. No authentication required.

```
GET /heapstats
```

**Response** (`200`):

```json
{
  "ok": true,
  "memory": {
    "heapUsed": 45,
    "heapTotal": 64,
    "rss": 82
  },
  "heap": {
    "objectCount": 125000,
    "protectedCount": 1200,
    "globalCount": 350
  },
  "collections": {
    "jobIndex": 1500,
    "completedJobs": 5000,
    "processingTotal": 12,
    "queuedTotal": 150,
    "temporalIndexTotal": 30
  },
  "topObjectTypes": [
    { "type": "Object", "count": 45000 },
    { "type": "Array", "count": 12000 },
    { "type": "String", "count": 8500 }
  ]
}
```

The `topObjectTypes` list shows the top 20 object types by count.

---

## Server-Sent Events (SSE)

Subscribe to real-time job events over an SSE connection.

### Connect to All Events

```
GET /events
```

### Filter by Queue

```
GET /events/queues/:queue
```

**Example:**

```
GET /events/queues/emails
```

Authentication is required when `AUTH_TOKENS` is configured. Pass the token via the `Authorization` header.

### Connection Message

On connect, the server sends an initial message:

```
data: {"connected":true,"clientId":"01924f5a-7b3c-7def-8a12-3456789abcde"}
```

### Event Format

All events are sent as `data:` messages (no named event types). Each message is a JSON object:

```
data: {"eventType":"completed","queue":"emails","jobId":"01924f5a-7b3c-7def-8a12-3456789abcde","timestamp":1700000000000}
```

### Event Types

| eventType | Description | Extra Fields |
|---|---|---|
| `pushed` | Job was added to a queue | `data` |
| `pulled` | Job was pulled for processing | |
| `completed` | Job completed successfully | |
| `failed` | Job processing failed | `error` |
| `progress` | Job progress was updated | `progress` |
| `stalled` | Job was detected as stalled | |
| `removed` | Job was removed | `prev` (previous state) |
| `delayed` | Job was moved to delayed state | `delay` (ms) |
| `duplicated` | Duplicate job was detected | |
| `retried` | Job was retried | `prev` (previous state) |
| `waiting-children` | Job is waiting for child jobs | |
| `drained` | Queue was drained | |

### JavaScript Example

```javascript
const events = new EventSource('http://localhost:6790/events/queues/emails');

events.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.connected) {
    console.log('Connected with client ID:', data.clientId);
    return;
  }
  console.log(`[${data.eventType}] Job ${data.jobId} in queue ${data.queue}`);
};

events.onerror = () => {
  console.log('SSE connection error, will auto-reconnect');
};
```

### Authenticated SSE Example

```javascript
// EventSource does not support custom headers natively.
// Use a library like eventsource or fetch-event-source:
import { fetchEventSource } from '@microsoft/fetch-event-source';

await fetchEventSource('http://localhost:6790/events/queues/emails', {
  headers: { Authorization: 'Bearer my-secret-token' },
  onmessage(event) {
    const data = JSON.parse(event.data);
    console.log(data.eventType, data.jobId);
  },
});
```

---

## WebSocket

Connect to a WebSocket for bidirectional communication. You can subscribe to real-time events and send commands.

### Connect

```
ws://localhost:6790/ws
```

### Filter by Queue

```
ws://localhost:6790/ws/queues/:queue
```

**Example:**

```
ws://localhost:6790/ws/queues/emails
```

Authentication is validated at connection time via the `Authorization` header. If `AUTH_TOKENS` is configured and the token is missing or invalid, the upgrade request is rejected with a `401` response.

### Event Broadcasts

Connected WebSocket clients receive the same job events as SSE clients. Events are JSON strings:

```json
{
  "eventType": "completed",
  "queue": "emails",
  "jobId": "01924f5a-7b3c-7def-8a12-3456789abcde",
  "timestamp": 1700000000000
}
```

Events are filtered by queue when connected to `/ws/queues/:queue`.

### Sending Commands

WebSocket clients can send commands as JSON messages. Every command must include a `cmd` field. An optional `reqId` field is echoed back in the response for request/response correlation.

**Example -- push a job:**

```json
{ "cmd": "PUSH", "queue": "emails", "data": { "to": "user@test.com" }, "reqId": "req-1" }
```

**Response:**

```json
{ "ok": true, "id": "01924f5a-7b3c-7def-8a12-3456789abcde", "reqId": "req-1" }
```

**Example -- pull a job:**

```json
{ "cmd": "PULL", "queue": "emails", "reqId": "req-2" }
```

**Example -- acknowledge a job:**

```json
{ "cmd": "ACK", "id": "01924f5a-7b3c-7def-8a12-3456789abcde", "result": { "sent": true }, "reqId": "req-3" }
```

**Example -- fail a job:**

```json
{ "cmd": "FAIL", "id": "01924f5a-7b3c-7def-8a12-3456789abcde", "error": "Timeout", "reqId": "req-4" }
```

### Authentication via WebSocket

If auth tokens are configured, the `Authorization: Bearer <token>` header must be sent during the WebSocket handshake. Alternatively, after connecting, you can authenticate with the `Auth` command:

```json
{ "cmd": "Auth", "token": "my-secret-token" }
```

**Success:**

```json
{ "ok": true }
```

**Failure:**

```json
{ "ok": false, "error": "Invalid token" }
```

### Error Response

Invalid or failed commands return:

```json
{ "ok": false, "error": "Description of error", "reqId": "req-1" }
```

### Connection Cleanup

When a WebSocket connection closes, all jobs owned by that client are released back to the queue automatically.

### JavaScript Example

```javascript
const ws = new WebSocket('ws://localhost:6790/ws');

ws.onopen = () => {
  // Push a job
  ws.send(JSON.stringify({
    cmd: 'PUSH',
    queue: 'emails',
    data: { to: 'user@test.com' },
    reqId: '1'
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.reqId) {
    // This is a response to a command we sent
    console.log('Response:', msg);
  } else if (msg.eventType) {
    // This is a broadcast event
    console.log('Event:', msg.eventType, msg.jobId);
  }
};
```

---

## Endpoint Summary

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/queues/:queue/jobs` | Yes | Push a job to a queue |
| `GET` | `/queues/:queue/jobs` | Yes | Pull the next job from a queue |
| `GET` | `/jobs/:id` | Yes | Get a job by ID |
| `DELETE` | `/jobs/:id` | Yes | Cancel a job by ID |
| `POST` | `/jobs/:id/ack` | Yes | Acknowledge (complete) a job |
| `POST` | `/jobs/:id/fail` | Yes | Fail a job |
| `GET` | `/health` | No | Detailed health check |
| `GET` | `/healthz` | No | Liveness probe (returns `OK`) |
| `GET` | `/live` | No | Liveness probe (returns `OK`) |
| `GET` | `/ready` | No | Readiness probe |
| `GET` | `/stats` | Yes | Server statistics (JSON) |
| `GET` | `/metrics` | Yes | Throughput metrics (JSON) |
| `GET` | `/prometheus` | Optional | Prometheus text format metrics |
| `POST` | `/gc` | No | Force garbage collection |
| `GET` | `/heapstats` | No | Heap statistics for debugging |
| `GET` | `/events` | Yes | SSE stream (all queues) |
| `GET` | `/events/queues/:queue` | Yes | SSE stream (filtered by queue) |
| -- | `/ws` | Yes | WebSocket (all queues) |
| -- | `/ws/queues/:queue` | Yes | WebSocket (filtered by queue) |

:::tip[Related]
- [TCP Protocol Reference](/api/tcp/) - Binary TCP protocol alternative
- [TypeScript Types](/api/types/) - Type definitions for all APIs
- [Server Mode](/guide/server/) - Run the HTTP API server
:::
