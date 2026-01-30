/**
 * TCP Reconnection Manager
 * Handles automatic reconnection with exponential backoff
 */

import { EventEmitter } from 'events';

/** Reconnection configuration */
export interface ReconnectConfig {
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  autoReconnect: boolean;
}

/**
 * Manages reconnection attempts with exponential backoff
 */
export class ReconnectManager extends EventEmitter {
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly config: ReconnectConfig) {
    super();
  }

  /** Mark as closed (prevents further reconnects) */
  setClosed(closed: boolean): void {
    this.closed = closed;
    if (closed) {
      this.cancelReconnect();
    }
  }

  /** Check if closed */
  isClosed(): boolean {
    return this.closed;
  }

  /** Reset reconnect attempts (call on successful connect) */
  reset(): void {
    this.reconnectAttempts = 0;
  }

  /** Cancel pending reconnection */
  cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Check if reconnection is allowed */
  canReconnect(): boolean {
    return this.config.autoReconnect && !this.closed;
  }

  /**
   * Schedule reconnection with exponential backoff
   * Returns false if max attempts reached
   */
  scheduleReconnect(connectFn: () => Promise<void>): boolean {
    if (this.reconnectTimer || this.closed) return false;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      this.emit('maxReconnectAttemptsReached');
      return false;
    }

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelay
    );
    const jitter = Math.random() * 0.3 * baseDelay;
    const delay = baseDelay + jitter;

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      connectFn().catch(() => {
        // connect() will schedule another reconnect if needed
      });
    }, delay);

    return true;
  }
}
