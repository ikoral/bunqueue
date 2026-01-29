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
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(name: string) {
    super();
    this.name = name;
    this.start();
  }

  private start(): void {
    if (this.running) return;
    this.running = true;

    // Subscribe to events from QueueManager
    const manager = getSharedManager();
    const handler = (event: JobEvent) => {
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
          break;
        case EventType.Progress:
          this.emit('progress', { jobId: event.jobId, data: event.data });
          break;
        case EventType.Stalled:
          this.emit('stalled', { jobId: event.jobId });
          break;
      }
    };

    this.unsubscribe = manager.subscribe(handler);
  }

  /** Close the event listener */
  close(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.removeAllListeners();
  }
}
