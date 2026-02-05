---
title: Webhooks
description: HTTP callbacks for job events with signature verification
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/advanced.png
---


Receive HTTP callbacks when job events occur. Webhooks enable real-time notifications to external systems without polling.

## Overview

When you register a webhook URL, bunqueue sends HTTP POST requests to that URL whenever specified events occur. This is useful for:

- Notifying external services when jobs complete
- Triggering downstream workflows
- Logging job events to external systems
- Alerting on failures

## CLI Commands

### Add Webhook

```bash
# Add webhook for all events
bunqueue webhook add https://api.example.com/webhooks/bunqueue

# Add webhook for specific queue
bunqueue webhook add https://api.example.com/webhooks/emails --queue emails

# Add webhook for specific events only
bunqueue webhook add https://api.example.com/webhooks/failures \
  --events failed,stalled
```

### List Webhooks

```bash
bunqueue webhook list
```

**Output:**
```
URL                                        QUEUE    EVENTS
https://api.example.com/webhooks/bunqueue  *        all
https://api.example.com/webhooks/emails    emails   all
https://api.example.com/webhooks/failures  *        failed,stalled
```

### Remove Webhook

```bash
bunqueue webhook remove https://api.example.com/webhooks/bunqueue
```

## Event Types

| Event | Description | When Triggered |
|-------|-------------|----------------|
| `waiting` | Job added to queue | After `queue.add()` |
| `active` | Job started processing | Worker picks up job |
| `completed` | Job finished successfully | Worker calls `done()` |
| `failed` | Job failed | Worker throws error |
| `stalled` | Job became unresponsive | Heartbeat timeout |
| `progress` | Progress updated | `job.updateProgress()` |
| `delayed` | Job scheduled for later | Job with delay added |
| `removed` | Job was removed | Manual deletion |

## Webhook Payload

### Request Format

bunqueue sends POST requests with JSON body:

```http
POST /webhooks/bunqueue HTTP/1.1
Host: api.example.com
Content-Type: application/json
X-Webhook-Event: completed
X-Webhook-Timestamp: 1704067200000
X-Webhook-Signature: sha256=a1b2c3d4e5f6...
X-Webhook-ID: wh_abc123

{
  "event": "completed",
  "timestamp": 1704067200000,
  "queue": "emails",
  "job": {
    "id": "1001",
    "name": "send-email",
    "data": {
      "to": "user@example.com",
      "subject": "Welcome"
    },
    "attemptsMade": 1,
    "progress": 100
  },
  "result": {
    "messageId": "msg-abc123",
    "delivered": true
  }
}
```

### Event-Specific Payloads

**completed**
```json
{
  "event": "completed",
  "timestamp": 1704067200000,
  "queue": "emails",
  "job": { "id": "1001", "name": "send-email", "data": {...} },
  "result": { "messageId": "msg-abc123" }
}
```

**failed**
```json
{
  "event": "failed",
  "timestamp": 1704067200000,
  "queue": "emails",
  "job": { "id": "1001", "name": "send-email", "data": {...} },
  "error": {
    "message": "SMTP connection timeout",
    "stack": "Error: SMTP connection timeout\n    at ..."
  },
  "attemptsMade": 3,
  "willRetry": false
}
```

**progress**
```json
{
  "event": "progress",
  "timestamp": 1704067200000,
  "queue": "emails",
  "job": { "id": "1001", "name": "send-email", "data": {...} },
  "progress": 75,
  "message": "Sending to recipients..."
}
```

**stalled**
```json
{
  "event": "stalled",
  "timestamp": 1704067200000,
  "queue": "emails",
  "job": { "id": "1001", "name": "send-email", "data": {...} },
  "stallCount": 2,
  "maxStalls": 3
}
```

## Signature Verification

bunqueue signs all webhook payloads using HMAC-SHA256. Always verify signatures to ensure requests are authentic.

:::caution[Security Warning]
If `WEBHOOK_SECRET` is not set, webhooks are sent **without signatures**. This means anyone could forge webhook requests to your endpoint. Always set a secret in production.
:::

### Setting the Secret

```bash
# Set webhook secret (REQUIRED for production)
WEBHOOK_SECRET=your-secret-key bunqueue start
```

### Verifying Signatures

**TypeScript/JavaScript:**
```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expected = Buffer.from(`sha256=${expectedSignature}`);
  const received = Buffer.from(signature);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

// Usage in webhook handler
app.post('/webhooks/bunqueue', (req, res) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const payload = JSON.stringify(req.body);

  if (!verifyWebhookSignature(payload, signature, process.env.WEBHOOK_SECRET!)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process webhook...
  res.status(200).json({ received: true });
});
```

**Python:**
```python
import hmac
import hashlib

def verify_webhook_signature(payload: bytes, signature: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected, signature)

# Usage in Flask
@app.route('/webhooks/bunqueue', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Webhook-Signature')
    payload = request.get_data()

    if not verify_webhook_signature(payload, signature, WEBHOOK_SECRET):
        return jsonify({'error': 'Invalid signature'}), 401

    # Process webhook...
    return jsonify({'received': True})
```

**Go:**
```go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
)

func verifyWebhookSignature(payload []byte, signature, secret string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(payload)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

    return hmac.Equal([]byte(expected), []byte(signature))
}
```

## Retry Behavior

bunqueue automatically retries failed webhook deliveries:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 10 seconds |
| 3 | 30 seconds |
| 4 | 1 minute |
| 5 | 5 minutes |

After 5 failed attempts, the webhook delivery is abandoned and logged.

### Success Criteria

A webhook delivery is considered successful if:
- HTTP status code is 2xx (200-299)
- Response is received within 30 seconds

### Failure Handling

Webhook failures are logged but don't affect job processing. Monitor webhook delivery status:

```bash
bunqueue webhook status
```

**Output:**
```
URL                                        DELIVERED   FAILED   LAST_ERROR
https://api.example.com/webhooks/bunqueue  15,234      12       Connection timeout
https://api.example.com/webhooks/emails    5,102       0        -
```

## Example Webhook Server

Complete example using Hono (works with Bun):

```typescript
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';

const app = new Hono();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret';

// Signature verification middleware
async function verifySignature(c: any, next: any) {
  const signature = c.req.header('x-webhook-signature');
  const body = await c.req.text();

  if (!signature) {
    return c.json({ error: 'Missing signature' }, 401);
  }

  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signature);

  if (expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Store parsed body for handler
  c.set('webhookPayload', JSON.parse(body));
  await next();
}

// Webhook handler
app.post('/webhooks/bunqueue', verifySignature, async (c) => {
  const payload = c.get('webhookPayload');

  console.log(`Received ${payload.event} event for job ${payload.job.id}`);

  switch (payload.event) {
    case 'completed':
      console.log('Job completed:', payload.result);
      // Notify downstream service
      await notifyCompletion(payload);
      break;

    case 'failed':
      console.error('Job failed:', payload.error.message);
      // Alert on failure
      await sendAlert({
        type: 'job_failed',
        jobId: payload.job.id,
        queue: payload.queue,
        error: payload.error.message,
      });
      break;

    case 'stalled':
      console.warn('Job stalled:', payload.job.id);
      // Log stall event
      await logStallEvent(payload);
      break;

    case 'progress':
      console.log(`Job ${payload.job.id}: ${payload.progress}%`);
      // Update UI or notify
      await broadcastProgress(payload);
      break;
  }

  return c.json({ received: true });
});

// Health check endpoint
app.get('/health', (c) => c.json({ status: 'ok' }));

export default {
  port: 3000,
  fetch: app.fetch,
};
```

## Express.js Example

```typescript
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;

function verifySignature(req: any, res: any, next: any) {
  const signature = req.headers['x-webhook-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

app.post('/webhooks/bunqueue', verifySignature, async (req, res) => {
  const { event, job, queue, result, error } = req.body;

  console.log(`[${queue}] ${event}: Job ${job.id}`);

  if (event === 'completed') {
    // Handle completion
    console.log('Result:', result);
  } else if (event === 'failed') {
    // Handle failure
    console.error('Error:', error.message);
  }

  res.json({ received: true });
});

app.listen(3000, () => {
  console.log('Webhook server listening on port 3000');
});
```

## Best Practices

### 1. Always Verify Signatures

Never trust webhook payloads without signature verification. Attackers could forge requests.

### 2. Respond Quickly

Return a 200 response as soon as possible. Process webhooks asynchronously if needed:

```typescript
app.post('/webhooks/bunqueue', verifySignature, async (c) => {
  const payload = c.get('webhookPayload');

  // Queue for async processing
  await processQueue.add('webhook', payload);

  // Return immediately
  return c.json({ received: true });
});
```

### 3. Handle Duplicates

Webhooks may be delivered multiple times. Use `X-Webhook-ID` to deduplicate:

```typescript
const processedWebhooks = new Set<string>();

app.post('/webhooks/bunqueue', verifySignature, async (c) => {
  const webhookId = c.req.header('x-webhook-id');

  if (processedWebhooks.has(webhookId)) {
    return c.json({ received: true, duplicate: true });
  }

  processedWebhooks.add(webhookId);
  // Process webhook...
});
```

### 4. Log Everything

Log all webhook events for debugging:

```typescript
app.post('/webhooks/bunqueue', verifySignature, async (c) => {
  const payload = c.get('webhookPayload');

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    webhookId: c.req.header('x-webhook-id'),
    event: payload.event,
    queue: payload.queue,
    jobId: payload.job.id,
  }));

  // Process...
});
```

### 5. Monitor Delivery

Set up alerts for webhook failures:

```bash
#!/bin/bash
# Check webhook health
FAILED=$(bunqueue webhook status --json | jq '.[0].failed')
if [ "$FAILED" -gt 100 ]; then
  echo "ALERT: High webhook failure rate"
fi
```

## Troubleshooting

### Webhooks Not Delivered

1. Check webhook is registered: `bunqueue webhook list`
2. Verify URL is accessible from server
3. Check firewall rules
4. Review server logs: `bunqueue logs --filter webhook`

### Invalid Signature Errors

1. Verify secret matches on both ends
2. Check payload isn't modified by proxies
3. Ensure raw body is used for signature verification
4. Check for encoding issues (UTF-8)

### Slow Webhook Processing

1. Return 200 immediately, process async
2. Add more webhook endpoints
3. Implement request queuing

### Missing Events

1. Check event filter: `--events` flag
2. Verify queue filter: `--queue` flag
3. Check job options (some jobs skip events)
