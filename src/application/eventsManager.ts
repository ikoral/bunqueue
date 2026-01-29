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
  /** Waiters for specific job completions - for efficient WaitJob implementation */
  private readonly completionWaiters = new Map<string, Array<() => void>>();

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
    // Clear all waiters
    for (const waiters of this.completionWaiters.values()) {
      for (const resolve of waiters) {
        resolve();
      }
    }
    this.completionWaiters.clear();
  }

  /**
   * Wait for a specific job to complete - event-driven, no polling
   * Returns true if job completed, false if timeout
   */
  waitForJobCompletion(jobId: JobId, timeoutMs: number): Promise<boolean> {
    const jobKey = String(jobId);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Timeout - remove from waiters
        const waiters = this.completionWaiters.get(jobKey);
        if (waiters) {
          const idx = waiters.indexOf(resolveWaiter);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) this.completionWaiters.delete(jobKey);
        }
        resolve(false);
      }, timeoutMs);

      const resolveWaiter = () => {
        clearTimeout(timer);
        resolve(true);
      };

      // Add to waiters
      let waiters = this.completionWaiters.get(jobKey);
      if (!waiters) {
        waiters = [];
        this.completionWaiters.set(jobKey, waiters);
      }
      waiters.push(resolveWaiter);
    });
  }

  /** Check if broadcast has any listeners - for batch optimizations */
  needsBroadcast(): boolean {
    return (
      this.subscribers.length > 0 ||
      this.webhookManager.hasEnabledWebhooks() ||
      this.completionWaiters.size > 0
    );
  }

  /** Broadcast event to all subscribers - optimized to skip work when no listeners */
  broadcast(
    event: Partial<JobEvent> & {
      eventType: EventType;
      queue: string;
      jobId: JobId;
      timestamp: number;
      error?: string;
    }
  ): void {
    const hasSubscribers = this.subscribers.length > 0;
    const hasWebhooks = this.webhookManager.hasEnabledWebhooks();
    const isCompletion = event.eventType === EventType.Completed;
    const hasWaiters = isCompletion && this.completionWaiters.size > 0;

    // Fast path: nothing to notify
    if (!hasSubscribers && !hasWebhooks && !hasWaiters) {
      return;
    }

    // Notify subscribers
    if (hasSubscribers) {
      for (const sub of this.subscribers) {
        try {
          sub(event as JobEvent);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    // Notify completion waiters for WaitJob - O(1) lookup
    if (hasWaiters) {
      const jobKey = String(event.jobId);
      const waiters = this.completionWaiters.get(jobKey);
      if (waiters) {
        this.completionWaiters.delete(jobKey);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }

    // Trigger webhooks - only if there are enabled webhooks
    if (hasWebhooks) {
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
      case EventType.Progress:
      case EventType.Stalled:
        // These events don't have webhook mappings
        return null;
    }
  }
}
