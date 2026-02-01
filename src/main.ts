#!/usr/bin/env bun
/**
 * bunqueue - High-performance job queue server for Bun
 * Main entry point - routes to CLI for client commands or starts server
 */

// Check for CLI client commands (not server mode)
const clientCommands = [
  'push',
  'pull',
  'ack',
  'fail',
  'job',
  'queue',
  'dlq',
  'cron',
  'worker',
  'webhook',
  'rate-limit',
  'concurrency',
  'stats',
  'metrics',
  'health',
  'backup',
];

const firstArg = process.argv[2];
const isClientCommand = firstArg && clientCommands.includes(firstArg);
const isStartCommand = firstArg === 'start';
const hasHelpOrVersion = process.argv.includes('--help') || process.argv.includes('--version');

// Route to CLI for client commands, help, or version
if (isClientCommand || hasHelpOrVersion || isStartCommand) {
  void import('./cli/index').then(({ main }) => main());
} else {
  // Direct server mode (no args or only server flags like --tcp-port)
  startServer();
}

import { QueueManager } from './application/queueManager';
import { createTcpServer } from './infrastructure/server/tcp';
import { createHttpServer } from './infrastructure/server/http';
import { Logger, serverLog, statsLog } from './shared/logger';
import { stopRateLimiter } from './infrastructure/server/rateLimiter';
import { VERSION } from './shared/version';
import { S3BackupManager } from './infrastructure/backup';
import { SHARD_COUNT } from './shared/hash';
import { cpus } from 'os';

/** Server configuration from environment */
interface ServerConfig {
  tcpPort: number;
  httpPort: number;
  hostname: string;
  /** Unix socket path for TCP (takes priority over port) */
  tcpSocketPath: string | undefined;
  /** Unix socket path for HTTP (takes priority over port) */
  httpSocketPath: string | undefined;
  authTokens: string[];
  dataPath: string | undefined;
  corsOrigins: string[];
  requireAuthForMetrics: boolean;
  s3BackupEnabled: boolean;
}

/** Configurable timeouts from environment */
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '30000', 10);
const STATS_INTERVAL_MS = parseInt(process.env.STATS_INTERVAL_MS ?? '30000', 10);

/** Load configuration from environment variables */
function loadConfig(): ServerConfig {
  return {
    tcpPort: parseInt(process.env.TCP_PORT ?? '6789'),
    httpPort: parseInt(process.env.HTTP_PORT ?? '6790'),
    hostname: process.env.HOST ?? '0.0.0.0',
    tcpSocketPath: process.env.TCP_SOCKET_PATH,
    httpSocketPath: process.env.HTTP_SOCKET_PATH,
    authTokens: process.env.AUTH_TOKENS?.split(',').filter(Boolean) ?? [],
    dataPath: process.env.DATA_PATH ?? process.env.SQLITE_PATH,
    corsOrigins: process.env.CORS_ALLOW_ORIGIN?.split(',').filter(Boolean) ?? ['*'],
    requireAuthForMetrics: process.env.METRICS_AUTH === 'true',
    s3BackupEnabled:
      process.env.S3_BACKUP_ENABLED === '1' || process.env.S3_BACKUP_ENABLED === 'true',
  };
}

/** Print startup banner */
function printBanner(config: ServerConfig): void {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const magenta = '\x1b[35m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';

  // Format TCP endpoint display
  const tcpDisplay = config.tcpSocketPath
    ? `${bold}${config.tcpSocketPath}${reset} ${dim}(unix)${reset}`
    : `${bold}${config.hostname}:${config.tcpPort}${reset}`;

  // Format HTTP endpoint display
  const httpDisplay = config.httpSocketPath
    ? `${bold}${config.httpSocketPath}${reset} ${dim}(unix)${reset}`
    : `${bold}${config.hostname}:${config.httpPort}${reset}`;

  // Socket mode display
  const hasUnixSockets = config.tcpSocketPath !== undefined || config.httpSocketPath !== undefined;
  const socketDisplay = hasUnixSockets
    ? `${green}enabled${reset} ${dim}(${config.tcpSocketPath ? 'TCP' : ''}${config.tcpSocketPath && config.httpSocketPath ? '+' : ''}${config.httpSocketPath ? 'HTTP' : ''})${reset}`
    : `${dim}disabled${reset}`;

  console.log(`
${magenta}        (\\(\\        ${reset}
${magenta}        ( -.-)      ${bold}bunqueue${reset} ${dim}v${VERSION}${reset}
${magenta}        o_(")(")    ${reset}${dim}High-performance job queue for Bun${reset}

${dim}─────────────────────────────────────────────────${reset}

  ${green}●${reset} TCP    ${tcpDisplay}
  ${green}●${reset} HTTP   ${httpDisplay}
  ${yellow}●${reset} Socket ${socketDisplay}
  ${yellow}●${reset} Data   ${config.dataPath ?? 'in-memory'}
  ${yellow}●${reset} Auth   ${config.authTokens.length > 0 ? `${green}enabled${reset}` : `${dim}disabled${reset}`}
  ${yellow}●${reset} Backup ${config.s3BackupEnabled ? `${green}S3 enabled${reset}` : `${dim}disabled${reset}`}
  ${dim}●${reset} Shards ${bold}${SHARD_COUNT}${reset} ${dim}(${cpus().length} CPU cores)${reset}

${dim}─────────────────────────────────────────────────${reset}

  ${dim}Press ${bold}Ctrl+C${reset}${dim} to stop${reset}
`);
}

/** Start the server (direct mode) */
function startServer(): void {
  const config = loadConfig();
  printBanner(config);

  // Create queue manager
  const queueManager = new QueueManager({
    dataPath: config.dataPath,
  });

  // Start TCP server
  const tcpServer = createTcpServer(queueManager, {
    port: config.tcpPort,
    hostname: config.hostname,
    authTokens: config.authTokens,
  });

  // Start HTTP server
  const httpServer = createHttpServer(queueManager, {
    port: config.httpPort,
    hostname: config.hostname,
    authTokens: config.authTokens,
    corsOrigins: config.corsOrigins,
    requireAuthForMetrics: config.requireAuthForMetrics,
  });

  // Initialize S3 backup manager
  let backupManager: S3BackupManager | null = null;
  if (config.dataPath) {
    const backupConfig = S3BackupManager.fromEnv(config.dataPath);
    backupManager = new S3BackupManager(backupConfig);
    backupManager.start();
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    serverLog.info(`Received ${signal}, shutting down...`);

    // Stop stats interval immediately
    clearInterval(statsInterval);

    tcpServer.stop();
    httpServer.stop();

    const shutdownTimeout = SHUTDOWN_TIMEOUT_MS;
    const start = Date.now();
    while (Date.now() - start < shutdownTimeout) {
      const stats = queueManager.getStats();
      if (stats.active === 0) break;
      serverLog.info(`Waiting for ${stats.active} active jobs...`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Stop backup manager
    if (backupManager) {
      backupManager.stop();
    }

    queueManager.shutdown();
    stopRateLimiter();
    serverLog.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Print stats periodically
  const statsInterval = setInterval(() => {
    const stats = queueManager.getStats();
    const memStats = queueManager.getMemoryStats();
    const workerStats = queueManager.workerManager.getStats();
    const mem = process.memoryUsage();
    statsLog.info('Queue statistics', {
      waiting: stats.waiting,
      active: stats.active,
      delayed: stats.delayed,
      completed: stats.completed,
      dlq: stats.dlq,
      tcp: tcpServer.getConnectionCount(),
      ws: httpServer.getWsClientCount(),
      sse: httpServer.getSseClientCount(),
      workers: `${workerStats.active}/${workerStats.total}`,
      mem: `${Math.round(mem.heapUsed / 1024 / 1024)}MB/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      // Internal collection sizes (for memory debugging)
      idx: memStats.jobIndex,
      locks: memStats.jobLocks,
      clients: memStats.clientJobsTotal,
    });
  }, STATS_INTERVAL_MS);
}

// Enable JSON logging if requested
if (process.env.LOG_FORMAT === 'json') {
  Logger.enableJsonMode();
}
