---
title: Worker
description: Worker class API reference
---


The `Worker` class processes jobs from a queue.

## Creating a Worker

```typescript
import { Worker } from 'bunqueue/client';

const worker = new Worker('my-queue', async (job) => {
  // Process the job
  return { success: true };
});
```

## Options

```typescript
const worker = new Worker('queue', processor, {
  concurrency: 5,           // Process 5 jobs in parallel (default: 1)
  autorun: true,            // Start automatically (default: true)
  heartbeatInterval: 10000, // Heartbeat every 10s (default: 10000)
});
```

## Job Object

Inside the processor, you have access to the job object:

```typescript
const worker = new Worker('queue', async (job) => {
  job.id;           // Job ID
  job.name;         // Job name
  job.data;         // Job data
  job.queueName;    // Queue name
  job.attemptsMade; // Current attempt number
  job.timestamp;    // When job was created
  job.progress;     // Current progress (0-100)

  // Update progress
  await job.updateProgress(50, 'Halfway done');

  // Log messages
  await job.log('Processing step 1');

  return result;
});
```

## Events

```typescript
worker.on('ready', () => {
  console.log('Worker is ready');
});

worker.on('active', (job) => {
  console.log(`Started: ${job.id}`);
});

worker.on('completed', (job, result) => {
  console.log(`Completed: ${job.id}`, result);
});

worker.on('failed', (job, error) => {
  console.error(`Failed: ${job.id}`, error.message);
});

worker.on('progress', (job, progress) => {
  console.log(`Progress: ${job.id} - ${progress}%`);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('closed', () => {
  console.log('Worker closed');
});
```

## Control

```typescript
// Pause processing
worker.pause();

// Resume processing
worker.resume();

// Stop the worker
await worker.close();      // Wait for active jobs
await worker.close(true);  // Force close immediately
```

## Heartbeats

Workers automatically send heartbeats while processing jobs. This enables stall detection - if a job doesn't receive a heartbeat within the configured interval, it's considered stalled.

```typescript
const worker = new Worker('queue', processor, {
  heartbeatInterval: 5000, // Send heartbeat every 5 seconds
});
```

See [Stall Detection](/bunqueue/guide/stall-detection/) for more details.

## Error Handling

```typescript
const worker = new Worker('queue', async (job) => {
  try {
    await riskyOperation();
  } catch (error) {
    // Job will be retried if attempts remain
    throw error;
  }
});

// Or handle at worker level
worker.on('failed', (job, error) => {
  if (job.attemptsMade >= 3) {
    // Final failure - alert someone
    alertOps(job, error);
  }
});
```
