/**
 * Server Command Handler
 * Starts the bunQ server
 */

import { parseArgs } from 'node:util';
import { printServerHelp } from '../help';

/** Server start options */
interface ServerOptions {
  tcpPort: number;
  httpPort: number;
  host: string;
  dataPath?: string;
  authTokens: string[];
}

/** Parse server arguments */
function parseServerArgs(args: string[]): ServerOptions {
  const { values } = parseArgs({
    args,
    options: {
      'tcp-port': { type: 'string' },
      'http-port': { type: 'string' },
      host: { type: 'string' },
      'data-path': { type: 'string' },
      'auth-tokens': { type: 'string' },
    },
    allowPositionals: false,
    strict: false,
  });

  return {
    tcpPort: parseInt((values['tcp-port'] as string) ?? process.env.TCP_PORT ?? '6789', 10),
    httpPort: parseInt((values['http-port'] as string) ?? process.env.HTTP_PORT ?? '6790', 10),
    host: (values.host as string) ?? process.env.HOST ?? '0.0.0.0',
    dataPath: (values['data-path'] as string) ?? process.env.DATA_PATH,
    authTokens:
      (values['auth-tokens'] as string)?.split(',').filter(Boolean) ??
      process.env.AUTH_TOKENS?.split(',').filter(Boolean) ??
      [],
  };
}

/** Run the server */
export async function runServer(args: string[], showHelp: boolean): Promise<void> {
  if (showHelp) {
    printServerHelp();
    process.exit(0);
  }

  const options = parseServerArgs(args);

  // Set environment variables for the server
  process.env.TCP_PORT = String(options.tcpPort);
  process.env.HTTP_PORT = String(options.httpPort);
  process.env.HOST = options.host;
  if (options.dataPath) {
    process.env.DATA_PATH = options.dataPath;
  }
  if (options.authTokens.length > 0) {
    process.env.AUTH_TOKENS = options.authTokens.join(',');
  }

  // Import and start the server components
  const { QueueManager } = await import('../../application/queueManager');
  const { createTcpServer } = await import('../../infrastructure/server/tcp');
  const { createHttpServer } = await import('../../infrastructure/server/http');
  const { serverLog } = await import('../../shared/logger');

  // Initialize
  const qm = new QueueManager({
    dataPath: options.dataPath,
  });

  const authTokens = options.authTokens.length > 0 ? options.authTokens : undefined;

  // Start servers
  const tcpServer = createTcpServer(qm, {
    port: options.tcpPort,
    hostname: options.host,
    authTokens,
  });

  const httpServer = createHttpServer(qm, {
    port: options.httpPort,
    hostname: options.host,
    authTokens,
  });

  serverLog.info('bunqueue server started', {
    tcpPort: options.tcpPort,
    httpPort: options.httpPort,
    host: options.host,
    dataPath: options.dataPath ?? 'in-memory',
    auth: authTokens ? 'enabled' : 'disabled',
  });

  console.log(`
  bunqueue server running

  TCP:  ${options.host}:${options.tcpPort}
  HTTP: ${options.host}:${options.httpPort}
  Data: ${options.dataPath ?? 'in-memory'}
  Auth: ${authTokens ? 'enabled' : 'disabled'}

  Press Ctrl+C to stop
`);

  // Handle shutdown
  const shutdown = () => {
    serverLog.info('Shutting down...');
    tcpServer.stop();
    httpServer.stop();
    qm.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
