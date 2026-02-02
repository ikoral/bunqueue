/**
 * Server Command Handler
 * Starts the bunQ server
 */

import { parseArgs } from 'node:util';
import { printServerHelp } from '../help';
import { VERSION } from '../../shared/version';

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
    tcpPort: parseInt((values['tcp-port'] as string) ?? Bun.env.TCP_PORT ?? '6789', 10),
    httpPort: parseInt((values['http-port'] as string) ?? Bun.env.HTTP_PORT ?? '6790', 10),
    host: (values.host as string) ?? Bun.env.HOST ?? '0.0.0.0',
    dataPath: (values['data-path'] as string) ?? Bun.env.DATA_PATH,
    authTokens:
      (values['auth-tokens'] as string)?.split(',').filter(Boolean) ??
      Bun.env.AUTH_TOKENS?.split(',').filter(Boolean) ??
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
  Bun.env.TCP_PORT = String(options.tcpPort);
  Bun.env.HTTP_PORT = String(options.httpPort);
  Bun.env.HOST = options.host;
  if (options.dataPath) {
    Bun.env.DATA_PATH = options.dataPath;
  }
  if (options.authTokens.length > 0) {
    Bun.env.AUTH_TOKENS = options.authTokens.join(',');
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

  // Start TCP and HTTP servers
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

  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const magenta = '\x1b[35m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';

  // Format endpoint display
  const tcpDisplay = `${bold}${options.host}:${options.tcpPort}${reset}`;
  const httpDisplay = `${bold}${options.host}:${options.httpPort}${reset}`;

  console.log(`
${magenta}        (\\(\\        ${reset}
${magenta}        ( -.-)      ${bold}bunqueue${reset} ${dim}v${VERSION}${reset}
${magenta}        o_(")(")    ${reset}${dim}High-performance job queue for Bun${reset}

${dim}─────────────────────────────────────────────────${reset}

  ${green}●${reset} TCP    ${tcpDisplay}
  ${green}●${reset} HTTP   ${httpDisplay}
  ${yellow}●${reset} Data   ${options.dataPath ?? 'in-memory'}
  ${yellow}●${reset} Auth   ${authTokens ? `${green}enabled${reset}` : `${dim}disabled${reset}`}

${dim}─────────────────────────────────────────────────${reset}

  ${dim}Press ${bold}Ctrl+C${reset}${dim} to stop${reset}
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
