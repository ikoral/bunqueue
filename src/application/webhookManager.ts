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

/** Maximum webhook delivery retries (configurable via WEBHOOK_MAX_RETRIES env var) */
const WEBHOOK_MAX_RETRIES = parseInt(Bun.env.WEBHOOK_MAX_RETRIES ?? '3', 10);

/** Delay between webhook retries in ms (configurable via WEBHOOK_RETRY_DELAY_MS env var) */
const WEBHOOK_RETRY_DELAY_MS = parseInt(Bun.env.WEBHOOK_RETRY_DELAY_MS ?? '1000', 10);

/** HMAC-SHA256 signature using Bun native CryptoHasher (2-3x faster than WebCrypto) */
function signPayload(payload: string, secret: string): string {
  const hasher = new Bun.CryptoHasher('sha256', secret);
  hasher.update(payload);
  return hasher.digest('hex');
}

/**
 * Webhook Manager
 */
export class WebhookManager {
  private readonly webhooks = new Map<WebhookId, Webhook>();
  private readonly maxRetries = WEBHOOK_MAX_RETRIES;
  private readonly retryDelay = WEBHOOK_RETRY_DELAY_MS;

  /** Running counter for enabled webhooks - avoids O(n) filter in getStats */
  private enabledCount = 0;

  /** Add a webhook */
  add(url: string, events: string[], queue?: string, secret?: string): Webhook {
    const webhook = createWebhook(url, events, queue, secret);
    this.webhooks.set(webhook.id, webhook);
    if (webhook.enabled) {
      this.enabledCount++;
    }
    webhookLog.info('Added webhook', { webhookId: webhook.id, events });
    return webhook;
  }

  /** Remove a webhook */
  remove(id: WebhookId): boolean {
    const webhook = this.webhooks.get(id);
    if (webhook?.enabled) {
      this.enabledCount--;
    }
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

  /** Set webhook enabled state - properly maintains running counter */
  setEnabled(id: WebhookId, enabled: boolean): boolean {
    const webhook = this.webhooks.get(id);
    if (!webhook) return false;

    if (webhook.enabled !== enabled) {
      webhook.enabled = enabled;
      this.enabledCount += enabled ? 1 : -1;
    }
    return true;
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
      headers['X-Webhook-Signature'] = signPayload(body, webhook.secret);
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
        await Bun.sleep(this.retryDelay * (attempt + 1));
      }
    }

    webhook.failureCount++;
    throw lastError ?? new Error('Webhook delivery failed after max retries');
  }

  /** Check if there are any enabled webhooks - O(1) */
  hasEnabledWebhooks(): boolean {
    return this.enabledCount > 0;
  }

  /** Get stats - O(1) using running counter */
  getStats() {
    return {
      total: this.webhooks.size,
      enabled: this.enabledCount,
    };
  }
}
