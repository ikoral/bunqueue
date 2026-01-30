---
title: Stall Detection
description: Automatic recovery of unresponsive jobs
---

# Stall Detection

Stall detection automatically identifies and recovers jobs that become unresponsive during processing.

## How It Works

1. Workers send periodic heartbeats while processing jobs
2. The queue manager checks for jobs without recent heartbeats
3. Stalled jobs are either retried or moved to the DLQ

## Configuration

```typescript
const queue = new Queue('my-queue');

queue.setStallConfig({
  enabled: true,         // Enable stall detection (default: true)
  stallInterval: 30000,  // Job is stalled after 30s without heartbeat
  maxStalls: 3,          // Move to DLQ after 3 stalls
  gracePeriod: 5000,     // Grace period after job starts
});
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable stall detection |
| `stallInterval` | `30000` | Time (ms) without heartbeat before job is stalled |
| `maxStalls` | `3` | Max stalls before moving to DLQ |
| `gracePeriod` | `5000` | Initial grace period after job starts |

## Worker Heartbeats

Workers automatically send heartbeats:

```typescript
const worker = new Worker('queue', processor, {
  heartbeatInterval: 10000, // Heartbeat every 10 seconds
});
```

The `heartbeatInterval` should be less than `stallInterval` to avoid false positives.

## Stall Actions

When a job stalls, one of these actions is taken:

1. **Retry** - Job is re-queued with incremented stall count
2. **Move to DLQ** - Job exceeds `maxStalls` and is moved to Dead Letter Queue

## Events

```typescript
import { QueueEvents } from 'bunqueue/client';

const events = new QueueEvents('my-queue');

events.on('stalled', (job) => {
  console.log(`Job ${job.id} stalled`);
});
```

## Example: Long-Running Jobs

For jobs that take a long time, increase the stall interval:

```typescript
// Queue for video processing (may take hours)
const videoQueue = new Queue('video-processing');

videoQueue.setStallConfig({
  stallInterval: 300000,  // 5 minutes
  maxStalls: 2,
  gracePeriod: 60000,     // 1 minute grace
});

// Worker with frequent heartbeats
const worker = new Worker('video-processing', async (job) => {
  for (const chunk of video.chunks) {
    await processChunk(chunk);
    await job.updateProgress(chunk.progress); // This also acts as a heartbeat
  }
}, {
  heartbeatInterval: 30000, // Every 30 seconds
});
```

## Monitoring

Check stall-related stats:

```typescript
const stats = queue.getDlqStats();
console.log('Stalled jobs in DLQ:', stats.byReason.stalled);
```

Filter DLQ by stalled reason:

```typescript
const stalledJobs = queue.getDlq({ reason: 'stalled' });
```
