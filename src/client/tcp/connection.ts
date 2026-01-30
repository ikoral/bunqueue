/**
 * TCP Connection Handler
 * Manages low-level socket connection and data handling
 */

import type { SocketWrapper, PendingCommand } from './types';
import { LineBuffer } from './lineBuffer';

/** Connection events */
export interface ConnectionEvents {
  onData: (line: string) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

/** Connection result */
export interface ConnectionResult {
  socket: SocketWrapper;
  cleanup: () => void;
}

/**
 * Establish TCP connection to server
 */
export async function createConnection(
  host: string,
  port: number,
  connectTimeout: number,
  events: ConnectionEvents
): Promise<ConnectionResult> {
  return new Promise((resolve, reject) => {
    const socketData: SocketWrapper = {
      write: () => {},
      end: () => {},
      lineBuffer: new LineBuffer(),
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
      hostname: host,
      port: port,
      socket: {
        data: (_sock, data) => {
          const lines = socketData.lineBuffer.addData(data.toString());
          for (const line of lines) {
            events.onData(line);
          }
        },
        open: (sock) => {
          cleanup();
          socketData.write = (d: string) => sock.write(d);
          socketData.end = () => sock.end();
          connectionResolved = true;
          resolve({ socket: socketData, cleanup });
        },
        close: () => {
          if (!connectionResolved) {
            connectionResolved = true;
            cleanup();
            reject(new Error('Connection closed'));
          }
          events.onClose();
        },
        error: (_sock, error) => {
          if (!connectionResolved) {
            connectionResolved = true;
            cleanup();
            reject(new Error(`Connection error: ${error.message}`));
          }
          events.onError(error);
        },
        connectError: (_sock, error) => {
          if (!connectionResolved) {
            connectionResolved = true;
            cleanup();
            reject(new Error(`Failed to connect to ${host}:${port}: ${error.message}`));
          }
        },
      },
    });

    timeoutId = setTimeout(() => {
      if (!connectionResolved) {
        connectionResolved = true;
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }
    }, connectTimeout);
  });
}

/**
 * Command queue for managing pending commands
 */
export class CommandQueue {
  private readonly pendingCommands: Map<number, PendingCommand> = new Map();
  private pendingQueue: number[] = [];
  private currentCommand: PendingCommand | null = null;
  private commandIdCounter = 0;

  /** Get current command being processed */
  getCurrentCommand(): PendingCommand | null {
    return this.currentCommand;
  }

  /** Set current command */
  setCurrentCommand(cmd: PendingCommand | null): void {
    this.currentCommand = cmd;
  }

  /** Check if has pending commands */
  hasPending(): boolean {
    return this.pendingCommands.size > 0;
  }

  /** Add command to queue */
  enqueue(command: PendingCommand): void {
    this.pendingCommands.set(command.id, command);
    this.pendingQueue.push(command.id);
  }

  /** Get next command ID */
  nextId(): number {
    return ++this.commandIdCounter;
  }

  /** Dequeue next command */
  dequeue(): PendingCommand | null {
    const nextId = this.pendingQueue.shift();
    if (nextId === undefined) return null;

    const next = this.pendingCommands.get(nextId);
    if (!next) return null;

    this.pendingCommands.delete(nextId);
    return next;
  }

  /** Remove command by ID */
  remove(id: number): boolean {
    if (!this.pendingCommands.has(id)) return false;

    this.pendingCommands.delete(id);
    const queueIdx = this.pendingQueue.indexOf(id);
    if (queueIdx !== -1) {
      this.pendingQueue.splice(queueIdx, 1);
    }
    return true;
  }

  /** Reject all pending commands */
  rejectAll(error: Error): void {
    for (const cmd of this.pendingCommands.values()) {
      clearTimeout(cmd.timeout);
      cmd.reject(error);
    }
    this.pendingCommands.clear();
    this.pendingQueue = [];

    if (this.currentCommand) {
      clearTimeout(this.currentCommand.timeout);
      this.currentCommand.reject(error);
      this.currentCommand = null;
    }
  }

  /** Clear current command */
  clearCurrent(): void {
    if (this.currentCommand) {
      clearTimeout(this.currentCommand.timeout);
      this.currentCommand = null;
    }
  }
}
