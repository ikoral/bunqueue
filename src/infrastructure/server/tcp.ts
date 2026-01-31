/**
 * TCP Server
 * Handles TCP connections with JSON line protocol
 */

import type { Socket, TCPSocketListener, UnixSocketListener } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import type { Response } from '../../domain/types/response';
import { handleCommand, type HandlerContext } from './handler';
import { LineBuffer, parseCommand, createConnectionState, type ConnectionState } from './protocol';
import { uuid } from '../../shared/hash';
import { tcpLog } from '../../shared/logger';
import { getRateLimiter } from './rateLimiter';

/** TCP Server configuration */
export interface TcpServerConfig {
  /** TCP port (ignored if socketPath is set) */
  port?: number;
  /** Hostname to bind (ignored if socketPath is set) */
  hostname?: string;
  /** Unix socket path (takes priority over port/hostname) */
  socketPath?: string;
  /** Auth tokens for authentication */
  authTokens?: string[];
}

/** Per-connection data */
interface ConnectionData {
  state: ConnectionState;
  buffer: LineBuffer;
  ctx: HandlerContext;
}

/** Reusable TextDecoder - avoid allocation per message */
const textDecoder = new TextDecoder();

/** Pre-allocated newline buffer for efficient writes */
const NEWLINE = '\n';

/** Serialize response with newline - avoids string concat per message */
function serializeResponseLine(response: Response): string {
  return JSON.stringify(response) + NEWLINE;
}

/** Error response with newline */
function errorResponseLine(message: string, reqId?: string): string {
  return JSON.stringify({ ok: false, error: message, reqId }) + NEWLINE;
}

/**
 * Create and start TCP server
 */
export function createTcpServer(queueManager: QueueManager, config: TcpServerConfig) {
  const authTokens = new Set(config.authTokens ?? []);
  const connections = new Map<string, Socket<ConnectionData>>();

  const socketHandlers = {
    open(socket: Socket<ConnectionData>) {
      const clientId = uuid();
      const state = createConnectionState(clientId);
      const ctx: HandlerContext = {
        queueManager,
        authTokens,
        authenticated: authTokens.size === 0, // Auto-auth if no tokens
        clientId, // For job ownership tracking
      };

      socket.data = {
        state,
        buffer: new LineBuffer(),
        ctx,
      };

      connections.set(clientId, socket);
      tcpLog.info('Client connected', { clientId });
    },

    async data(socket: Socket<ConnectionData>, data: Buffer) {
      const { buffer, ctx, state } = socket.data;
      const rateLimiter = getRateLimiter();

      // Check rate limit
      if (!rateLimiter.isAllowed(state.clientId)) {
        socket.write(errorResponseLine('Rate limit exceeded'));
        return;
      }

      const text = textDecoder.decode(data);
      const lines = buffer.addData(text);

      for (const line of lines) {
        const cmd = parseCommand(line);
        if (!cmd) {
          socket.write(errorResponseLine('Invalid command'));
          continue;
        }
        try {
          const response = await handleCommand(cmd, ctx);
          socket.write(serializeResponseLine(response));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          socket.write(errorResponseLine(message, cmd.reqId));
        }
      }
    },

    close(socket: Socket<ConnectionData>) {
      const clientId = socket.data.state.clientId;
      connections.delete(clientId);
      getRateLimiter().removeClient(clientId);

      // Release all jobs owned by this client back to queue (async with proper locking)
      queueManager
        .releaseClientJobs(clientId)
        .then((released) => {
          if (released > 0) {
            tcpLog.info('Client disconnected, released jobs', { clientId, released });
          } else {
            tcpLog.info('Client disconnected', { clientId });
          }
        })
        .catch((err: unknown) => {
          tcpLog.error('Failed to release client jobs', { clientId, error: String(err) });
        });
    },

    error(_socket: Socket<ConnectionData>, error: Error) {
      tcpLog.error('Connection error', { error: error.message });
    },

    drain(_socket: Socket<ConnectionData>) {
      // Called when socket is ready for more writes after backpressure
    },
  };

  // Create server - Unix socket or TCP based on config
  let server: TCPSocketListener<ConnectionData> | UnixSocketListener<ConnectionData>;

  if (config.socketPath) {
    server = Bun.listen<ConnectionData>({
      unix: config.socketPath,
      socket: socketHandlers,
    });
    tcpLog.info('Server listening', { unix: config.socketPath });
  } else {
    server = Bun.listen<ConnectionData>({
      hostname: config.hostname ?? '0.0.0.0',
      port: config.port ?? 6789,
      socket: socketHandlers,
    });
    tcpLog.info('Server listening', { host: config.hostname ?? '0.0.0.0', port: config.port });
  }

  return {
    server,
    connections,

    /** Get connection count */
    getConnectionCount(): number {
      return connections.size;
    },

    /** Broadcast to all connections */
    broadcast(message: string): void {
      const messageWithNewline = message + NEWLINE;
      for (const socket of connections.values()) {
        socket.write(messageWithNewline);
      }
    },

    /** Stop the server */
    stop(): void {
      server.stop();
      for (const socket of connections.values()) {
        socket.end();
      }
      connections.clear();
      tcpLog.info('Server stopped');
    },
  };
}

export type TcpServer = ReturnType<typeof createTcpServer>;
