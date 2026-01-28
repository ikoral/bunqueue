/**
 * TCP Server
 * Handles TCP connections with JSON line protocol
 */

import type { Socket } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import { handleCommand, type HandlerContext } from './handler';
import {
  LineBuffer,
  parseCommand,
  serializeResponse,
  errorResponse,
  createConnectionState,
  type ConnectionState,
} from './protocol';
import { uuid } from '../../shared/hash';
import { tcpLog } from '../../shared/logger';
import { getRateLimiter } from './rateLimiter';

/** TCP Server configuration */
export interface TcpServerConfig {
  port: number;
  hostname?: string;
  authTokens?: string[];
}

/** Per-connection data */
interface ConnectionData {
  state: ConnectionState;
  buffer: LineBuffer;
  ctx: HandlerContext;
}

/**
 * Create and start TCP server
 */
export function createTcpServer(queueManager: QueueManager, config: TcpServerConfig) {
  const authTokens = new Set(config.authTokens ?? []);
  const connections = new Map<string, Socket<ConnectionData>>();

  const server = Bun.listen<ConnectionData>({
    hostname: config.hostname ?? '0.0.0.0',
    port: config.port,

    socket: {
      open(socket) {
        const clientId = uuid();
        const state = createConnectionState(clientId);
        const ctx: HandlerContext = {
          queueManager,
          authTokens,
          authenticated: authTokens.size === 0, // Auto-auth if no tokens
        };

        socket.data = {
          state,
          buffer: new LineBuffer(),
          ctx,
        };

        connections.set(clientId, socket);
        tcpLog.info('Client connected', { clientId });
      },

      async data(socket, data) {
        const { buffer, ctx, state } = socket.data;
        const rateLimiter = getRateLimiter();

        // Check rate limit
        if (!rateLimiter.isAllowed(state.clientId)) {
          socket.write(errorResponse('Rate limit exceeded') + '\n');
          return;
        }

        const text = new TextDecoder().decode(data);
        const lines = buffer.addData(text);

        for (const line of lines) {
          const cmd = parseCommand(line);
          if (!cmd) {
            socket.write(errorResponse('Invalid command') + '\n');
            continue;
          }
          try {
            const response = await handleCommand(cmd, ctx);
            socket.write(serializeResponse(response) + '\n');
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            socket.write(errorResponse(message, cmd.reqId) + '\n');
          }
        }
      },

      close(socket) {
        const clientId = socket.data.state.clientId;
        connections.delete(clientId);
        getRateLimiter().removeClient(clientId);
        tcpLog.info('Client disconnected', { clientId });
      },

      error(_socket, error) {
        tcpLog.error('Connection error', { error: error.message });
      },

      drain(_socket) {
        // Called when socket is ready for more writes after backpressure
      },
    },
  });

  tcpLog.info('Server listening', { host: config.hostname ?? '0.0.0.0', port: config.port });

  return {
    server,
    connections,

    /** Get connection count */
    getConnectionCount(): number {
      return connections.size;
    },

    /** Broadcast to all connections */
    broadcast(message: string): void {
      for (const socket of connections.values()) {
        socket.write(message + '\n');
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
