---
title: HTTP API
description: Complete HTTP REST API reference for bunqueue with endpoints, authentication, and health checks
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/server-mode.png
---


The HTTP API is available on port 6790 by default.

## Endpoints

### Jobs

```http
POST /push
Content-Type: application/json

{
  "queue": "emails",
  "data": { "to": "user@test.com" },
  "priority": 10,
  "delay": 5000
}
```

```http
POST /pull
Content-Type: application/json

{ "queue": "emails", "timeout": 5000 }
```

```http
POST /ack
Content-Type: application/json

{ "id": "123", "result": { "sent": true } }
```

```http
POST /fail
Content-Type: application/json

{ "id": "123", "error": "Failed to send" }
```

### Monitoring

```http
GET /health
GET /metrics  # Prometheus format
GET /stats
```

## Authentication

```http
Authorization: Bearer your-token
```

## WebSocket

```javascript
const ws = new WebSocket('ws://localhost:6790/events');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.event, data.jobId);
};
```

## Server-Sent Events

```javascript
const events = new EventSource('http://localhost:6790/events');

events.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};
```
