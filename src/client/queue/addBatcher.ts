/**
 * Add Batcher
 * Batches queue.add() calls for efficient TCP communication via PUSHB
 *
 * Strategy: if no flush is in-flight, send immediately (zero overhead for
 * sequential await). If a flush IS in-flight, buffer and send when it
 * completes or after maxDelayMs, whichever comes first. This gives both
 * zero-latency sequential adds AND automatic batching for concurrent adds.
 */

import type { Job, JobOptions } from '../types';

/** Pending add entry with resolve/reject callbacks */
interface PendingAdd<T> {
  name: string;
  data: T;
  opts?: JobOptions;
  resolve: (job: Job<T>) => void;
  reject: (err: Error) => void;
}

/** Add batcher configuration */
export interface AddBatcherConfig {
  /** Max items before auto-flush (default: 50) */
  maxSize: number;
  /** Max delay in ms before auto-flush (default: 5) */
  maxDelayMs: number;
  /** Max pending items before overflow protection (default: 10000) */
  maxPending?: number;
}

/** Flush callback that sends a batch and returns Job objects */
export type FlushCallback<T> = (
  jobs: Array<{ name: string; data: T; opts?: JobOptions }>
) => Promise<Job<T>[]>;

/**
 * Batches add() operations into addBulk() calls for efficient TCP throughput.
 *
 * - If no flush is in-flight: flushes immediately (no timer delay)
 * - If a flush IS in-flight: buffers until maxSize or maxDelayMs
 * - After each flush completes: drains any accumulated buffer immediately
 */
export class AddBatcher<T> {
  private readonly maxPending: number;
  private readonly pending: PendingAdd<T>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly config: AddBatcherConfig;
  private readonly flushCb: FlushCallback<T>;
  private stopped = false;
  private flushing = false;
  private readonly inFlightFlushes: Set<Promise<void>> = new Set();

  constructor(config: AddBatcherConfig, flushCb: FlushCallback<T>) {
    this.config = config;
    this.maxPending = config.maxPending ?? 10000;
    this.flushCb = flushCb;
  }

  /** Enqueue an add() call, returns Promise<Job<T>> resolved after flush */
  enqueue(name: string, data: T, opts?: JobOptions): Promise<Job<T>> {
    return new Promise<Job<T>>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('AddBatcher stopped'));
        return;
      }

      // Overflow protection: drop oldest 10% if buffer is full
      if (this.pending.length >= this.maxPending) {
        const dropped = this.pending.splice(0, Math.floor(this.maxPending * 0.1));
        for (const entry of dropped) {
          entry.reject(new Error('Add buffer overflow - oldest entries dropped'));
        }
      }

      this.pending.push({ name, data, opts, resolve, reject });

      if (this.pending.length >= this.config.maxSize) {
        // Size threshold reached - flush now
        this.triggerFlush();
      } else if (!this.flushing) {
        // No flush in-flight - flush immediately (zero latency for sequential)
        this.triggerFlush();
      } else {
        // Flush in-flight - start timer, items will batch up naturally
        this.timer ??= setTimeout(() => {
          this.timer = null;
          this.triggerFlush();
        }, this.config.maxDelayMs);
      }
    });
  }

  /** Start a flush and track it */
  private triggerFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const flushPromise = this.doFlush().catch((err: unknown) => {
      console.error('[bunqueue] Flush failed:', err instanceof Error ? err.message : String(err));
    });
    this.inFlightFlushes.add(flushPromise);
    void flushPromise.finally(() => this.inFlightFlushes.delete(flushPromise));
  }

  /** Flush pending adds, then drain any items that accumulated during flush */
  private async doFlush(): Promise<void> {
    if (this.pending.length === 0) return;
    this.flushing = true;

    try {
      while (this.pending.length > 0 && !this.stopped) {
        await this.flushOnce();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Flush all pending adds as a single addBulk call */
  async flush(): Promise<void> {
    await this.doFlush();
  }

  /** Send one batch */
  private async flushOnce(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      const jobs = await this.flushCb(
        batch.map((entry) => ({ name: entry.name, data: entry.data, opts: entry.opts }))
      );

      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(jobs[i]);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const entry of batch) {
        entry.reject(error);
      }
    }
  }

  /** Stop the batcher - rejects remaining pending entries */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const error = new Error('AddBatcher stopped');
    const remaining = this.pending.splice(0, this.pending.length);
    for (const entry of remaining) {
      entry.reject(error);
    }
  }

  /** Wait for all in-flight flush operations to complete */
  async waitForInFlight(): Promise<void> {
    if (this.inFlightFlushes.size === 0) return;
    await Promise.all(this.inFlightFlushes);
  }

  /** Check if there are pending adds */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
