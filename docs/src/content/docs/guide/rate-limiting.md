---
title: Rate Limiting
description: Control job processing rates
---

# Rate Limiting

Control the rate at which jobs are processed.

## Rate Limit

Limit jobs per time window:

```bash
# CLI
bunqueue rate-limit set emails 100  # 100 jobs/second
bunqueue rate-limit clear emails
```

## Concurrency Limit

Limit concurrent active jobs:

```bash
# CLI
bunqueue concurrency set emails 5  # Max 5 concurrent
bunqueue concurrency clear emails
```

## Embedded Mode

```typescript
const queue = new Queue('emails');

// These are server-side operations
// In embedded mode, use worker concurrency:
const worker = new Worker('emails', processor, {
  concurrency: 5,
});
```
