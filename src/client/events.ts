/**
 * QueueEvents - BullMQ-style event listener
 */

import { EventEmitter } from 'events';
import { getSharedManager } from './manager';
import { EventType, type JobEvent } from '../domain/types/queue';

/**
 * QueueEvents class for listening to queue events
 * Provides a way to listen to events without processing jobs
 */
export class QueueEvents extends EventEmitter {
  readonly name: string;
  private running = false;
  private unsubscribe: (() => void) | null = null;

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
        }
      } catch (err) {
        // Emit error event for any handler errors
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.unsubscribe = manager.subscribe(handler);
  }

  /** Emit an error event (can be called externally) */
  emitError(error: Error): void {
    this.emit('error', error);
  }

  /** Close the event listener */
  close(): void {
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Note: User-attached listeners are NOT removed here.
    // Users should manage their own listeners via removeListener() or removeAllListeners().
  }
}
