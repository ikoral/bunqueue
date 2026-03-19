#!/usr/bin/env bun
/**
 * bunqueue - High-performance job queue server for Bun
 * Main entry point - routes to CLI for client commands or starts server
 */

/** Configurable timeouts from environment (must be before startServer call) */
const SHUTDOWN_TIMEOUT_MS = parseInt(Bun.env.SHUTDOWN_TIMEOUT_MS ?? '30000', 10);
const STATS_INTERVAL_MS = parseInt(Bun.env.STATS_INTERVAL_MS ?? '300000', 10);

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
// Route to CLI when flags are passed (e.g. `bunqueue -p 8945`)
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- process.argv[2] can be undefined at runtime
const hasFlags = firstArg?.startsWith('-');

// Route to CLI for client commands, help, version, start, or when flags are present
if (isClientCommand || hasHelpOrVersion || isStartCommand || hasFlags) {
  void import('./cli/index').then(({ main }) => main());
} else {
  // Direct server mode (no args at all)
  startServer();
}

import { QueueManager } from './application/queueManager';
import { createTcpServer } from './infrastructure/server/tcp';
import { createHttpServer } from './infrastructure/server/http';
import { Logger, serverLog, statsLog, type LogLevel } from './shared/logger';
import { stopRateLimiter } from './infrastructure/server/rateLimiter';
import { VERSION } from './shared/version';
import { S3BackupManager } from './infrastructure/backup';
import { CloudAgent } from './infrastructure/cloud';
import { SHARD_COUNT } from './shared/hash';

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

/** Load configuration from environment variables */
function loadConfig(): ServerConfig {
  return {
    tcpPort: parseInt(Bun.env.TCP_PORT ?? '6789', 10),
    httpPort: parseInt(Bun.env.HTTP_PORT ?? '6790', 10),
    hostname: Bun.env.HOST ?? '0.0.0.0',
    tcpSocketPath: Bun.env.TCP_SOCKET_PATH,
    httpSocketPath: Bun.env.HTTP_SOCKET_PATH,
    authTokens: Bun.env.AUTH_TOKENS?.split(',').filter(Boolean) ?? [],
    dataPath: Bun.env.DATA_PATH ?? Bun.env.SQLITE_PATH,
    corsOrigins: Bun.env.CORS_ALLOW_ORIGIN?.split(',').filter(Boolean) ?? [],
    requireAuthForMetrics: Bun.env.METRICS_AUTH === 'true',
    s3BackupEnabled: Bun.env.S3_BACKUP_ENABLED === '1' || Bun.env.S3_BACKUP_ENABLED === 'true',
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
  ${yellow}●${reset} S3 Backup ${config.s3BackupEnabled ? `${green}enabled${reset}` : `${dim}disabled${reset}`}
  ${yellow}●${reset} Cloud  ${Bun.env.BUNQUEUE_CLOUD_URL ? `${green}enabled${reset} ${dim}→ ${Bun.env.BUNQUEUE_CLOUD_URL}${reset}` : `${dim}disabled${reset}`}
  ${dim}●${reset} Shards ${bold}${SHARD_COUNT}${reset} ${dim}(${navigator.hardwareConcurrency} CPU cores)${reset}

${dim}─────────────────────────────────────────────────${reset}

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
    backupManager.setDashboardEmit(queueManager.emitDashboardEvent.bind(queueManager));
    backupManager.start();
  }

  // Initialize bunqueue Cloud agent (remote dashboard telemetry)
  const cloudAgent = CloudAgent.create(queueManager, config.dataPath);

  queueManager.emitDashboardEvent('server:started', {
    tcpPort: config.tcpPort,
    httpPort: config.httpPort,
    shards: SHARD_COUNT,
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
      await Bun.sleep(1000);
    }

    // Stop backup manager
    if (backupManager) {
      backupManager.stop();
    }

    // Stop Cloud agent (sends final shutdown snapshot)
    if (cloudAgent) {
      await cloudAgent.stop();
    }

    queueManager.emitDashboardEvent('server:shutdown', { signal });
    queueManager.shutdown();
    stopRateLimiter();
    serverLog.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    serverLog.error('Uncaught exception - initiating shutdown', {
      error: err.message,
      stack: err.stack,
    });
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    serverLog.error('Unhandled promise rejection - initiating shutdown', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void shutdown('unhandledRejection');
  });

  // Print stats periodically
  const statsInterval = setInterval(() => {
    const stats = queueManager.getStats();
    const memStats = queueManager.getMemoryStats();
    const workerStats = queueManager.workerManager.getStats();
    const mem = process.memoryUsage();
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    statsLog.info('Queue statistics', {
      time: timestamp,
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
if (Bun.env.LOG_FORMAT === 'json') {
  Logger.enableJsonMode();
}

// Set log level from environment
if (Bun.env.LOG_LEVEL) {
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const level = Bun.env.LOG_LEVEL.toLowerCase();
  if (validLevels.includes(level as LogLevel)) {
    Logger.setLevel(level as LogLevel);
  }
}
