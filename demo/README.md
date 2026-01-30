# Demo bunqueue

## Setup

Il server bunqueue deve essere in esecuzione.

## Esecuzione

**Terminale 1 - Avvia il server:**
```bash
bunqueue start
```

**Terminale 2 - Worker (processa job):**
```bash
cd demo
bun run worker.ts
```

**Terminale 3 - Producer (crea job):**
```bash
cd demo
bun run producer.ts
```

## Come funziona

```
┌─────────────┐      TCP       ┌─────────────┐      TCP       ┌─────────────┐
│  Producer   │ ────────────► │   Server    │ ◄──────────── │   Worker    │
│ (processo)  │   push jobs   │  bunqueue   │   pull jobs   │ (processo)  │
└─────────────┘               └─────────────┘               └─────────────┘
                                    │
                                    ▼
                              ┌─────────────┐
                              │   SQLite    │
                              └─────────────┘
```

1. Producer e Worker si connettono al server via TCP (default `localhost:6789`)
2. Il server gestisce la persistenza SQLite
3. Multi-processo funziona perché il server coordina tutto

## Modalità embedded (senza server)

Se vuoi usare bunqueue senza server (single process):

```typescript
import { Queue, Worker } from 'bunqueue/client';

const queue = new Queue('emails', { embedded: true });
const worker = new Worker('emails', processor, { embedded: true });
```
