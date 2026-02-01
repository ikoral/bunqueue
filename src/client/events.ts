/**
 * QueueEvents - BullMQ-style event listener
 */

import { EventEmitter } from 'events';
import { getSharedManager } from './manager';
import { EventType, type JobEvent } from '../domain/types/queue';

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
 */
export class QueueEvents extends EventEmitter {
  readonly name: string;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private ready = false;

  constructor(name: string) {
    super();
    this.name = name;
    this.start();
  }

  private start(): void {
    // Guard against double subscription (race condition prevention)
    if (this.running || this.unsubscribe) return;
    this.running = true;

    // Subscribe to events from QueueManager
    const manager = getSharedManager();
    const handler = (event: JobEvent) => {
      try {
        if (event.queue !== this.name) return;

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
            this.emit('failed', { jobId: event.jobId, failedReason: event.data });
            // Also emit error event for failed jobs (BullMQ compatibility)
            if (event.error) {
              this.emit('error', new Error(event.error));
            }
            break;
          case EventType.Progress:
            this.emit('progress', { jobId: event.jobId, data: event.data });
            break;
          case EventType.Stalled:
            this.emit('stalled', { jobId: event.jobId });
            break;
          // BullMQ v5 additional events
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
        }
      } catch (err) {
        // Emit error event for any handler errors
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

  /** Close the event listener */
  close(): void {
    this.running = false;
    this.ready = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Note: User-attached listeners are NOT removed here.
    // Users should manage their own listeners via removeListener() or removeAllListeners().
  }
}
