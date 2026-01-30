/**
 * TCP Client
 * Production-ready TCP client with auto-reconnection
 */

import { EventEmitter } from 'events';
import type { ConnectionOptions, ConnectionHealth, SocketWrapper } from './types';
import { DEFAULT_CONNECTION } from './types';
import { HealthTracker } from './health';
import { ReconnectManager } from './reconnect';
import { createConnection, CommandQueue } from './connection';

/**
 * TCP Client - manages connection to bunqueue server
 */
export class TcpClient extends EventEmitter {
  private socket: SocketWrapper | null = null;
  private connected = false;
  private connecting = false;
  private readonly options: Required<ConnectionOptions>;
  private readonly health: HealthTracker;
  private readonly reconnect: ReconnectManager;
  private readonly commands: CommandQueue;

  constructor(options: Partial<ConnectionOptions> = {}) {
    super();
    this.options = { ...DEFAULT_CONNECTION, ...options };
    this.commands = new CommandQueue();
    this.health = new HealthTracker({
      pingInterval: this.options.pingInterval,
      maxPingFailures: this.options.maxPingFailures,
    });
    this.reconnect = new ReconnectManager({
      maxReconnectAttempts: this.options.maxReconnectAttempts,
      reconnectDelay: this.options.reconnectDelay,
      maxReconnectDelay: this.options.maxReconnectDelay,
      autoReconnect: this.options.autoReconnect,
    });

    this.reconnect.on('reconnecting', (data) => this.emit('reconnecting', data));
    this.reconnect.on('maxReconnectAttemptsReached', () => {
      this.emit('maxReconnectAttemptsReached');
      this.commands.rejectAll(new Error('Max reconnection attempts reached'));
    });
  }

  /** Connect to server */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      return this.waitForConnection();
    }

    this.connecting = true;
    this.reconnect.setClosed(false);

    try {
      await this.doConnect();
      this.reconnect.reset();
      this.emit('connected');
      this.health.startPing(async () => {
        await this.ping();
      });
      this.processNextCommand();
    } catch (err) {
      this.connecting = false;
      if (this.reconnect.canReconnect()) {
        this.reconnect.scheduleReconnect(() => this.connect());
      }
      throw err;
    }
  }

  private waitForConnection(): Promise<void> {
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

  private async doConnect(): Promise<void> {
    const { socket } = await createConnection(
      this.options.host,
      this.options.port,
      this.options.connectTimeout,
      {
        onData: (line) => {
          this.handleData(line);
        },
        onClose: () => {
          this.handleClose();
        },
        onError: (error) => this.emit('error', error),
      }
    );

    this.socket = socket;
    this.connected = true;
    this.connecting = false;
    this.health.recordConnected();

    if (this.options.token) {
      await this.authenticate();
    }
  }

  private async authenticate(): Promise<void> {
    const response = await this.sendInternal({ cmd: 'Auth', token: this.options.token });
    if (!response.ok) {
      throw new Error('Authentication failed');
    }
  }

  private handleData(line: string): void {
    const current = this.commands.getCurrentCommand();
    if (!current) return;

    try {
      const response = JSON.parse(line) as Record<string, unknown>;
      clearTimeout(current.timeout);
      current.resolve(response);
      this.commands.setCurrentCommand(null);
      this.processNextCommand();
    } catch {
      clearTimeout(current.timeout);
      current.reject(new Error('Invalid response from server'));
      this.commands.setCurrentCommand(null);
      this.processNextCommand();
    }
  }

  private handleClose(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = false;
    this.socket = null;
    this.health.stopPing();
    this.commands.clearCurrent();

    if (wasConnected) {
      this.emit('disconnected');
      if (this.reconnect.canReconnect()) {
        this.reconnect.scheduleReconnect(() => this.connect());
      }
    }
  }

  /** Send ping to check connection health */
  async ping(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const start = Date.now();
      const response = await this.send({ cmd: 'Ping' });
      const success = response.pong === true;

      if (success) {
        this.health.recordPingSuccess(Date.now() - start);
        this.emit('health', { type: 'ping_success', latency: Date.now() - start });
      } else {
        this.handlePingFailure();
      }
      return success;
    } catch {
      this.handlePingFailure();
      return false;
    }
  }

  private handlePingFailure(): void {
    if (this.health.recordPingFailure()) {
      this.emit('health', { type: 'unhealthy', reason: 'max_ping_failures' });
      this.forceReconnect();
    } else {
      this.emit('health', { type: 'ping_failed' });
    }
  }

  private forceReconnect(): void {
    if (this.reconnect.isClosed()) return;
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
    this.health.stopPing();
    if (this.reconnect.canReconnect()) this.reconnect.scheduleReconnect(() => this.connect());
  }

  /** Get connection health metrics */
  getHealth(): ConnectionHealth {
    return this.health.getHealth(this.getState());
  }

  private async sendInternal(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket) throw new Error('Not connected');

    const startTime = Date.now();
    this.health.recordCommandSent();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const current = this.commands.getCurrentCommand();
        if (current?.command === command) {
          this.commands.setCurrentCommand(null);
          this.health.recordError();
          reject(new Error('Command timeout'));
          this.processNextCommand();
        }
      }, this.options.commandTimeout);

      this.commands.setCurrentCommand({
        id: 0,
        command,
        resolve: (result) => {
          this.health.recordSuccess(Date.now() - startTime);
          resolve(result);
        },
        reject: (err) => {
          this.health.recordError();
          reject(err);
        },
        timeout,
      });

      this.socket?.write(JSON.stringify(command) + '\n');
    });
  }

  private processNextCommand(): void {
    if (this.commands.getCurrentCommand() || !this.connected) return;

    const next = this.commands.dequeue();
    if (!next || !this.socket) return;

    this.commands.setCurrentCommand(next);
    this.socket.write(JSON.stringify(next.command) + '\n');
  }

  /** Send command and wait for response */
  async send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.connected && !this.commands.hasPending() && !this.commands.getCurrentCommand()) {
      return this.sendInternal(command);
    }

    const startTime = Date.now();
    this.health.recordCommandSent();

    return new Promise((resolve, reject) => {
      const id = this.commands.nextId();

      const timeout = setTimeout(() => {
        if (this.commands.remove(id)) {
          this.health.recordError();
          reject(new Error('Command timeout'));
        }
      }, this.options.commandTimeout);

      this.commands.enqueue({
        id,
        command,
        resolve: (result) => {
          this.health.recordSuccess(Date.now() - startTime);
          resolve(result);
        },
        reject: (err) => {
          this.health.recordError();
          reject(err);
        },
        timeout,
      });

      if (!this.connected && !this.connecting) {
        this.connect().catch(() => {});
      } else if (this.connected) {
        this.processNextCommand();
      }
    });
  }

  /** Close connection */
  close(): void {
    this.reconnect.setClosed(true);
    this.health.stopPing();
    this.reconnect.cancelReconnect();
    this.commands.rejectAll(new Error('Client closed'));
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
    if (this.reconnect.isClosed()) return 'closed';
    if (this.connected) return 'connected';
    if (this.connecting) return 'connecting';
    return 'disconnected';
  }
}
