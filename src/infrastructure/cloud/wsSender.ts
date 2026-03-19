/**
 * WebSocket Sender
 * Maintains a persistent outbound WebSocket to the dashboard for real-time events
 */

import type { CloudConfig, CloudEvent } from './types';
import type { CloudCommand } from './commandHandler';
import { cloudLog } from './logger';

export class WsSender {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private stopped = false;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    const wsUrl = this.config.url.replace(/^http/, 'ws').concat('/api/v1/stream');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      cloudLog.debug('WS connect error', { error: String(err) });
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      cloudLog.info('WebSocket stream connected');

      // Send handshake (include remoteCommands capability)
      this.ws?.send(
        JSON.stringify({
          type: 'handshake',
          instanceId: this.instanceId,
          apiKey: this.config.apiKey,
          remoteCommands: this.config.remoteCommands,
        })
      );
    };

    // Handle incoming messages (commands from dashboard)
    this.ws.onmessage = (event) => {
      if (!this.onCommand || !this.config.remoteCommands) return;

      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (msg.type === 'command' && msg.action && msg.id) {
          this.onCommand(msg as unknown as CloudCommand);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
      this.connected = false;
    };
  }

  /** Send an event if connected. Drops silently if disconnected (events are best-effort). */
  send(event: CloudEvent): void {
    this.sendRaw(event);
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

  /** Graceful shutdown */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
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
