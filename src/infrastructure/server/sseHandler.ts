/**
 * SSE Handler - Enterprise-grade Server-Sent Events
 *
 * Features:
 * - Event IDs for client-side deduplication
 * - Last-Event-ID resume on reconnection (ring buffer)
 * - Heartbeat keepalive (30s) to detect dead connections
 * - Connection limits to prevent resource exhaustion
 * - Automatic dead client cleanup
 */

import type { JobEvent } from '../../domain/types/queue';
import { uuid } from '../../shared/hash';

const textEncoder = new TextEncoder();

/** Tuning constants */
const MAX_CLIENTS = 1000;
const HEARTBEAT_MS = 30_000;
const RETRY_MS = 3_000;
const EVENT_BUFFER_SIZE = 1000;

/** SSE client tracking */
export interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController;
  queueFilter: string | null;
}

/** Buffered event for Last-Event-ID replay */
interface BufferedEvent {
  id: number;
  data: string;
  queue: string;
}

/**
 * SSE Handler - manages Server-Sent Events clients
 */
export class SseHandler {
  private readonly clients = new Map<string, SseClient>();
  private eventId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly eventBuffer: BufferedEvent[] = [];

  /** Get client count */
  get size(): number {
    return this.clients.size;
  }

  /** Start heartbeat timer — call once after creating the handler */
  startHeartbeat(): void {
    this.heartbeatTimer ??= setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_MS);
  }

  /** Stop heartbeat timer */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Send heartbeat comment to all clients, prune dead ones */
  private sendHeartbeat(): void {
    if (this.clients.size === 0) return;
    const heartbeat = textEncoder.encode(`:heartbeat\n\n`);
    const disconnected: string[] = [];

    for (const [clientId, client] of this.clients) {
      try {
        client.controller.enqueue(heartbeat);
      } catch {
        disconnected.push(clientId);
      }
    }

    for (const id of disconnected) {
      this.clients.delete(id);
    }
  }

  /** Broadcast event to all matching clients */
  broadcast(event: JobEvent): void {
    const id = ++this.eventId;
    const data = JSON.stringify(event);

    // Buffer for Last-Event-ID replay
    this.bufferEvent(id, data, event.queue);

    const sseMessage = `id: ${id}\ndata: ${data}\n\n`;
    const encoded = textEncoder.encode(sseMessage);
    const disconnected: string[] = [];

    for (const [clientId, client] of this.clients) {
      if (!client.queueFilter || client.queueFilter === event.queue) {
        try {
          client.controller.enqueue(encoded);
        } catch {
          disconnected.push(clientId);
        }
      }
    }

    for (const clientId of disconnected) {
      this.clients.delete(clientId);
    }
  }

  /** Buffer event for replay (ring buffer, capped at EVENT_BUFFER_SIZE) */
  private bufferEvent(id: number, data: string, queue: string): void {
    this.eventBuffer.push({ id, data, queue });
    if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }
  }

  /** Replay missed events for a reconnecting client */
  private replayEvents(client: SseClient, lastEventId: number): void {
    for (const event of this.eventBuffer) {
      if (event.id <= lastEventId) continue;
      if (client.queueFilter && client.queueFilter !== event.queue) continue;
      try {
        const msg = `id: ${event.id}\ndata: ${event.data}\n\n`;
        client.controller.enqueue(textEncoder.encode(msg));
      } catch {
        break;
      }
    }
  }

  /** Create SSE response for a new client */
  createResponse(queueFilter: string | null, corsOrigin: string, lastEventId?: string): Response {
    if (this.clients.size >= MAX_CLIENTS) {
      return new Response('Too many SSE connections', { status: 503 });
    }

    const clientId = uuid();
    const resumeId = lastEventId ? parseInt(lastEventId, 10) : 0;

    const stream = new ReadableStream({
      start: (controller) => {
        const client: SseClient = { id: clientId, controller, queueFilter };
        this.clients.set(clientId, client);

        // Retry interval + connected confirmation in a single chunk
        controller.enqueue(
          textEncoder.encode(
            `retry: ${RETRY_MS}\ndata: {"connected":true,"clientId":"${clientId}"}\n\n`
          )
        );

        // Replay missed events on reconnection
        if (resumeId > 0) {
          this.replayEvents(client, resumeId);
        }
      },
      cancel: () => {
        this.clients.delete(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }

  /** Close all connections and stop heartbeat */
  closeAll(): void {
    this.stopHeartbeat();
    for (const [, client] of this.clients) {
      try {
        client.controller.close();
      } catch {
        // Ignore
      }
    }
    this.clients.clear();
  }

  /** Get clients map (for backward compatibility) */
  getClients(): Map<string, SseClient> {
    return this.clients;
  }
}
