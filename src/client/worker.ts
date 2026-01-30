/**
 * Worker - BullMQ-style API
 * Default: TCP connection to localhost:6789
 * Optional: embedded mode with { embedded: true }
 *
 * Performance optimizations:
 * - Batch pull: fetches multiple jobs per round-trip (batchSize option)
 * - Batch ACK: acknowledges multiple jobs per round-trip (ackInterval option)
 * - Parallel processing up to concurrency limit
 */

import { EventEmitter } from 'events';
import { getSharedManager } from './manager';
import { getSharedTcpClient, type TcpClient } from './tcpClient';
import type { WorkerOptions, Processor, ConnectionOptions } from './types';
import { createPublicJob } from './types';
import type { Job as InternalJob } from '../domain/types/job';
import { jobId } from '../domain/types/job';

/** Pending ACK item */
interface PendingAck {
  id: string;
  result: unknown;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Extended options with all defaults */
interface ExtendedWorkerOptions extends Required<Omit<WorkerOptions, 'connection' | 'embedded'>> {
  connection?: ConnectionOptions;
  embedded: boolean;
}

/** Check if embedded mode should be forced (for tests) */
const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/**
 * Worker class for processing jobs
 * Default: connects to bunqueue server via TCP
 * Use { embedded: true } for in-process mode
 * Set BUNQUEUE_EMBEDDED=1 env var to force embedded mode
 */
export class Worker<T = unknown, R = unknown> extends EventEmitter {
  readonly name: string;
  private readonly opts: ExtendedWorkerOptions;
  private readonly processor: Processor<T, R>;
  private readonly embedded: boolean;
  private readonly tcpClient: TcpClient | null;
  private running = false;
  private activeJobs = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private consecutiveErrors = 0;
  private readonly pendingJobs: InternalJob[] = []; // Buffer for batch-pulled jobs

  // Batch ACK state
  private readonly pendingAcks: PendingAck[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ackBatchSize: number;
  private readonly ackInterval: number;

  private static readonly MAX_BACKOFF_MS = 30_000;
  private static readonly BASE_BACKOFF_MS = 100;

  constructor(name: string, processor: Processor<T, R>, opts: WorkerOptions = {}) {
    super();
    this.name = name;
    this.processor = processor;
    this.embedded = opts.embedded ?? FORCE_EMBEDDED;
    this.opts = {
      concurrency: opts.concurrency ?? 1,
      autorun: opts.autorun ?? true,
      heartbeatInterval: opts.heartbeatInterval ?? 10000,
      batchSize: Math.min(opts.batchSize ?? 10, 1000), // Default 10, max 1000
      embedded: this.embedded,
    };

    // Batch ACK settings
    this.ackBatchSize = opts.batchSize ?? 10; // ACK when this many complete
    this.ackInterval = 50; // Or after 50ms, whichever comes first

    if (this.embedded) {
      this.tcpClient = null;
    } else {
      const connOpts: ConnectionOptions = opts.connection ?? {};
      this.tcpClient = getSharedTcpClient({
        host: connOpts.host ?? 'localhost',
        port: connOpts.port ?? 6789,
        token: connOpts.token,
      });
    }

    if (this.opts.autorun) {
      this.run();
    }
  }

  /** Start processing */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.emit('ready');
    this.poll();
  }

  /** Pause processing */
  pause(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Resume processing */
  resume(): void {
    this.run();
  }

  /** Close worker gracefully */
  async close(force = false): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Flush pending ACKs
    await this.flushAcks();

    // Stop ACK timer
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }

    // Stop all heartbeat timers
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    if (!force) {
      while (this.activeJobs > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    this.emit('closed');
  }

  private poll(): void {
    if (!this.running) return;

    if (this.activeJobs >= this.opts.concurrency) {
      this.pollTimer = setTimeout(() => {
        this.poll();
      }, 10);
      return;
    }

    void this.tryProcess();
  }

  private async tryProcess(): Promise<void> {
    if (!this.running) return;

    try {
      // Get job from pending buffer or fetch new batch
      let job: InternalJob | null = this.pendingJobs.shift() ?? null;

      if (!job) {
        // Fetch new batch - calculate how many we can process
        const availableSlots = this.opts.concurrency - this.activeJobs;
        const batchSize = Math.min(this.opts.batchSize, availableSlots, 1000);

        if (batchSize > 0) {
          const jobs = this.embedded
            ? await this.pullBatchEmbedded(batchSize)
            : await this.pullBatchTcp(batchSize);

          if (jobs.length > 0) {
            job = jobs.shift()!;
            this.pendingJobs.push(...jobs); // Buffer remaining jobs
          }
        }
      }

      // Reset error count on successful pull
      this.consecutiveErrors = 0;

      if (job) {
        this.activeJobs++;
        void this.processJob(job).finally(() => {
          this.activeJobs--;
          if (this.running) this.poll();
        });

        // Process more jobs from buffer if available
        if (this.activeJobs < this.opts.concurrency && this.pendingJobs.length > 0) {
          setImmediate(() => {
            void this.tryProcess();
          });
        } else if (this.activeJobs < this.opts.concurrency) {
          // No buffered jobs, schedule another fetch
          setImmediate(() => {
            void this.tryProcess();
          });
        }
      } else {
        // No jobs available, wait before polling again
        this.pollTimer = setTimeout(() => {
          this.poll();
        }, 50);
      }
    } catch (err) {
      this.consecutiveErrors++;

      // Emit error with context
      const error = err instanceof Error ? err : new Error(String(err));
      const wrappedError = Object.assign(error, {
        queue: this.name,
        consecutiveErrors: this.consecutiveErrors,
        context: 'pull',
      });
      this.emit('error', wrappedError);

      // Exponential backoff: 100ms, 200ms, 400ms, ... up to 30s
      const backoffMs = Math.min(
        Worker.BASE_BACKOFF_MS * Math.pow(2, this.consecutiveErrors - 1),
        Worker.MAX_BACKOFF_MS
      );

      this.pollTimer = setTimeout(() => {
        this.poll();
      }, backoffMs);
    }
  }

  /** Pull batch (embedded) */
  private async pullBatchEmbedded(count: number): Promise<InternalJob[]> {
    const manager = getSharedManager();
    if (count === 1) {
      const job = await manager.pull(this.name, 0);
      return job ? [job] : [];
    }
    return manager.pullBatch(this.name, count, 0);
  }

  /** Pull batch of jobs via TCP */
  private async pullBatchTcp(count: number): Promise<InternalJob[]> {
    const response = await this.tcpClient!.send({
      cmd: count === 1 ? 'PULL' : 'PULLB',
      queue: this.name,
      timeout: 0,
      count, // For PULLB
    });

    if (!response.ok) return [];

    // Handle single job response (PULL)
    if (count === 1 && response.job) {
      return [this.parseJob(response.job as Record<string, unknown>)];
    }

    // Handle batch response (PULLB)
    const jobs = response.jobs as Array<Record<string, unknown>> | undefined;
    if (!jobs || jobs.length === 0) return [];

    return jobs.map((j) => this.parseJob(j));
  }

  /** Parse job from TCP response */
  private parseJob(jobData: Record<string, unknown>): InternalJob {
    return {
      id: jobId(jobData.id as string),
      queue: this.name,
      data: jobData.data,
      priority: (jobData.priority as number) ?? 0,
      createdAt: (jobData.createdAt as number) ?? Date.now(),
      runAt: (jobData.runAt as number) ?? Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      attempts: (jobData.attempts as number) ?? 0,
      maxAttempts: (jobData.maxAttempts as number) ?? 3,
      backoff: (jobData.backoff as number) ?? 1000,
      ttl: (jobData.ttl as number) ?? null,
      timeout: (jobData.timeout as number) ?? null,
      uniqueKey: (jobData.uniqueKey as string) ?? null,
      customId: (jobData.customId as string) ?? null,
      progress: (jobData.progress as number) ?? 0,
      progressMessage: (jobData.progressMessage as string) ?? null,
      dependsOn: [],
      parentId: null,
      childrenIds: [],
      childrenCompleted: 0,
      tags: [],
      groupId: null,
      lifo: false,
      removeOnComplete: (jobData.removeOnComplete as boolean) ?? false,
      removeOnFail: false,
      stallCount: 0,
      stallTimeout: null,
      lastHeartbeat: Date.now(),
      repeat: null,
    } as InternalJob;
  }

  /** Queue ACK for batch processing - fire and forget */
  private queueAckFireAndForget(id: string, result: unknown): void {
    this.pendingAcks.push({
      id,
      result,
      resolve: () => {},
      reject: () => {}
    });

    // Flush if batch is full
    if (this.pendingAcks.length >= this.ackBatchSize) {
      void this.flushAcks();
    } else if (!this.ackTimer) {
      // Start timer for partial batch
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        void this.flushAcks();
      }, this.ackInterval);
    }
  }

  /** Flush pending ACKs in batch */
  private async flushAcks(): Promise<void> {
    if (this.pendingAcks.length === 0) return;

    const batch = this.pendingAcks.splice(0, this.pendingAcks.length);

    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }

    try {
      if (this.embedded) {
        // Embedded: batch ack with results
        const manager = getSharedManager();
        const items = batch.map((a) => ({ id: jobId(a.id), result: a.result }));
        await manager.ackBatchWithResults(items);
      } else {
        // TCP: use ACKB command
        const response = await this.tcpClient!.send({
          cmd: 'ACKB',
          ids: batch.map((a) => a.id),
          // Note: ACKB doesn't support individual results, just IDs
        });

        if (!response.ok) {
          throw new Error((response.error as string) ?? 'Batch ACK failed');
        }
      }

      // Resolve all promises
      for (const ack of batch) {
        ack.resolve();
      }
    } catch (err) {
      // Reject all promises
      const error = err instanceof Error ? err : new Error(String(err));
      for (const ack of batch) {
        ack.reject(error);
      }
    }
  }

  private async processJob(internalJob: InternalJob): Promise<void> {
    const jobData = internalJob.data as { name?: string } | null;
    const name = jobData?.name ?? 'default';
    const jobIdStr = String(internalJob.id);

    // Start heartbeat timer for this job
    this.startHeartbeat(jobIdStr, internalJob);

    // Create job with progress and log methods
    const job = createPublicJob<T>(
      internalJob,
      name,
      async (id, progress, message) => {
        if (this.embedded) {
          const manager = getSharedManager();
          await manager.updateProgress(jobId(id), progress, message);
        } else {
          await this.tcpClient!.send({
            cmd: 'Progress',
            id,
            progress,
            message,
          });
        }
        this.emit('progress', job, progress);
      },
      async (id, message) => {
        if (this.embedded) {
          const manager = getSharedManager();
          manager.addLog(jobId(id), message);
        } else {
          await this.tcpClient!.send({
            cmd: 'AddLog',
            id,
            message,
          });
        }
      }
    );

    this.emit('active', job);

    try {
      const result = await this.processor(job);
      this.stopHeartbeat(jobIdStr);

      // Use batch ACK for TCP, direct ACK for embedded
      if (this.embedded) {
        const manager = getSharedManager();
        await manager.ack(internalJob.id, result);
      } else {
        // Queue for batch ACK - fire and forget (don't await)
        this.queueAckFireAndForget(jobIdStr, result);
      }

      (job as { returnvalue?: unknown }).returnvalue = result;
      this.emit('completed', job, result);
    } catch (error) {
      this.stopHeartbeat(jobIdStr);
      const err = error instanceof Error ? error : new Error(String(error));

      // Try to fail the job (not batched - failures are less common)
      try {
        if (this.embedded) {
          const manager = getSharedManager();
          await manager.fail(internalJob.id, err.message);
        } else {
          await this.tcpClient!.send({
            cmd: 'FAIL',
            id: internalJob.id,
            error: err.message,
          });
        }
      } catch (failError) {
        const wrappedError =
          failError instanceof Error ? failError : new Error(String(failError));
        this.emit('error', Object.assign(wrappedError, { context: 'fail', jobId: jobIdStr }));
      }

      (job as { failedReason?: string }).failedReason = err.message;
      this.emit('failed', job, err);
    }
  }

  /** Start heartbeat timer for a job */
  private startHeartbeat(jobIdStr: string, internalJob: InternalJob): void {
    if (this.opts.heartbeatInterval <= 0) return;

    const timer = setInterval(() => {
      // Update lastHeartbeat on the internal job
      internalJob.lastHeartbeat = Date.now();
    }, this.opts.heartbeatInterval);

    this.heartbeatTimers.set(jobIdStr, timer);
  }

  /** Stop heartbeat timer for a job */
  private stopHeartbeat(jobIdStr: string): void {
    const timer = this.heartbeatTimers.get(jobIdStr);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(jobIdStr);
    }
  }
}
