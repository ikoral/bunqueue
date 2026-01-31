/**
 * TCP Server
 * Handles TCP connections with msgpack binary protocol
 */

import type { Socket, TCPSocketListener } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import type { Response } from '../../domain/types/response';
import type { Command } from '../../domain/types/command';
import { handleCommand, type HandlerContext } from './handler';
import { FrameParser, createConnectionState, type ConnectionState } from './protocol';
import { uuid } from '../../shared/hash';
import { tcpLog } from '../../shared/logger';
import { getRateLimiter } from './rateLimiter';
import { pack, unpack } from 'msgpackr';

/** TCP Server configuration */
export interface TcpServerConfig {
  /** TCP port */
  port?: number;
  /** Hostname to bind */
  hostname?: string;
  /** Auth tokens for authentication */
  authTokens?: string[];
}

/** Per-connection data */
interface ConnectionData {
  state: ConnectionState;
  frameParser: FrameParser;
  ctx: HandlerContext;
}

/** Serialize response to framed msgpack */
function serializeResponse(response: Response): Uint8Array {
  return FrameParser.frame(pack(response));
}

/** Error response as framed msgpack */
function errorResponse(message: string, reqId?: string): Uint8Array {
  return FrameParser.frame(pack({ ok: false, error: message, reqId }));
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
        frameParser: new FrameParser(),
        ctx,
      };

      connections.set(clientId, socket);
      tcpLog.info('Client connected', { clientId });
    },

    async data(socket: Socket<ConnectionData>, data: Buffer) {
      const { frameParser, ctx, state } = socket.data;
      const rateLimiter = getRateLimiter();

      // Check rate limit
      if (!rateLimiter.isAllowed(state.clientId)) {
        socket.write(errorResponse('Rate limit exceeded'));
        return;
      }

      const frames = frameParser.addData(new Uint8Array(data));

      for (const frame of frames) {
        let cmd: Command;
        try {
          cmd = unpack(frame) as Command;
        } catch {
          socket.write(errorResponse('Invalid command format'));
          continue;
        }

        if (!cmd?.cmd) {
          socket.write(errorResponse('Invalid command'));
          continue;
        }

        try {
          const response = await handleCommand(cmd, ctx);
          socket.write(serializeResponse(response));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          socket.write(errorResponse(message, cmd.reqId));
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

  // Create TCP server
  const server: TCPSocketListener<ConnectionData> = Bun.listen<ConnectionData>({
    hostname: config.hostname ?? '0.0.0.0',
    port: config.port ?? 6789,
    socket: socketHandlers,
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
    broadcast(message: unknown): void {
      const frame = FrameParser.frame(pack(message));
      for (const socket of connections.values()) {
        socket.write(frame);
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
