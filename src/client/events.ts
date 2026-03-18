/**
 * QueueEvents - BullMQ-style event listener
 */

import { EventEmitter } from 'events';
import { getSharedManager } from './manager';
import { EventType, type JobEvent } from '../domain/types/queue';

/** Event payload for 'waiting' event */
export interface WaitingEvent {
  jobId: string;
}

/** Event payload for 'active' event */
export interface ActiveEvent {
  jobId: string;
}

/** Event payload for 'completed' event */
export interface CompletedEvent<R = unknown> {
  jobId: string;
  returnvalue: R;
}

/** Event payload for 'failed' event */
export interface FailedEvent {
  jobId: string;
  failedReason: string;
  data?: unknown;
}

/** Event payload for 'progress' event */
export interface ProgressEvent<P = unknown> {
  jobId: string;
  data: P;
}

/** Event payload for 'stalled' event */
export interface StalledEvent {
  jobId: string;
}

/** Event payload for 'removed' event */
export interface RemovedEvent {
  jobId: string;
  prev: string;
}

/** Event payload for 'delayed' event */
export interface DelayedEvent {
  jobId: string;
  delay: number;
}

/** Event payload for 'duplicated' event */
export interface DuplicatedEvent {
  jobId: string;
}

/** Event payload for 'retried' event */
export interface RetriedEvent {
  jobId: string;
  prev: string;
}

/** Event payload for 'waiting-children' event */
export interface WaitingChildrenEvent {
  jobId: string;
}

/** Event payload for 'drained' event */
export interface DrainedEvent {
  id: string;
}

/**
 * QueueEvents class for listening to queue events
 * Provides a way to listen to events without processing jobs
 *
 * BullMQ v5 compatible events:
 * - waiting: job added to queue
 * - active: job started processing
 * - completed: job completed successfully
 * - failed: job failed
 * - progress: job progress updated
 * - stalled: job stalled (no heartbeat)
 * - removed: job removed from queue
 * - delayed: job moved to delayed state
 * - duplicated: duplicate job detected
 * - retried: job retried
 * - waiting-children: job waiting for children to complete
 * - drained: queue has no more waiting jobs
 * - error: error occurred
 *
 * @template R - Type of the job result (for 'completed' event)
 * @template P - Type of the progress data (for 'progress' event)
 */
export class QueueEvents<R = unknown, P = unknown> extends EventEmitter {
  readonly name: string;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private ready = false;

  constructor(name: string) {
    super();
    this.name = name;
    this.start();
  }

  // ============ Typed Event Handlers ============

  on(event: 'waiting', listener: (data: WaitingEvent) => void): this;
  on(event: 'active', listener: (data: ActiveEvent) => void): this;
  on(event: 'completed', listener: (data: CompletedEvent<R>) => void): this;
  on(event: 'failed', listener: (data: FailedEvent) => void): this;
  on(event: 'progress', listener: (data: ProgressEvent<P>) => void): this;
  on(event: 'stalled', listener: (data: StalledEvent) => void): this;
  on(event: 'removed', listener: (data: RemovedEvent) => void): this;
  on(event: 'delayed', listener: (data: DelayedEvent) => void): this;
  on(event: 'duplicated', listener: (data: DuplicatedEvent) => void): this;
  on(event: 'retried', listener: (data: RetriedEvent) => void): this;
  on(event: 'waiting-children', listener: (data: WaitingChildrenEvent) => void): this;
  on(event: 'drained', listener: (data: DrainedEvent) => void): this;
  on(event: 'paused' | 'resumed', listener: (data: Record<string, never>) => void): this;
  on(event: 'error', listener: (error: Error, event?: JobEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'waiting', listener: (data: WaitingEvent) => void): this;
  once(event: 'active', listener: (data: ActiveEvent) => void): this;
  once(event: 'completed', listener: (data: CompletedEvent<R>) => void): this;
  once(event: 'failed', listener: (data: FailedEvent) => void): this;
  once(event: 'progress', listener: (data: ProgressEvent<P>) => void): this;
  once(event: 'stalled', listener: (data: StalledEvent) => void): this;
  once(event: 'removed', listener: (data: RemovedEvent) => void): this;
  once(event: 'delayed', listener: (data: DelayedEvent) => void): this;
  once(event: 'duplicated', listener: (data: DuplicatedEvent) => void): this;
  once(event: 'retried', listener: (data: RetriedEvent) => void): this;
  once(event: 'waiting-children', listener: (data: WaitingChildrenEvent) => void): this;
  once(event: 'drained', listener: (data: DrainedEvent) => void): this;
  once(event: 'paused' | 'resumed', listener: (data: Record<string, never>) => void): this;
  once(event: 'error', listener: (error: Error, event?: JobEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  private dispatchEvent(event: JobEvent): void {
    switch (event.eventType) {
      case EventType.Pushed:
        this.emit('waiting', { jobId: event.jobId });
        break;
      case EventType.Pulled:
        this.emit('active', { jobId: event.jobId });
        break;
      case EventType.Completed:
        this.emit('completed', { jobId: event.jobId, returnvalue: event.data });
        break;
      case EventType.Failed:
        this.emit('failed', {
          jobId: event.jobId,
          failedReason: event.error ?? 'Job failed',
          data: event.data,
        });
        if (event.error) {
          this.emit('error', new Error(event.error), event);
        }
        break;
      case EventType.Progress:
        this.emit('progress', { jobId: event.jobId, data: event.data });
        break;
      case EventType.Stalled:
        this.emit('stalled', { jobId: event.jobId });
        break;
      case EventType.Removed:
        this.emit('removed', { jobId: event.jobId, prev: event.prev ?? 'unknown' });
        break;
      case EventType.Delayed:
        this.emit('delayed', { jobId: event.jobId, delay: event.delay ?? 0 });
        break;
      case EventType.Duplicated:
        this.emit('duplicated', { jobId: event.jobId });
        break;
      case EventType.Retried:
        this.emit('retried', { jobId: event.jobId, prev: event.prev ?? 'failed' });
        break;
      case EventType.WaitingChildren:
        this.emit('waiting-children', { jobId: event.jobId });
        break;
      case EventType.Drained:
        this.emit('drained', { id: event.jobId });
        break;
      case EventType.Paused:
        this.emit('paused', {});
        break;
      case EventType.Resumed:
        this.emit('resumed', {});
        break;
    }
  }

  private start(): void {
    if (this.running || this.unsubscribe) return;
    this.running = true;

    const manager = getSharedManager();
    const handler = (event: JobEvent) => {
      try {
        if (event.queue !== this.name) return;
        this.dispatchEvent(event);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.unsubscribe = manager.subscribe(handler);
    this.ready = true;
  }

  /** Emit an error event (can be called externally) */
  emitError(error: Error): void {
    this.emit('error', error);
  }

  /**
   * Wait until the QueueEvents is ready to receive events.
   * In embedded mode, this resolves immediately.
   * BullMQ v5 compatible.
   */
  async waitUntilReady(): Promise<void> {
    // In embedded mode, we're always ready after construction
    if (this.ready) return;
    // Wait a tick for the subscription to complete
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /**
   * Disconnect from the event stream.
   * Alias for close() for BullMQ v5 compatibility.
   */
  disconnect(): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  /** Close the event listener and remove all listeners */
  close(): void {
    this.running = false;
    this.ready = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.removeAllListeners();
  }
}
