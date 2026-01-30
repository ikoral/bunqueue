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
  authTokens: string[];
  dataPath: string | undefined;
  corsOrigins: string[];
  requireAuthForMetrics: boolean;
  s3BackupEnabled: boolean;
}

/** Load configuration from environment variables */
function loadConfig(): ServerConfig {
  return {
    tcpPort: parseInt(process.env.TCP_PORT ?? '6789'),
    httpPort: parseInt(process.env.HTTP_PORT ?? '6790'),
    hostname: process.env.HOST ?? '0.0.0.0',
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
  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';

  console.log(`
${cyan}    ____              ____                        ${reset}
${cyan}   / __ )__  ______  / __ \\__  _____  __  _____   ${reset}
${cyan}  / __  / / / / __ \\/ / / / / / / _ \\/ / / / _ \\  ${reset}
${cyan} / /_/ / /_/ / / / / /_/ / /_/ /  __/ /_/ /  __/  ${reset}
${cyan}/_____/\\__,_/_/ /_/\\___\\_\\__,_/\\___/\\__,_/\\___/   ${reset}
${dim}                                          v${VERSION}${reset}

${bold}High-performance job queue server written in TypeScript${reset}

${dim}─────────────────────────────────────────────────${reset}

  ${green}●${reset} TCP    ${bold}${config.hostname}:${config.tcpPort}${reset}
  ${green}●${reset} HTTP   ${bold}${config.hostname}:${config.httpPort}${reset}
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
    tcpServer.stop();
    httpServer.stop();

    const shutdownTimeout = 30_000;
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
    const workerStats = queueManager.workerManager.getStats();
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
    });
  }, 30_000);

  // Ensure stats interval is cleaned up on shutdown
  process.on('beforeExit', () => {
    clearInterval(statsInterval);
  });
}

// Enable JSON logging if requested
if (process.env.LOG_FORMAT === 'json') {
  Logger.enableJsonMode();
}
