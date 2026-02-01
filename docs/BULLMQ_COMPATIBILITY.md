# BullMQ v5 Compatibility Report

Documento di confronto tra BullMQ v5 e bunqueue per raggiungere la piena compatibilità API.

**Ultimo aggiornamento:** 2026-02-01

## Indice

- [Queue Class](#queue-class)
- [Worker Class](#worker-class)
- [Job Class](#job-class)
- [JobOptions](#joboptions)
- [FlowProducer](#flowproducer)
- [QueueEvents](#queueevents)
- [Riepilogo Implementazione](#riepilogo-implementazione)

---

## Queue Class

### Metodi Implementati ✅

| Metodo | Firma | Note |
|--------|-------|------|
| `add(name, data, opts?)` | `add(name: string, data: T, opts?: JobOptions): Promise<Job<T>>` | Identico a BullMQ |
| `addBulk(jobs)` | `addBulk(jobs: {name, data, opts?}[]): Promise<Job<T>[]>` | Identico a BullMQ |
| `getJob(id)` | `getJob(id: string): Promise<Job<T> \| null>` | Identico a BullMQ |
| `getJobs(options)` | `getJobsAsync(options): Promise<Job<T>[]>` | Versione async |
| `getJobCounts()` | `getJobCountsAsync(): Promise<{waiting, active, completed, failed}>` | Versione async |
| `getCountsPerPriority()` | `getCountsPerPriorityAsync(): Promise<Record<number, number>>` | Versione async |
| `remove(id)` | `remove(id: string): void` | Identico a BullMQ |
| `pause()` | `pause(): void` | Identico a BullMQ |
| `resume()` | `resume(): void` | Identico a BullMQ |
| `drain()` | `drain(): void` | Identico a BullMQ |
| `obliterate()` | `obliterate(): void` | Identico a BullMQ |
| `close()` | `close(): void` | Identico a BullMQ |
| `count()` | `countAsync(): Promise<number>` | ✅ Implementato |
| `isPaused()` | `isPausedAsync(): Promise<boolean>` | ✅ Implementato |
| `getJobState(jobId)` | `getJobState(id: string): Promise<JobStateType>` | ✅ Implementato |
| `getJobLogs(jobId, start?, end?, asc?)` | `getJobLogs(id, start?, end?, asc?): Promise<{logs, count}>` | ✅ Implementato |
| `addJobLog(jobId, logRow, keepLogs?)` | `addJobLog(id: string, logRow: string): Promise<number>` | ✅ Implementato |
| `updateJobProgress(jobId, progress)` | `updateJobProgress(id, progress): Promise<void>` | ✅ Implementato |
| `clean(grace, limit, type?)` | `cleanAsync(grace, limit, type?): Promise<string[]>` | ✅ Implementato |
| `retryJobs(opts?)` | `retryJobs(opts?): Promise<number>` | ✅ Implementato |
| `promoteJobs(opts?)` | `promoteJobs(opts?): Promise<number>` | ✅ Implementato |
| `getActive(start?, end?)` | `getActiveAsync(start?, end?): Promise<Job[]>` | ✅ Implementato |
| `getCompleted(start?, end?)` | `getCompletedAsync(start?, end?): Promise<Job[]>` | ✅ Implementato |
| `getFailed(start?, end?)` | `getFailedAsync(start?, end?): Promise<Job[]>` | ✅ Implementato |
| `getDelayed(start?, end?)` | `getDelayedAsync(start?, end?): Promise<Job[]>` | ✅ Implementato |
| `getWaiting(start?, end?)` | `getWaitingAsync(start?, end?): Promise<Job[]>` | ✅ Implementato |
| `getActiveCount()` | `getActiveCount(): Promise<number>` | ✅ Implementato |
| `getCompletedCount()` | `getCompletedCount(): Promise<number>` | ✅ Implementato |
| `getFailedCount()` | `getFailedCount(): Promise<number>` | ✅ Implementato |
| `getDelayedCount()` | `getDelayedCount(): Promise<number>` | ✅ Implementato |
| `getWaitingCount()` | `getWaitingCount(): Promise<number>` | ✅ Implementato |
| `setGlobalConcurrency(concurrency)` | `setGlobalConcurrency(concurrency: number): void` | ✅ Implementato |
| `removeGlobalConcurrency()` | `removeGlobalConcurrency(): void` | ✅ Implementato |
| `getGlobalConcurrency()` | `getGlobalConcurrency(): Promise<number \| null>` | ✅ Implementato (stub) |
| `setGlobalRateLimit(max, duration)` | `setGlobalRateLimit(max: number): void` | ✅ Implementato |
| `removeGlobalRateLimit()` | `removeGlobalRateLimit(): void` | ✅ Implementato |
| `getGlobalRateLimit()` | `getGlobalRateLimit(): Promise<{max, duration} \| null>` | ✅ Implementato (stub) |
| `getMetrics(type, start?, end?)` | `getMetrics(type, start?, end?): Promise<{meta, data}>` | ✅ Implementato |
| `getWorkers()` | `getWorkers(): Promise<{id, name, addr?}[]>` | ✅ Implementato |
| `getWorkersCount()` | `getWorkersCount(): Promise<number>` | ✅ Implementato |

### Metodi Extra bunqueue ✅

| Metodo | Firma | Descrizione |
|--------|-------|-------------|
| `setStallConfig(config)` | `setStallConfig(config: Partial<StallConfig>): void` | Configura stall detection |
| `getStallConfig()` | `getStallConfig(): StallConfig` | Ottiene config stall |
| `setDlqConfig(config)` | `setDlqConfig(config: Partial<DlqConfig>): void` | Configura DLQ |
| `getDlqConfig()` | `getDlqConfig(): DlqConfig` | Ottiene config DLQ |
| `getDlq(filter?)` | `getDlq(filter?: DlqFilter): DlqEntry<T>[]` | Lista entry DLQ |
| `getDlqStats()` | `getDlqStats(): DlqStats` | Statistiche DLQ |
| `retryDlq(id?)` | `retryDlq(id?: string): number` | Riprova job da DLQ |
| `retryDlqByFilter(filter)` | `retryDlqByFilter(filter: DlqFilter): number` | Riprova con filtro |
| `purgeDlq()` | `purgeDlq(): number` | Svuota DLQ |
| `retryCompleted(id?)` | `retryCompletedAsync(id?: string): Promise<number>` | Riprova job completati |
| `retryJob(id)` | `retryJob(id: string): Promise<void>` | Riprova singolo job |

### Metodi Da Implementare 🔴

| Metodo | Firma BullMQ v5 | Priorità | Complessità |
|--------|-----------------|----------|-------------|
| `trimEvents(maxLength)` | `trimEvents(maxLength: number): Promise<number>` | Bassa | Bassa |
| `getPrioritized(start?, end?)` | `getPrioritized(start?, end?): Promise<Job[]>` | Bassa | Bassa |
| `getWaitingChildren(start?, end?)` | `getWaitingChildren(start?, end?): Promise<Job[]>` | Media | Media |
| `getWaitingChildrenCount()` | `getWaitingChildrenCount(): Promise<number>` | Media | Bassa |
| `getPrioritizedCount()` | `getPrioritizedCount(): Promise<number>` | Bassa | Bassa |
| `getDependencies(parentId, type, start, end)` | `getDependencies(...): Promise<{...}>` | Media | Alta |
| `getRateLimitTtl(maxJobs?)` | `getRateLimitTtl(maxJobs?): Promise<number>` | Bassa | Bassa |
| `rateLimit(expireTimeMs)` | `rateLimit(expireTimeMs): Promise<void>` | Media | Bassa |
| `isMaxed()` | `isMaxed(): Promise<boolean>` | Bassa | Bassa |
| `upsertJobScheduler(id, repeatOpts, template?)` | `upsertJobScheduler(...): Promise<JobScheduler>` | **Alta** | Alta |
| `removeJobScheduler(id)` | `removeJobScheduler(id): Promise<boolean>` | Media | Bassa |
| `getJobScheduler(id)` | `getJobScheduler(id): Promise<JobScheduler \| null>` | Media | Bassa |
| `getJobSchedulers(start?, end?, asc?)` | `getJobSchedulers(...): Promise<JobScheduler[]>` | Media | Bassa |
| `getJobSchedulersCount()` | `getJobSchedulersCount(): Promise<number>` | Bassa | Bassa |
| `getDeduplicationJobId(id)` | `getDeduplicationJobId(id): Promise<string \| null>` | Media | Media |
| `removeDeduplicationKey(id)` | `removeDeduplicationKey(id): Promise<number>` | Media | Bassa |
| `waitUntilReady()` | `waitUntilReady(): Promise<void>` | Bassa | Bassa |
| `disconnect()` | `disconnect(): Promise<void>` | Bassa | Bassa |

---

## Worker Class

### Metodi/Opzioni Implementati ✅

| Metodo/Opzione | Firma | Note |
|----------------|-------|------|
| `constructor(name, processor, opts?)` | `new Worker(name: string, processor: Processor, opts?: WorkerOptions)` | Identico |
| `run()` | `run(): void` | Identico |
| `pause()` | `pause(): void` | Identico |
| `resume()` | `resume(): void` | Identico |
| `close(force?)` | `close(force?: boolean): Promise<void>` | Identico |
| **Opzione:** `concurrency` | `number` (default: 1) | Identico |
| **Opzione:** `autorun` | `boolean` (default: true) | Identico |
| **Opzione:** `heartbeatInterval` | `number` (default: 10000) | Equivalente a `stalledInterval` |
| **Opzione:** `batchSize` | `number` (default: 10, max: 1000) | Extra bunqueue |
| **Opzione:** `pollTimeout` | `number` (default: 0, max: 30000) | Extra bunqueue |
| **Opzione:** `useLocks` | `boolean` (default: true) | Extra bunqueue |
| **Evento:** `completed` | `(job: Job, result: R) => void` | Identico |
| **Evento:** `failed` | `(job: Job \| undefined, error: Error) => void` | Identico |
| **Evento:** `progress` | `(job: Job, progress: number) => void` | Identico |
| **Evento:** `error` | `(error: Error) => void` | Identico |
| **Evento:** `ready` | `() => void` | Identico |
| **Evento:** `closed` | `() => void` | Identico |

### Metodi/Opzioni Da Implementare 🔴

| Metodo/Opzione | Firma BullMQ v5 | Priorità | Complessità |
|----------------|-----------------|----------|-------------|
| `isRunning()` | `isRunning(): boolean` | Media | Bassa |
| `isPaused()` | `isPaused(): boolean` | Media | Bassa |
| `isClosed()` | `isClosed(): boolean` | Bassa | Bassa |
| `waitUntilReady()` | `waitUntilReady(): Promise<void>` | Bassa | Bassa |
| `getNextJob(token, opts?)` | `getNextJob(...): Promise<Job \| undefined>` | Bassa | Media |
| `processJob(job, token, cb?)` | `processJob(...): Promise<void \| Job>` | Bassa | Media |
| `cancelJob(jobId, reason?)` | `cancelJob(jobId, reason?): boolean` | Media | Bassa |
| `cancelAllJobs(reason?)` | `cancelAllJobs(reason?): void` | Media | Bassa |
| `extendJobLocks(jobIds, tokens, duration)` | `extendJobLocks(...): Promise<number>` | Bassa | Media |
| **Opzione:** `limiter` | `{max: number, duration: number, groupKey?: string}` | **Alta** | Alta |
| **Opzione:** `lockDuration` | `number` (default: 30000) | Media | Bassa |
| **Opzione:** `maxStalledCount` | `number` (default: 1) | Media | Bassa |
| **Opzione:** `skipStalledCheck` | `boolean` | Bassa | Bassa |
| **Opzione:** `skipLockRenewal` | `boolean` | Bassa | Bassa |
| **Opzione:** `drainDelay` | `number` (default: 5000) | Bassa | Bassa |
| **Opzione:** `removeOnComplete` | `boolean \| number \| KeepJobs` | Media | Bassa |
| **Opzione:** `removeOnFail` | `boolean \| number \| KeepJobs` | Media | Bassa |
| **Evento:** `drained` | `() => void` | Media | Bassa |
| **Evento:** `stalled` | `(jobId: string, prev: string) => void` | Media | Bassa |

---

## Job Class

### Proprietà Implementate ✅

| Proprietà | Tipo | Note |
|-----------|------|------|
| `id` | `string` | Identico |
| `name` | `string` | Identico |
| `data` | `T` | Identico |
| `queueName` | `string` | Identico |
| `timestamp` | `number` | Identico |
| `attemptsMade` | `number` | Identico |
| `progress` | `number` | Identico |
| `returnvalue` | `unknown \| undefined` | Identico |
| `failedReason` | `string \| undefined` | Identico |

### Metodi Implementati ✅

| Metodo | Firma | Note |
|--------|-------|------|
| `updateProgress(progress, message?)` | `updateProgress(progress: number, message?: string): Promise<void>` | Esteso con message |
| `log(message)` | `log(message: string): Promise<void>` | Identico |
| `getState()` | `getState(): Promise<JobStateType>` | ✅ Implementato |
| `remove()` | `remove(): Promise<void>` | ✅ Implementato |
| `retry()` | `retry(): Promise<void>` | ✅ Implementato |

### Proprietà Da Implementare 🔴

| Proprietà | Tipo BullMQ v5 | Priorità | Complessità |
|-----------|----------------|----------|-------------|
| `delay` | `number` | Bassa | Bassa |
| `processedOn` | `number \| undefined` | Media | Bassa |
| `finishedOn` | `number \| undefined` | Media | Bassa |
| `stacktrace` | `string[] \| null` | Media | Media |
| `stalledCounter` | `number` | Bassa | Bassa |
| `priority` | `number` | Media | Bassa |
| `parentKey` | `string \| undefined` | Media | Bassa |
| `parent` | `{id, queueQualifiedName} \| undefined` | Media | Bassa |
| `opts` | `JobsOptions` | Media | Bassa |
| `token` | `string \| undefined` | Bassa | Bassa |
| `processedBy` | `string \| undefined` | Bassa | Bassa |
| `deduplicationId` | `string \| undefined` | Media | Bassa |
| `repeatJobKey` | `string \| undefined` | Bassa | Bassa |
| `attemptsStarted` | `number` | Bassa | Bassa |

### Metodi Da Implementare 🔴

| Metodo | Firma BullMQ v5 | Priorità | Complessità |
|--------|-----------------|----------|-------------|
| `isWaiting()` | `isWaiting(): Promise<boolean>` | Bassa | Bassa |
| `isActive()` | `isActive(): Promise<boolean>` | Bassa | Bassa |
| `isDelayed()` | `isDelayed(): Promise<boolean>` | Bassa | Bassa |
| `isCompleted()` | `isCompleted(): Promise<boolean>` | Bassa | Bassa |
| `isFailed()` | `isFailed(): Promise<boolean>` | Bassa | Bassa |
| `isWaitingChildren()` | `isWaitingChildren(): Promise<boolean>` | Bassa | Bassa |
| `updateData(data)` | `updateData(data: T): Promise<void>` | Media | Bassa |
| `moveToCompleted(returnValue, token, fetchNext?)` | `moveToCompleted(...): Promise<JobData \| null>` | Bassa | Media |
| `moveToFailed(error, token, fetchNext?)` | `moveToFailed(...): Promise<void>` | Bassa | Media |
| `moveToWait(token?)` | `moveToWait(token?): Promise<boolean>` | Media | Media |
| `moveToDelayed(timestamp, token?)` | `moveToDelayed(...): Promise<void>` | Media | Media |
| `moveToWaitingChildren(token, opts?)` | `moveToWaitingChildren(...): Promise<boolean>` | Media | Alta |
| `promote()` | `promote(): Promise<void>` | Media | Bassa |
| `changeDelay(delay)` | `changeDelay(delay): Promise<void>` | Media | Bassa |
| `changePriority(opts)` | `changePriority(opts): Promise<void>` | Media | Media |
| `extendLock(token, duration)` | `extendLock(...): Promise<number>` | Bassa | Bassa |
| `getChildrenValues()` | `getChildrenValues(): Promise<{[jobKey]: unknown}>` | **Alta** | Media |
| `getDependencies(opts?)` | `getDependencies(opts?): Promise<{...}>` | Media | Alta |
| `getDependenciesCount(opts?)` | `getDependenciesCount(opts?): Promise<{...}>` | Bassa | Bassa |
| `clearLogs(keepLogs?)` | `clearLogs(keepLogs?): Promise<void>` | Bassa | Bassa |
| `waitUntilFinished(queueEvents, ttl?)` | `waitUntilFinished(...): Promise<R>` | Media | Media |
| `asJSON()` | `asJSON(): JobJsonRaw` | Bassa | Bassa |
| `toJSON()` | `toJSON(): JobJson` | Bassa | Bassa |

---

## JobOptions

### Opzioni Implementate ✅

| Opzione | Tipo | Note |
|---------|------|------|
| `priority` | `number` | Identico |
| `delay` | `number` | Identico |
| `attempts` | `number` | Identico |
| `backoff` | `number` | Identico (BullMQ supporta anche oggetto) |
| `timeout` | `number` | Identico |
| `jobId` | `string` | Identico |
| `removeOnComplete` | `boolean` | Identico (BullMQ supporta anche number/KeepJobs) |
| `removeOnFail` | `boolean` | Identico (BullMQ supporta anche number/KeepJobs) |
| `repeat` | `{every?, limit?, pattern?}` | Identico |
| `stallTimeout` | `number` | Extra bunqueue |
| `durable` | `boolean` | Extra bunqueue |

### Opzioni Da Implementare 🔴

| Opzione | Tipo BullMQ v5 | Priorità | Complessità |
|---------|----------------|----------|-------------|
| `lifo` | `boolean` | Media | Media |
| `stackTraceLimit` | `number` | Bassa | Bassa |
| `parent` | `{id: string, queue: string}` | **Alta** | Media |
| `keepLogs` | `number` | Bassa | Bassa |
| `sizeLimit` | `number` | Bassa | Bassa |
| `failParentOnFailure` | `boolean` | Media | Media |
| `removeDependencyOnFailure` | `boolean` | Bassa | Bassa |
| `deduplication` | `{id: string, ttl?: number}` | Media | Media |
| `debounce` | `{id: string, ttl: number}` | Media | Media |
| `backoff` (oggetto) | `{type: 'fixed' \| 'exponential', delay: number}` | Media | Bassa |
| `removeOnComplete` (esteso) | `number \| {age?, count?}` | Bassa | Bassa |
| `removeOnFail` (esteso) | `number \| {age?, count?}` | Bassa | Bassa |
| `repeat.startDate` | `Date \| string \| number` | Bassa | Bassa |
| `repeat.endDate` | `Date \| string \| number` | Bassa | Bassa |
| `repeat.tz` | `string` | Bassa | Bassa |
| `repeat.immediately` | `boolean` | Bassa | Bassa |
| `repeat.count` | `number` | Bassa | Bassa |
| `repeat.prevMillis` | `number` | Bassa | Bassa |
| `repeat.offset` | `number` | Bassa | Bassa |
| `repeat.jobId` | `string` | Bassa | Bassa |

---

## FlowProducer

### Metodi Implementati ✅

| Metodo | Firma bunqueue | Note |
|--------|----------------|------|
| `addChain(steps)` | `addChain(steps: FlowStep[]): Promise<FlowResult>` | API diversa da BullMQ |
| `addBulkThen(parallel, final)` | `addBulkThen(parallel, final): Promise<{parallelIds, finalId}>` | API diversa da BullMQ |
| `addTree(root)` | `addTree(root: FlowStep): Promise<FlowResult>` | API diversa da BullMQ |
| `getParentResult(parentId)` | `getParentResult(parentId: string): unknown` | Solo embedded |
| `getParentResults(parentIds)` | `getParentResults(parentIds: string[]): Map<string, unknown>` | Solo embedded |
| `close()` | `close(): void` | Identico |

### Metodi Da Implementare 🔴

| Metodo | Firma BullMQ v5 | Priorità | Complessità |
|--------|-----------------|----------|-------------|
| `add(flow)` | `add(flow: FlowJob, opts?): Promise<JobNode>` | **Alta** | Alta |
| `addBulk(flows)` | `addBulk(flows: FlowJob[]): Promise<JobNode[]>` | Media | Alta |
| `getFlow(opts)` | `getFlow(opts): Promise<JobNode \| null>` | Media | Alta |
| `disconnect()` | `disconnect(): Promise<void>` | Bassa | Bassa |
| `waitUntilReady()` | `waitUntilReady(): Promise<void>` | Bassa | Bassa |

---

## QueueEvents

### Eventi Implementati ✅

| Evento | Payload | Note |
|--------|---------|------|
| `waiting` | `{jobId: string}` | Identico |
| `active` | `{jobId: string}` | Identico |
| `completed` | `{jobId: string, returnvalue: any}` | Identico |
| `failed` | `{jobId: string, failedReason: string}` | Identico |
| `progress` | `{jobId: string, data: any}` | Identico |
| `stalled` | `{jobId: string}` | Identico |
| `error` | `Error` | ✅ Implementato |

### Metodi Implementati ✅

| Metodo | Firma | Note |
|--------|-------|------|
| `constructor(name)` | `new QueueEvents(name: string)` | Identico |
| `close()` | `close(): void` | Identico |
| `on(event, listener)` | Ereditato da EventEmitter | Identico |
| `once(event, listener)` | Ereditato da EventEmitter | Identico |
| `off(event, listener)` | Ereditato da EventEmitter | Identico |
| `emitError(error)` | `emitError(error: Error): void` | ✅ Extra bunqueue |

### Eventi Da Implementare 🔴

| Evento | Payload BullMQ v5 | Priorità | Complessità |
|--------|-------------------|----------|-------------|
| `drained` | `{id: string}` | Media | Bassa |
| `removed` | `{jobId: string, prev: string}` | Media | Bassa |
| `delayed` | `{jobId: string, delay: number}` | Media | Bassa |
| `duplicated` | `{jobId: string}` | Bassa | Bassa |
| `retried` | `{jobId: string, prev: string}` | Media | Bassa |
| `waiting-children` | `{jobId: string}` | Bassa | Bassa |

### Metodi Da Implementare 🔴

| Metodo | Firma BullMQ v5 | Priorità | Complessità |
|--------|-----------------|----------|-------------|
| `waitUntilReady()` | `waitUntilReady(): Promise<void>` | Bassa | Bassa |
| `disconnect()` | `disconnect(): Promise<void>` | Bassa | Bassa |

---

## Riepilogo Implementazione

### Statistiche Generali

| Componente | Implementati | Da Implementare | Copertura |
|------------|--------------|-----------------|-----------|
| Queue (metodi) | **35** | 18 | **66%** |
| Queue (extra bunqueue) | 11 | - | - |
| Worker (metodi/opzioni) | 14 | 18 | 44% |
| Job (proprietà) | 9 | 14 | 39% |
| Job (metodi) | **5** | 23 | **18%** |
| JobOptions | 11 | 20 | 35% |
| FlowProducer | 6 | 5 | 55% |
| QueueEvents | **8 eventi + 5 metodi** | 6 eventi + 2 metodi | **62%** |

### ✅ Implementati in questa sessione

**Queue:**
- `getJobState(jobId)`
- `count()` / `countAsync()`
- `isPaused()` / `isPausedAsync()`
- `getActive/Completed/Failed/Delayed/Waiting()` + async versions
- `getActiveCount/CompletedCount/FailedCount/DelayedCount/WaitingCount()`
- `clean()` / `cleanAsync()`
- `retryJobs(opts?)`
- `promoteJobs(opts?)`
- `getJobLogs()`
- `addJobLog()`
- `updateJobProgress()`
- `setGlobalConcurrency()` / `removeGlobalConcurrency()` / `getGlobalConcurrency()`
- `setGlobalRateLimit()` / `removeGlobalRateLimit()` / `getGlobalRateLimit()`
- `getMetrics()`
- `getWorkers()` / `getWorkersCount()`

**Job:**
- `getState()`
- `remove()`
- `retry()`

**QueueEvents:**
- `error` event
- `emitError()` method

### 🔴 Priorità Alta Rimanenti

1. **JobOptions.parent** - Dipendenze parent/child
2. **Job.getChildrenValues()** - Risultati job figli
3. **FlowProducer.add(flow)** - API identica BullMQ
4. **Queue.upsertJobScheduler()** - Job schedulati
5. **Worker.limiter** option - Rate limiting per worker

### Piano di Implementazione Rimanente

1. **Fase 1**: Job Scheduler API (upsertJobScheduler, removeJobScheduler, etc.)
2. **Fase 2**: Flow/Dependencies (FlowProducer.add, parent option, getChildrenValues)
3. **Fase 3**: Worker enhancements (limiter, isRunning, isPaused, cancelJob)
4. **Fase 4**: Job properties (processedOn, finishedOn, stacktrace, etc.)
5. **Fase 5**: Remaining events (drained, removed, delayed, duplicated, retried)
