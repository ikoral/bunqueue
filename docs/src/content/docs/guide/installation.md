---
title: Installation
description: How to install bunqueue
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://egeominotti.github.io/bunqueue/og/getting-started.png
---


## Requirements

- [Bun](https://bun.sh) v1.0 or later

## Install from npm

```bash
bun add bunqueue
```

## Install from source

```bash
git clone https://github.com/egeominotti/bunQ.git
cd bunQ
bun install
bun run build
```

## Verify Installation

### Embedded Mode

```typescript
import { Queue, Worker } from 'bunqueue/client';

// Both Queue and Worker must have embedded: true
const queue = new Queue('test', { embedded: true });
const worker = new Worker('test', async (job) => {
  console.log('Processing:', job.data);
  return { success: true };
}, { embedded: true });

await queue.add('hello', { message: 'bunqueue is working!' });
```

### Server Mode

```bash
# Start server
bunqueue start

# Check version
bunqueue --version
```

## TypeScript Support

bunqueue is written in TypeScript and includes full type definitions:

```typescript
import type {
  Job,
  JobOptions,
  WorkerOptions,
  StallConfig,
  DlqConfig,
  DlqEntry
} from 'bunqueue/client';
```

## Next Steps

- [Quick Start](/bunqueue/guide/quickstart/) - Create your first queue and worker
