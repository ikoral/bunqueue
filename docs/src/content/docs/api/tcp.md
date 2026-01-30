---
title: TCP Protocol
description: Binary TCP protocol reference
---

# TCP Protocol

High-performance binary protocol on port 6789.

## Connection

```typescript
const socket = await Bun.connect({
  hostname: 'localhost',
  port: 6789,
  socket: {
    data(socket, data) {
      // Handle response
    },
  },
});
```

## Commands

### Core Operations

| Command | Description |
|---------|-------------|
| `PUSH` | Add job to queue |
| `PUSHB` | Batch push jobs |
| `PULL` | Get next job |
| `PULLB` | Batch pull jobs |
| `ACK` | Mark completed |
| `ACKB` | Batch acknowledge |
| `FAIL` | Mark failed |

### Query Operations

| Command | Description |
|---------|-------------|
| `GetJob` | Get job by ID |
| `GetState` | Get job state |
| `GetResult` | Get job result |
| `GetJobs` | List jobs |
| `GetJobCounts` | Count by state |

### Queue Control

| Command | Description |
|---------|-------------|
| `Pause` | Pause queue |
| `Resume` | Resume queue |
| `Drain` | Remove waiting jobs |
| `Obliterate` | Remove all data |

### DLQ

| Command | Description |
|---------|-------------|
| `Dlq` | Get DLQ jobs |
| `RetryDlq` | Retry DLQ jobs |
| `PurgeDlq` | Clear DLQ |

## Message Format

```
[4 bytes: message length]
[JSON payload]
```

## Authentication

```json
{ "cmd": "AUTH", "token": "your-token" }
```
