---
title: Webhooks
description: HTTP callbacks for job events
---

# Webhooks

Receive HTTP callbacks when job events occur.

## CLI Commands

```bash
# Add webhook
bunqueue webhook add https://api.example.com/webhook

# List webhooks
bunqueue webhook list

# Remove webhook
bunqueue webhook remove https://api.example.com/webhook
```

## Event Payload

```json
{
  "event": "completed",
  "jobId": "123",
  "queue": "emails",
  "timestamp": 1704067200000,
  "data": {
    "result": { "sent": true }
  }
}
```

## Events

- `waiting` - Job added to queue
- `active` - Job started processing
- `completed` - Job completed successfully
- `failed` - Job failed
- `stalled` - Job stalled
- `progress` - Job progress updated
