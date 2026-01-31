/**
 * CLI TCP Client
 * Connects to bunQ server and executes commands (msgpack binary protocol)
 */

import type { Socket } from 'bun';
import { formatOutput, formatError } from './output';
import { pack, unpack } from 'msgpackr';
import { FrameParser } from '../infrastructure/server/protocol';

/** Client options */
export interface ClientOptions {
  /** Server host */
  host: string;
  /** Server port */
  port: number;
  /** Auth token */
  token?: string;
  /** Output as JSON */
  json: boolean;
}

/** Socket data context */
interface SocketData {
  frameParser: FrameParser;
  resolve: ((value: Record<string, unknown>) => void) | null;
  reject: ((error: Error) => void) | null;
}

/** Send a command and wait for response */
async function sendCommand(
  socket: { write: (data: Uint8Array) => void; data: SocketData },
  command: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.data.resolve = resolve;
    socket.data.reject = reject;
    socket.write(FrameParser.frame(pack(command)));

    // Timeout after 30 seconds
    setTimeout(() => {
      if (socket.data.resolve === resolve) {
        socket.data.resolve = null;
        socket.data.reject = null;
        reject(new Error('Command timeout'));
      }
    }, 30000);
  });
}

/** Create TCP connection */
async function connect(options: ClientOptions): Promise<{
  socket: { write: (data: Uint8Array) => void; end: () => void; data: SocketData };
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socketData: SocketData = {
      frameParser: new FrameParser(),
      resolve: null,
      reject: null,
    };

    let connected = false;
    const targetDesc = `${options.host}:${options.port}`;

    // Socket handlers
    const socketHandlers = {
      data(_sock: Socket<unknown>, data: Buffer) {
        const frames = socketData.frameParser.addData(new Uint8Array(data));

        for (const frame of frames) {
          if (socketData.resolve) {
            try {
              const response = unpack(frame) as Record<string, unknown>;
              socketData.resolve(response);
              socketData.resolve = null;
              socketData.reject = null;
            } catch {
              if (socketData.reject) {
                socketData.reject(new Error('Invalid response from server'));
                socketData.resolve = null;
                socketData.reject = null;
              }
            }
          }
        }
      },
      open(sock: Socket<unknown>) {
        connected = true;
        resolve({
          socket: {
            write: (data: Uint8Array) => sock.write(data),
            end: () => sock.end(),
            data: socketData,
          },
          close: () => sock.end(),
        });
      },
      close() {
        if (socketData.reject) {
          socketData.reject(new Error('Connection closed'));
        }
      },
      error(_sock: Socket<unknown>, error: Error) {
        reject(new Error(`Connection error: ${error.message}`));
      },
      connectError(_sock: Socket<unknown>, error: Error) {
        reject(new Error(`Failed to connect to ${targetDesc}: ${error.message}`));
      },
    };

    // Connect via TCP
    void Bun.connect({
      hostname: options.host,
      port: options.port,
      socket: socketHandlers,
    });

    // Handle connection timeout
    setTimeout(() => {
      if (!connected) {
        reject(new Error(`Connection timeout to ${targetDesc}`));
      }
    }, 5000);
  });
}

/** Execute a CLI command against the server */
export async function executeCommand(
  command: string,
  args: string[],
  options: ClientOptions
): Promise<void> {
  let connection: Awaited<ReturnType<typeof connect>> | null = null;

  try {
    connection = await connect(options);

    // Authenticate if token provided
    if (options.token) {
      const authResponse = await sendCommand(connection.socket, {
        cmd: 'Auth',
        token: options.token,
      });
      if (!authResponse.ok) {
        console.error(formatError('Authentication failed', options.json));
        process.exit(1);
      }
    }

    // Build the command
    const cmd = await buildCommand(command, args);
    if (!cmd) {
      console.error(formatError(`Unknown command: ${command}`, options.json));
      process.exit(1);
    }

    // Execute command
    const response = await sendCommand(connection.socket, cmd);
    console.log(formatOutput(response, command, options.json));

    if (!response.ok) {
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(formatError(message, options.json));
    process.exit(1);
  } finally {
    connection?.close();
  }
}

/** Build a command from CLI arguments */
async function buildCommand(
  command: string,
  args: string[]
): Promise<Record<string, unknown> | null> {
  // Import command builders
  const { buildCoreCommand } = await import('./commands/core');
  const { buildJobCommand } = await import('./commands/job');
  const { buildQueueCommand } = await import('./commands/queue');
  const { buildDlqCommand } = await import('./commands/dlq');
  const { buildCronCommand } = await import('./commands/cron');
  const { buildWorkerCommand } = await import('./commands/worker');
  const { buildWebhookCommand } = await import('./commands/webhook');
  const { buildRateLimitCommand } = await import('./commands/rateLimit');
  const { buildMonitorCommand } = await import('./commands/monitor');

  switch (command) {
    case 'push':
    case 'pull':
    case 'ack':
    case 'fail':
      return buildCoreCommand(command, args);
    case 'job':
      return buildJobCommand(args);
    case 'queue':
      return buildQueueCommand(args);
    case 'dlq':
      return buildDlqCommand(args);
    case 'cron':
      return buildCronCommand(args);
    case 'worker':
      return buildWorkerCommand(args);
    case 'webhook':
      return buildWebhookCommand(args);
    case 'rate-limit':
    case 'concurrency':
      return buildRateLimitCommand(command, args);
    case 'stats':
    case 'metrics':
    case 'health':
      return buildMonitorCommand(command);
    default:
      return null;
  }
}
