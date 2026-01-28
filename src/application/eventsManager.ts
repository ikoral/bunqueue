/**
 * Events Manager
 * Job event subscription and broadcasting
 */

import type { JobId } from '../domain/types/job';
import { EventType, type JobEvent } from '../domain/types/queue';
import type { WebhookManager } from './webhookManager';
import type { WebhookEvent } from '../domain/types/webhook';
import { webhookLog } from '../shared/logger';

/** Event subscriber callback */
export type EventSubscriber = (event: JobEvent) => void;

/** Events manager class */
export class EventsManager {
  private readonly subscribers: EventSubscriber[] = [];

  constructor(private readonly webhookManager: WebhookManager) {}

  /** Subscribe to job events */
  subscribe(callback: EventSubscriber): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  /** Clear all subscribers (for shutdown) */
  clear(): void {
    this.subscribers.length = 0;
  }

  /** Broadcast event to all subscribers */
  broadcast(
    event: Partial<JobEvent> & {
      eventType: EventType;
      queue: string;
      jobId: JobId;
      timestamp: number;
      error?: string;
    }
  ): void {
    // Notify subscribers
    for (const sub of this.subscribers) {
      try {
        sub(event as JobEvent);
      } catch {
        // Ignore subscriber errors
      }
    }

    // Trigger webhooks
    const webhookEvent = this.mapEventToWebhook(event.eventType);
    if (webhookEvent) {
      this.webhookManager
        .trigger(webhookEvent, String(event.jobId), event.queue, {
          data: event.data,
          error: event.error,
        })
        .catch((err: unknown) => {
          webhookLog.error('Webhook trigger failed', {
            event: webhookEvent,
            jobId: String(event.jobId),
            queue: event.queue,
            error: String(err),
          });
        });
    }
  }

  /** Map internal event type to webhook event */
  private mapEventToWebhook(eventType: EventType): WebhookEvent | null {
    switch (eventType) {
      case EventType.Pushed:
        return 'job.pushed';
      case EventType.Pulled:
        return 'job.started';
      case EventType.Completed:
        return 'job.completed';
      case EventType.Failed:
        return 'job.failed';
      default:
        return null;
    }
  }
}
