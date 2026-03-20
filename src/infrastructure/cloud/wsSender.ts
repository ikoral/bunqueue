/**
 * WebSocket Sender
 * Maintains a persistent outbound WebSocket to the dashboard for real-time events.
 *
 * Features:
 * - Ring buffer: events are buffered when disconnected, flushed on reconnect
 * - Client-side ping: detects dead connections in ~10s (vs 40s server-side)
 * - Binary frame handling: works behind Cloudflare (text + ArrayBuffer)
 * - Local socket ref: pong always replies on the correct socket after reconnect
 */

import type { CloudConfig, CloudEvent } from './types';
import type { CloudCommand } from './commandHandler';
import { cloudLog } from './logger';

const EVENT_BUFFER_MAX = 1000;
const CLIENT_PING_INTERVAL = 10_000;
const CLIENT_PONG_TIMEOUT = 5_000;
const HANDSHAKE_ACK_TIMEOUT = 5_000;

export class WsSender {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private stopped = false;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private handshakeAckTimer: ReturnType<typeof setTimeout> | null = null;
  private flushed = false;

  /** Ring buffer for events while disconnected */
  private readonly eventBuffer: CloudEvent[] = [];

  private onCommand: ((cmd: CloudCommand) => void) | null = null;

  constructor(
    private readonly config: CloudConfig,
    private readonly instanceId: string
  ) {}

  /** Set handler for incoming commands from dashboard */
  setCommandHandler(handler: (cmd: CloudCommand) => void): void {
    this.onCommand = handler;
  }

  /** Open the WebSocket connection */
  connect(): void {
    if (this.stopped) return;

    // Close previous socket if still lingering
    this.cleanup();

    const wsUrl = this.config.url.replace(/^http/, 'ws').concat('/api/v1/stream');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      cloudLog.debug('WS connect error', { error: String(err) });
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      cloudLog.info('WebSocket stream connected');

      // Send handshake
      ws.send(
        JSON.stringify({
          type: 'handshake',
          instanceId: this.instanceId,
          apiKey: this.config.apiKey,
          remoteCommands: this.config.remoteCommands,
        })
      );

      // Flush after handshake_ack, with fallback timeout
      this.flushed = false;
      this.handshakeAckTimer = setTimeout(() => {
        if (!this.flushed) {
          cloudLog.debug('handshake_ack timeout — flushing buffer anyway');
          this.flushed = true;
          this.flushBuffer(ws);
        }
      }, HANDSHAKE_ACK_TIMEOUT);

      // Start client-side ping
      this.startClientPing(ws);
    };

    // Handle incoming messages (pings + pongs + commands)
    // Uses local `ws` ref — NOT `this.ws` — to always reply on the correct socket
    ws.onmessage = (event) => {
      try {
        let raw: string;
        const d: unknown = event.data;
        if (typeof d === 'string') {
          raw = d;
        } else if (d instanceof ArrayBuffer) {
          raw = new TextDecoder().decode(d);
        } else if (d instanceof Buffer) {
          raw = d.toString('utf-8');
        } else {
          raw = String(d);
        }

        const msg = JSON.parse(raw) as Record<string, unknown>;

        // Server heartbeat — respond immediately on the SAME socket
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Response to our client-side ping
        if (msg.type === 'pong') {
          this.awaitingPong = false;
          if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
          }
          return;
        }

        if (msg.type === 'handshake_ack') {
          cloudLog.debug('Handshake acknowledged');
          if (!this.flushed) {
            this.flushed = true;
            if (this.handshakeAckTimer) {
              clearTimeout(this.handshakeAckTimer);
              this.handshakeAckTimer = null;
            }
            this.flushBuffer(ws);
          }
          return;
        }

        // Commands
        if (
          this.onCommand &&
          this.config.remoteCommands &&
          msg.type === 'command' &&
          msg.action &&
          msg.id
        ) {
          this.onCommand(msg as unknown as CloudCommand);
        }
      } catch (err) {
        cloudLog.debug('WS message parse error', {
          dataType: typeof event.data,
          isArrayBuffer: event.data instanceof ArrayBuffer,
          preview: String(event.data).slice(0, 100),
          error: String(err),
        });
      }
    };

    ws.onclose = (ev) => {
      cloudLog.debug('WebSocket closed', { code: ev.code, reason: ev.reason });
      this.connected = false;
      this.stopClientPing();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      this.connected = false;
    };
  }

  /** Send an event. Buffers in ring buffer if disconnected. */
  send(event: CloudEvent): void {
    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify(event));
        return;
      } catch {
        // Fall through to buffer
      }
    }

    // Buffer when disconnected (ring buffer — drop oldest)
    if (this.eventBuffer.length >= EVENT_BUFFER_MAX) {
      this.eventBuffer.shift();
    }
    this.eventBuffer.push(event);
  }

  /** Send any JSON payload on the WebSocket */
  sendRaw(data: unknown): void {
    if (!this.connected || !this.ws) return;

    try {
      this.ws.send(JSON.stringify(data));
    } catch {
      // Best-effort: dropped
    }
  }

  /**
   * Drain buffered events for HTTP fallback (dual-channel).
   * Returns and clears all buffered events.
   */
  drainBufferedEvents(): CloudEvent[] {
    if (this.eventBuffer.length === 0) return [];
    const events = this.eventBuffer.splice(0);
    return events;
  }

  /** Number of buffered events */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }

  /** Graceful shutdown */
  stop(): void {
    this.stopped = true;
    this.stopClientPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.handshakeAckTimer) {
      clearTimeout(this.handshakeAckTimer);
      this.handshakeAckTimer = null;
    }
    this.cleanup();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Flush buffered events on reconnect */
  private flushBuffer(ws: WebSocket): void {
    if (this.eventBuffer.length === 0) return;

    const count = this.eventBuffer.length;
    cloudLog.info('Flushing buffered events', { count });

    while (this.eventBuffer.length > 0) {
      const event = this.eventBuffer.shift();
      if (!event) break;
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // Re-buffer remaining events
        this.eventBuffer.unshift(event);
        break;
      }
    }
  }

  /** Client-side ping: detect dead connections faster than server timeout */
  private startClientPing(ws: WebSocket): void {
    this.stopClientPing();

    this.pingTimer = setInterval(() => {
      if (!this.connected || this.awaitingPong) return;

      try {
        ws.send(JSON.stringify({ type: 'ping' }));
        this.awaitingPong = true;

        // If no pong within timeout, connection is dead.
        // Only close the socket — onclose will handle scheduleReconnect.
        this.pongTimer = setTimeout(() => {
          if (this.awaitingPong) {
            cloudLog.debug('Client ping timeout — closing socket');
            this.awaitingPong = false;
            this.stopClientPing();
            try {
              ws.close(4000, 'ping timeout');
            } catch {
              // If close fails, force state and reconnect manually
              this.connected = false;
              this.scheduleReconnect();
            }
          }
        }, CLIENT_PONG_TIMEOUT);
      } catch {
        // Socket dead, onclose will handle reconnect
      }
    }, CLIENT_PING_INTERVAL);
  }

  private stopClientPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.awaitingPong = false;
  }

  /** Clean up socket handlers and close */
  private cleanup(): void {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close(1000);
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const jitter = Math.random() * 1000;
    const delay = this.reconnectDelay + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
