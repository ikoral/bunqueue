---
title: TCP Protocol
description: Wire format, commands, and authentication flow
---

# TCP Protocol

bunqueue uses a binary protocol over TCP with MessagePack serialization.

## Wire Format

```
┌────────────────────────────────────────────────────────────┐
│                     FRAME STRUCTURE                         │
│                                                             │
│  ┌───────────────────┬─────────────────────────────────┐  │
│  │  4 bytes (u32)    │        N bytes payload          │  │
│  │  Big-endian       │        MessagePack encoded      │  │
│  │  length prefix    │                                 │  │
│  └───────────────────┴─────────────────────────────────┘  │
│                                                             │
│  Max frame size: 64 MB                                     │
└────────────────────────────────────────────────────────────┘
```

## Connection Lifecycle

```
┌──────────────┐
│ DISCONNECTED │
└──────┬───────┘
       │ connect()
       ▼
┌──────────────┐
│ CONNECTING   │
└──────┬───────┘
       │ Socket open
       ▼
┌──────────────────────────┐
│ CONNECTED                │
│                          │
│ • Send Auth (if token)   │──────► { cmd: 'Auth', token }
│ • Start health ping      │
│ • Process commands       │
└──────────┬───────────────┘
           │ Error / Close
           ▼
┌──────────────────────────┐
│ RECONNECTING             │
│                          │
│ • Exponential backoff    │
│ • Max delay: 30s         │
│ • Jitter: ±30%           │
└──────────────────────────┘
```

## Authentication Flow

```
Client                              Server
  │                                   │
  ├─── TCP Connect ────────────────────>
  │                                   │
  ├─── { cmd: 'Auth',                 │
  │      token: 'secret' } ──────────>│
  │                                   │
  │                    [Constant-time comparison]
  │                    [Sets authenticated: true]
  │                                   │
  │<─── { ok: true } ─────────────────┤
  │                                   │
  ├─── Subsequent Commands ──────────>│
  │                                   │
  │    [Commands require auth         │
  │     if AUTH_TOKENS configured]    │
```

## Command Categories

### Core Commands

```
┌─────────────────────────────────────────────────────────────┐
│  PUSH: Add single job                                       │
│  { cmd: 'PUSH', queue, data, priority?, delay?, ... }      │
│  Response: { ok: true, id: '...' }                         │
├─────────────────────────────────────────────────────────────┤
│  PUSHB: Add batch of jobs                                   │
│  { cmd: 'PUSHB', queue, jobs: [...] }                      │
│  Response: { ok: true, ids: [...] }                        │
├─────────────────────────────────────────────────────────────┤
│  PULL: Get single job                                       │
│  { cmd: 'PULL', queue, timeout?, owner? }                  │
│  Response: { ok: true, job: {...}, token?: '...' }         │
├─────────────────────────────────────────────────────────────┤
│  PULLB: Get batch of jobs                                   │
│  { cmd: 'PULLB', queue, count, timeout?, owner? }          │
│  Response: { ok: true, jobs: [...], tokens?: [...] }       │
├─────────────────────────────────────────────────────────────┤
│  ACK: Acknowledge completion                                │
│  { cmd: 'ACK', id, result?, token? }                       │
│  Response: { ok: true }                                    │
├─────────────────────────────────────────────────────────────┤
│  ACKB: Batch acknowledge                                    │
│  { cmd: 'ACKB', ids, results?, tokens? }                   │
│  Response: { ok: true }                                    │
├─────────────────────────────────────────────────────────────┤
│  FAIL: Mark job failed                                      │
│  { cmd: 'FAIL', id, error?, token? }                       │
│  Response: { ok: true }                                    │
└─────────────────────────────────────────────────────────────┘
```

### Query Commands

```
┌─────────────────────────────────────────────────────────────┐
│  GetJob: Retrieve job by ID                                 │
│  GetState: Get job state                                    │
│  GetResult: Get job result                                  │
│  GetJobs: List jobs with filters                            │
│  GetJobCounts: Get queue statistics                         │
│  GetProgress: Get job progress                              │
│  Count: Count jobs in queue                                 │
└─────────────────────────────────────────────────────────────┘
```

### Queue Control Commands

```
┌─────────────────────────────────────────────────────────────┐
│  Pause: Stop processing queue                               │
│  Resume: Resume queue processing                            │
│  Drain: Remove all waiting jobs                             │
│  Obliterate: Complete queue deletion                        │
│  Clean: Remove old jobs                                     │
└─────────────────────────────────────────────────────────────┘
```

### DLQ Commands

```
┌─────────────────────────────────────────────────────────────┐
│  Dlq: List DLQ entries                                      │
│  RetryDlq: Retry failed jobs                                │
│  PurgeDlq: Remove all DLQ entries                           │
└─────────────────────────────────────────────────────────────┘
```

### Cron Commands

```
┌─────────────────────────────────────────────────────────────┐
│  Cron: Add scheduled job                                    │
│  CronDelete: Remove scheduled job                           │
│  CronList: List all cron jobs                               │
└─────────────────────────────────────────────────────────────┘
```

### Monitoring Commands

```
┌─────────────────────────────────────────────────────────────┐
│  Stats: Server statistics                                   │
│  Metrics: Queue metrics                                     │
│  Prometheus: Prometheus format metrics                      │
│  Ping: Health check                                         │
│  Heartbeat: Worker heartbeat                                │
│  JobHeartbeat: Job-level heartbeat                          │
└─────────────────────────────────────────────────────────────┘
```

## Connection Pool

```
┌─────────────────────────────────────────────────────────────┐
│                  TCP CONNECTION POOL                         │
│                                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │Client 1│ │Client 2│ │Client 3│ │Client 4│              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
│                                                              │
│  Selection: Round-robin, prefer connected                   │
│                                                              │
│  Features:                                                  │
│  • 4 connections per pool (default)                        │
│  • Auto-reconnect with exponential backoff                 │
│  • Shared pools (reference counted)                        │
│  • Health tracking (latency, errors)                       │
└─────────────────────────────────────────────────────────────┘
```

## Reconnection Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                  RECONNECTION                                │
│                                                              │
│  delay = min(baseDelay * 2^attempts, maxDelay) + jitter    │
│                                                              │
│  Example sequence:                                          │
│  Attempt 1: 100ms + jitter                                 │
│  Attempt 2: 200ms + jitter                                 │
│  Attempt 3: 400ms + jitter                                 │
│  Attempt 4: 800ms + jitter                                 │
│  ...                                                        │
│  Max: 30s                                                   │
│                                                              │
│  Jitter: ±30% of base delay                                │
└─────────────────────────────────────────────────────────────┘
```

## Client Disconnect Handling

```
Client disconnects
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Server: onClose(socket)                                    │
│                                                              │
│  1. Get clientId from socket state                         │
│                                                              │
│  2. Look up clientJobs[clientId]                           │
│     └─ Set of all jobs owned by this client                │
│                                                              │
│  3. For each owned job:                                    │
│     └─ Release with retry logic                            │
│        (exponential backoff: 100ms, 200ms, 400ms)          │
│                                                              │
│  4. Clean up client tracking                               │
└─────────────────────────────────────────────────────────────┘
```

## Validation

```
┌─────────────────────────────────────────────────────────────┐
│                  REQUEST VALIDATION                          │
│                                                              │
│  Queue name:                                                │
│  • Max 256 characters                                       │
│  • Alphanumeric + _-.:                                      │
│                                                              │
│  Job data:                                                  │
│  • Max 10 MB JSON                                           │
│                                                              │
│  Job options:                                               │
│  • priority: -1M to +1M                                    │
│  • delay: 0 to 365 days                                    │
│  • timeout: 0 to 24 hours                                  │
│  • maxAttempts: 1 to 1000                                  │
│  • backoff: 0 to 24 hours                                  │
│  • ttl: 0 to 365 days                                      │
│                                                              │
│  Webhook URL (SSRF prevention):                            │
│  • Blocks localhost, private IPs, cloud metadata           │
│  • Requires http/https                                      │
└─────────────────────────────────────────────────────────────┘
```

## HTTP Endpoints

```
┌─────────────────────────────────────────────────────────────┐
│                  HTTP SERVER (:6790)                         │
│                                                              │
│  Health & Diagnostics:                                      │
│  GET  /health        │ Health + memory stats               │
│  GET  /healthz       │ Kubernetes liveness                 │
│  GET  /ready         │ Kubernetes readiness                │
│  POST /gc            │ Force garbage collection            │
│  GET  /heapstats     │ Memory breakdown                    │
│                                                              │
│  Metrics:                                                   │
│  GET  /prometheus    │ Prometheus format                   │
│  GET  /stats         │ JSON stats                          │
│  GET  /metrics       │ JSON metrics                        │
│                                                              │
│  REST API:                                                  │
│  POST /queues/:queue/jobs │ Add job                        │
│  GET  /queues/:queue/jobs │ Pull job                       │
│  GET  /jobs/:id           │ Get job                        │
│  POST /jobs/:id/ack       │ Acknowledge                    │
│  POST /jobs/:id/fail      │ Mark failed                    │
│                                                              │
│  Real-time:                                                 │
│  GET  /ws            │ WebSocket upgrade                   │
│  GET  /events        │ Server-Sent Events                  │
└─────────────────────────────────────────────────────────────┘
```
