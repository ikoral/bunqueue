/**
 * TCP Client for SDK - Production Ready
 * Connects to bunqueue server via TCP with auto-reconnection
 */

import { EventEmitter } from 'events';

/** Connection options */
export interface ConnectionOptions {
  host: string;
  port: number;
  token?: string;
  /** Max reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 100) */
  reconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Connection timeout in ms (default: 5000) */
  connectTimeout?: number;
  /** Command timeout in ms (default: 30000) */
  commandTimeout?: number;
  /** Enable auto-reconnect (default: true) */
  autoReconnect?: boolean;
}

/** Default connection */
export const DEFAULT_CONNECTION: Required<ConnectionOptions> = {
  host: 'localhost',
  port: 6789,
  token: '',
  maxReconnectAttempts: Infinity,
  reconnectDelay: 100,
  maxReconnectDelay: 30000,
  connectTimeout: 5000,
  commandTimeout: 30000,
  autoReconnect: true,
};

/** Pending command */
interface PendingCommand {
  command: Record<string, unknown>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Socket wrapper */
interface SocketWrapper {
  write: (data: string) => void;
  end: () => void;
  buffer: string;
}

/**
 * TCP Client - manages connection to bunqueue server
 * Production-ready with auto-reconnection and exponential backoff
 */
export class TcpClient extends EventEmitter {
  private socket: SocketWrapper | null = null;
  private connected = false;
  private connecting = false;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: Required<ConnectionOptions>;
  private pendingCommands: PendingCommand[] = [];
  private currentCommand: PendingCommand | null = null;

  constructor(options: Partial<ConnectionOptions> = {}) {
    super();
    this.options = { ...DEFAULT_CONNECTION, ...options };
  }

  /** Connect to server */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      // Wait for current connection attempt
      return new Promise((resolve, reject) => {
        const onConnect = () => {
          this.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          this.off('connected', onConnect);
          reject(err);
        };
        this.once('connected', onConnect);
        this.once('error', onError);
      });
    }

    this.connecting = true;
    this.closed = false;

    try {
      await this.doConnect();
      this.reconnectAttempts = 0;
      this.emit('connected');
      // Process any pending commands
      this.processNextCommand();
    } catch (err) {
      this.connecting = false;
      if (this.options.autoReconnect && !this.closed) {
        this.scheduleReconnect();
      }
      throw err;
    }
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketData: SocketWrapper = {
        write: () => {},
        end: () => {},
        buffer: '',
      };

      let connectionResolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      void Bun.connect({
        hostname: this.options.host,
        port: this.options.port,
        socket: {
          data: (_sock, data) => {
            socketData.buffer += data.toString();

            let newlineIdx: number;
            while ((newlineIdx = socketData.buffer.indexOf('\n')) !== -1) {
              const line = socketData.buffer.slice(0, newlineIdx);
              socketData.buffer = socketData.buffer.slice(newlineIdx + 1);

              if (line.trim() && this.currentCommand) {
                try {
                  const response = JSON.parse(line) as Record<string, unknown>;
                  clearTimeout(this.currentCommand.timeout);
                  this.currentCommand.resolve(response);
                  this.currentCommand = null;
                  this.processNextCommand();
                } catch {
                  if (this.currentCommand) {
                    clearTimeout(this.currentCommand.timeout);
                    this.currentCommand.reject(new Error('Invalid response from server'));
                    this.currentCommand = null;
                    this.processNextCommand();
                  }
                }
              }
            }
          },
          open: async (sock) => {
            cleanup();
            socketData.write = (data: string) => sock.write(data);
            socketData.end = () => sock.end();
            this.socket = socketData;
            this.connected = true;
            this.connecting = false;

            // Authenticate if token provided
            if (this.options.token) {
              try {
                const authResponse = await this.sendInternal({
                  cmd: 'Auth',
                  token: this.options.token,
                });
                if (!authResponse.ok) {
                  connectionResolved = true;
                  reject(new Error('Authentication failed'));
                  return;
                }
              } catch (err) {
                connectionResolved = true;
                reject(err);
                return;
              }
            }

            connectionResolved = true;
            resolve();
          },
          close: () => {
            const wasConnected = this.connected;
            this.connected = false;
            this.connecting = false;
            this.socket = null;

            // Reject current command
            if (this.currentCommand) {
              clearTimeout(this.currentCommand.timeout);
              this.currentCommand.reject(new Error('Connection closed'));
              this.currentCommand = null;
            }

            if (wasConnected) {
              this.emit('disconnected');
              if (this.options.autoReconnect && !this.closed) {
                this.scheduleReconnect();
              }
            }

            if (!connectionResolved) {
              connectionResolved = true;
              cleanup();
              reject(new Error('Connection closed'));
            }
          },
          error: (_sock, error) => {
            if (!connectionResolved) {
              connectionResolved = true;
              cleanup();
              reject(new Error(`Connection error: ${error.message}`));
            }
            this.emit('error', error);
          },
          connectError: (_sock, error) => {
            if (!connectionResolved) {
              connectionResolved = true;
              cleanup();
              reject(
                new Error(
                  `Failed to connect to ${this.options.host}:${this.options.port}: ${error.message}`
                )
              );
            }
          },
        },
      });

      // Connection timeout
      timeoutId = setTimeout(() => {
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error(`Connection timeout to ${this.options.host}:${this.options.port}`));
        }
      }, this.options.connectTimeout);
    });
  }

  /** Schedule reconnection with exponential backoff */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.options.maxReconnectAttempts) {
      this.emit('maxReconnectAttemptsReached');
      // Reject all pending commands
      for (const cmd of this.pendingCommands) {
        clearTimeout(cmd.timeout);
        cmd.reject(new Error('Max reconnection attempts reached'));
      }
      this.pendingCommands = [];
      return;
    }

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.options.maxReconnectDelay
    );
    const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
    const delay = baseDelay + jitter;

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        // Process queued commands after reconnection
        this.processNextCommand();
      } catch {
        // connect() will schedule another reconnect if needed
      }
    }, delay);
  }

  /** Internal send without auto-connect */
  private async sendInternal(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.currentCommand?.command === command) {
          this.currentCommand = null;
          reject(new Error('Command timeout'));
          this.processNextCommand();
        }
      }, this.options.commandTimeout);

      this.currentCommand = { command, resolve, reject, timeout };
      this.socket!.write(JSON.stringify(command) + '\n');
    });
  }

  /** Process next pending command */
  private processNextCommand(): void {
    if (this.currentCommand || !this.connected || this.pendingCommands.length === 0) {
      return;
    }

    const next = this.pendingCommands.shift()!;
    this.currentCommand = next;
    this.socket!.write(JSON.stringify(next.command) + '\n');
  }

  /** Send command and wait for response */
  async send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    // If connected and no pending commands, send immediately
    if (this.connected && this.pendingCommands.length === 0 && !this.currentCommand) {
      return this.sendInternal(command);
    }

    // Otherwise queue the command
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.pendingCommands.findIndex((c) => c.command === command);
        if (idx !== -1) {
          this.pendingCommands.splice(idx, 1);
          reject(new Error('Command timeout'));
        }
      }, this.options.commandTimeout);

      this.pendingCommands.push({ command, resolve, reject, timeout });

      // Try to connect if not connected
      if (!this.connected && !this.connecting) {
        this.connect().catch(() => {
          // Error handled by reconnect logic
        });
      } else if (this.connected) {
        this.processNextCommand();
      }
    });
  }

  /** Close connection */
  close(): void {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending commands
    for (const cmd of this.pendingCommands) {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Client closed'));
    }
    this.pendingCommands = [];

    if (this.currentCommand) {
      clearTimeout(this.currentCommand.timeout);
      this.currentCommand.reject(new Error('Client closed'));
      this.currentCommand = null;
    }

    if (this.socket) {
      this.socket.end();
      this.socket = null;
      this.connected = false;
    }
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get connection state */
  getState(): 'connected' | 'connecting' | 'disconnected' | 'closed' {
    if (this.closed) return 'closed';
    if (this.connected) return 'connected';
    if (this.connecting) return 'connecting';
    return 'disconnected';
  }
}

/** Shared client instance */
let sharedClient: TcpClient | null = null;

/** Get shared TCP client */
export function getSharedTcpClient(options?: Partial<ConnectionOptions>): TcpClient {
  if (!sharedClient) {
    sharedClient = new TcpClient(options);
  }
  return sharedClient;
}

/** Close shared client */
export function closeSharedTcpClient(): void {
  if (sharedClient) {
    sharedClient.close();
    sharedClient = null;
  }
}
