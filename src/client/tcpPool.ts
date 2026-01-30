/**
 * TCP Connection Pool
 * Manages multiple TCP connections for parallel operations
 */

import { TcpClient, type ConnectionOptions } from './tcpClient';

export interface PoolOptions extends Partial<ConnectionOptions> {
  /** Number of connections in pool (default: 4) */
  poolSize?: number;
}

/**
 * Connection pool for parallel TCP operations
 * Round-robin distribution of commands across connections
 */
export class TcpConnectionPool {
  private readonly clients: TcpClient[] = [];
  private readonly options: Required<PoolOptions>;
  private currentIndex = 0;
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.options = {
      host: options.host ?? 'localhost',
      port: options.port ?? 6789,
      token: options.token ?? '',
      poolSize: options.poolSize ?? 4,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      reconnectDelay: options.reconnectDelay ?? 100,
      maxReconnectDelay: options.maxReconnectDelay ?? 30000,
      connectTimeout: options.connectTimeout ?? 5000,
      commandTimeout: options.commandTimeout ?? 30000,
      autoReconnect: options.autoReconnect ?? true,
    };

    // Create pool of connections
    for (let i = 0; i < this.options.poolSize; i++) {
      const client = new TcpClient({
        host: this.options.host,
        port: this.options.port,
        token: this.options.token,
        maxReconnectAttempts: this.options.maxReconnectAttempts,
        reconnectDelay: this.options.reconnectDelay,
        maxReconnectDelay: this.options.maxReconnectDelay,
        connectTimeout: this.options.connectTimeout,
        commandTimeout: this.options.commandTimeout,
        autoReconnect: this.options.autoReconnect,
      });
      this.clients.push(client);
    }
  }

  /** Connect all clients in pool */
  async connect(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.connect()));
  }

  /** Get next client (round-robin) */
  private getNextClient(): TcpClient {
    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }

  /** Send command using next available connection */
  async send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }
    return this.getNextClient().send(command);
  }

  /** Send multiple commands in parallel across pool */
  async sendParallel(commands: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }

    // Distribute commands across clients
    const promises = commands.map((cmd, i) => {
      const client = this.clients[i % this.clients.length];
      return client.send(cmd);
    });

    return Promise.all(promises);
  }

  /** Check if any connection is ready */
  isConnected(): boolean {
    return this.clients.some((c) => c.isConnected());
  }

  /** Get number of connected clients */
  getConnectedCount(): number {
    return this.clients.filter((c) => c.isConnected()).length;
  }

  /** Get pool size */
  getPoolSize(): number {
    return this.clients.length;
  }

  /** Close all connections */
  close(): void {
    this.closed = true;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.length = 0;
  }
}

/** Shared pool instance */
let sharedPool: TcpConnectionPool | null = null;

/** Get or create shared connection pool */
export function getSharedPool(options?: PoolOptions): TcpConnectionPool {
  if (!sharedPool) {
    sharedPool = new TcpConnectionPool(options);
  }
  return sharedPool;
}

/** Close shared pool */
export function closeSharedPool(): void {
  if (sharedPool) {
    sharedPool.close();
    sharedPool = null;
  }
}
