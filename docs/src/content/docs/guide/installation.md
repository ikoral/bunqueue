---
title: Installation
description: How to install bunqueue
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
import { Queue } from 'bunqueue/client';

const queue = new Queue('test');
console.log('bunqueue is working!');
```

### Server Mode

```bash
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
