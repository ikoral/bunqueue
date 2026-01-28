#!/usr/bin/env bun
/**
 * bunqueue - High-performance job queue server for Bun
 * Main entry point
 */

import { QueueManager } from './application/queueManager';
import { createTcpServer } from './infrastructure/server/tcp';
import { createHttpServer } from './infrastructure/server/http';
import { Logger, serverLog, statsLog } from './shared/logger';

/** Server configuration from environment */
interface ServerConfig {
  tcpPort: number;
  httpPort: number;
  hostname: string;
  authTokens: string[];
  dataPath: string | undefined;
  corsOrigins: string[];
  requireAuthForMetrics: boolean;
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
  };
}

/** Print startup banner */
function printBanner(config: ServerConfig): void {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   🐰 bunqueue                                                 ║
  ║   High-performance job queue server for Bun               ║
  ║                                                           ║
  ╠═══════════════════════════════════════════════════════════╣
  ║                                                           ║
  ║   TCP Port:  ${String(config.tcpPort).padEnd(44)}║
  ║   HTTP Port: ${String(config.httpPort).padEnd(44)}║
  ║   Host:      ${config.hostname.padEnd(44)}║
  ║   Auth:      ${(config.authTokens.length > 0 ? 'Enabled' : 'Disabled').padEnd(44)}║
  ║   Storage:   ${(config.dataPath ?? 'In-memory').padEnd(44)}║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
}

/** Main function */
function main(): void {
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

    queueManager.shutdown();
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

// Run
try {
  main();
} catch (err: unknown) {
  serverLog.error('Fatal error', { error: String(err) });
  process.exit(1);
}
