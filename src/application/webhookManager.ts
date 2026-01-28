/**
 * Webhook Manager
 * Manages webhooks and sends HTTP callbacks
 */

import {
  type Webhook,
  type WebhookId,
  type WebhookEvent,
  type WebhookPayload,
  createWebhook,
} from '../domain/types/webhook';
import { webhookLog } from '../shared/logger';

/** HMAC-SHA256 signature */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Webhook Manager
 */
export class WebhookManager {
  private webhooks = new Map<WebhookId, Webhook>();
  private maxRetries = 3;
  private retryDelay = 1000;

  /** Add a webhook */
  add(url: string, events: string[], queue?: string, secret?: string): Webhook {
    const webhook = createWebhook(url, events, queue, secret);
    this.webhooks.set(webhook.id, webhook);
    webhookLog.info('Added webhook', { webhookId: webhook.id, events });
    return webhook;
  }

  /** Remove a webhook */
  remove(id: WebhookId): boolean {
    const removed = this.webhooks.delete(id);
    if (removed) {
      webhookLog.info('Removed webhook', { webhookId: id });
    }
    return removed;
  }

  /** Get webhook by ID */
  get(id: WebhookId): Webhook | undefined {
    return this.webhooks.get(id);
  }

  /** List all webhooks */
  list(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  /** Trigger webhooks for an event */
  async trigger(
    event: WebhookEvent,
    jobId: string,
    queue: string,
    extra?: { data?: unknown; error?: string; progress?: number }
  ): Promise<void> {
    const payload: WebhookPayload = {
      event,
      timestamp: Date.now(),
      jobId,
      queue,
      ...extra,
    };

    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (wh) => wh.enabled && wh.events.includes(event) && (wh.queue === null || wh.queue === queue)
    );

    // Fire and forget - don't block
    for (const webhook of matchingWebhooks) {
      this.sendWebhook(webhook, payload).catch((err: unknown) => {
        webhookLog.error('Failed to send webhook', { url: webhook.url, error: String(err) });
      });
    }
  }

  /** Send webhook with retries */
  private async sendWebhook(webhook: Webhook, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': payload.event,
      'X-Webhook-Timestamp': String(payload.timestamp),
    };

    // Add signature if secret is set
    if (webhook.secret) {
      headers['X-Webhook-Signature'] = await signPayload(body, webhook.secret);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          webhook.lastTriggered = Date.now();
          webhook.successCount++;
          return;
        }

        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Wait before retry
      if (attempt < this.maxRetries - 1) {
        await new Promise((r) => setTimeout(r, this.retryDelay * (attempt + 1)));
      }
    }

    webhook.failureCount++;
    throw lastError ?? new Error('Webhook delivery failed after max retries');
  }

  /** Get stats */
  getStats() {
    return {
      total: this.webhooks.size,
      enabled: Array.from(this.webhooks.values()).filter((w) => w.enabled).length,
    };
  }
}
