---
title: Flow Producer
description: Parent-child job relationships
---


Create hierarchical job flows with parent-child relationships.

## Basic Usage

```typescript
import { FlowProducer } from 'bunqueue/client';

const flow = new FlowProducer();

const result = await flow.add({
  name: 'parent-job',
  queueName: 'main',
  data: { type: 'parent' },
  children: [
    { name: 'child-1', queueName: 'sub', data: { id: 1 } },
    { name: 'child-2', queueName: 'sub', data: { id: 2 } },
  ],
});

console.log('Parent job:', result.job.id);
console.log('Children:', result.children);
```

## How It Works

1. Children are created first and start processing
2. Parent job waits until all children complete
3. Parent receives children's results in its data

## Nested Flows

```typescript
await flow.add({
  name: 'grandparent',
  queueName: 'level-1',
  data: {},
  children: [
    {
      name: 'parent',
      queueName: 'level-2',
      data: {},
      children: [
        { name: 'child', queueName: 'level-3', data: {} },
      ],
    },
  ],
});
```

## Options

```typescript
await flow.add({
  name: 'parent',
  queueName: 'main',
  data: {},
  opts: {
    priority: 10,
    attempts: 3,
  },
  children: [
    {
      name: 'child',
      queueName: 'sub',
      data: {},
      opts: { delay: 5000 },
    },
  ],
});
```
