/**
 * HTTP Server
 * REST API and WebSocket support
 */

import type { ServerWebSocket } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import { handleCommand, type HandlerContext } from './handler';
import { parseCommand, serializeResponse, errorResponse } from './protocol';
import { constantTimeEqual, uuid } from '../../shared/hash';
import type { JobEvent } from '../../domain/types/queue';
import { httpLog, wsLog } from '../../shared/logger';
import { getRateLimiter } from './rateLimiter';

/** Singleton TextEncoder for SSE messages - avoids allocation per message */
const textEncoder = new TextEncoder();

/** Singleton TextDecoder for WebSocket messages */
const textDecoder = new TextDecoder();

/**
 * Validate auth token against valid tokens set - O(n) but single function
 * Uses constant-time comparison to prevent timing attacks
 */
function validateAuthToken(token: string, authTokens: Set<string>): boolean {
  for (const validToken of authTokens) {
    if (constantTimeEqual(token, validToken)) {
      return true;
    }
  }
  return false;
}

/** HTTP Server configuration */
export interface HttpServerConfig {
  port: number;
  hostname?: string;
  authTokens?: string[];
  corsOrigins?: string[];
  requireAuthForMetrics?: boolean;
}

/** WebSocket client data */
interface WsData {
  id: string;
  authenticated: boolean;
  queueFilter: string | null;
}

/** SSE client tracking */
interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController;
  queueFilter: string | null;
}

/**
 * Create and start HTTP server
 */
export function createHttpServer(queueManager: QueueManager, config: HttpServerConfig) {
  const authTokens = new Set(config.authTokens ?? []);
  const wsClients = new Map<string, ServerWebSocket<WsData>>();
  const sseClients = new Map<string, SseClient>();
  const corsOrigins = new Set(config.corsOrigins ?? ['*']);

  // Subscribe to queue events for WebSocket and SSE broadcast
  queueManager.subscribe((event: JobEvent) => {
    const message = JSON.stringify(event);

    // WebSocket clients
    for (const [, ws] of wsClients) {
      if (!ws.data.queueFilter || ws.data.queueFilter === event.queue) {
        ws.send(message);
      }
    }

    // SSE clients
    const sseMessage = `data: ${message}\n\n`;
    for (const [, client] of sseClients) {
      if (!client.queueFilter || client.queueFilter === event.queue) {
        try {
          client.controller.enqueue(textEncoder.encode(sseMessage));
        } catch {
          // Client disconnected, will be cleaned up
        }
      }
    }
  });

  const server = Bun.serve<WsData>({
    hostname: config.hostname ?? '0.0.0.0',
    port: config.port,

    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return corsResponse(corsOrigins);
      }

      // Health check (no auth, no rate limit)
      if (path === '/health') {
        const stats = queueManager.getStats();
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        return jsonResponse({
          ok: true,
          status: 'healthy',
          uptime: Math.floor(uptime),
          version: '1.0.4',
          queues: {
            waiting: stats.waiting,
            active: stats.active,
            delayed: stats.delayed,
            completed: stats.completed,
            dlq: stats.dlq,
          },
          connections: {
            tcp: 0, // Would need server reference
            ws: wsClients.size,
            sse: sseClients.size,
          },
          memory: {
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memoryUsage.rss / 1024 / 1024),
          },
        });
      }

      // Simple liveness probe (minimal response)
      if (path === '/healthz' || path === '/live') {
        return new Response('OK', { status: 200 });
      }

      // Readiness probe (checks if server can accept work)
      if (path === '/ready') {
        return jsonResponse({ ok: true, ready: true });
      }

      // Rate limiting (use IP as client ID for HTTP)
      const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        'unknown';
      if (!getRateLimiter().isAllowed(clientIp)) {
        return jsonResponse({ ok: false, error: 'Rate limit exceeded' }, 429);
      }

      // WebSocket upgrade
      if (path === '/ws' || path.startsWith('/ws/')) {
        const queueFilter = path.startsWith('/ws/queues/')
          ? path.slice('/ws/queues/'.length)
          : null;

        const upgraded = server.upgrade(req, {
          data: {
            id: uuid(),
            authenticated: authTokens.size === 0,
            queueFilter,
          },
        });

        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return undefined;
      }

      // SSE (Server-Sent Events) endpoint - requires auth when enabled
      if (path === '/events' || path.startsWith('/events/')) {
        // Check authentication for SSE
        if (authTokens.size > 0) {
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.replace('Bearer ', '') ?? '';
          if (!validateAuthToken(token, authTokens)) {
            return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
          }
        }

        const queueFilter = path.startsWith('/events/queues/')
          ? path.slice('/events/queues/'.length)
          : null;

        const clientId = uuid();

        const stream = new ReadableStream({
          start(controller) {
            sseClients.set(clientId, {
              id: clientId,
              controller,
              queueFilter,
            });

            // Send initial connection message
            controller.enqueue(
              textEncoder.encode(`data: {"connected":true,"clientId":"${clientId}"}\n\n`)
            );
          },
          cancel() {
            sseClients.delete(clientId);
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': corsOrigins.has('*')
              ? '*'
              : Array.from(corsOrigins).join(', '),
          },
        });
      }

      // Prometheus metrics endpoint (auth optional via config)
      if (path === '/prometheus' && req.method === 'GET') {
        if (config.requireAuthForMetrics && authTokens.size > 0) {
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.replace('Bearer ', '') ?? '';
          if (!validateAuthToken(token, authTokens)) {
            return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
          }
        }
        const metrics = queueManager.getPrometheusMetrics();
        return new Response(metrics, {
          headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
        });
      }

      // Check authentication
      if (authTokens.size > 0) {
        const authHeader = req.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '') ?? '';
        if (!validateAuthToken(token, authTokens)) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
      }

      // Create handler context
      const ctx: HandlerContext = {
        queueManager,
        authTokens,
        authenticated: true,
      };

      // Route request
      try {
        return await routeRequest(req, path, ctx, corsOrigins);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return jsonResponse({ ok: false, error: message }, 500);
      }
    },

    websocket: {
      open(ws) {
        wsClients.set(ws.data.id, ws);
        wsLog.info('Client connected', { clientId: ws.data.id });
      },

      async message(ws, message) {
        const text = typeof message === 'string' ? message : textDecoder.decode(message);
        const cmd = parseCommand(text);

        if (!cmd) {
          ws.send(errorResponse('Invalid command'));
          return;
        }

        const ctx: HandlerContext = {
          queueManager,
          authTokens,
          authenticated: ws.data.authenticated,
        };

        try {
          const response = await handleCommand(cmd, ctx);

          // Update authentication state
          if (cmd.cmd === 'Auth' && response.ok) {
            ws.data.authenticated = true;
          }

          ws.send(serializeResponse(response));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          ws.send(errorResponse(message, cmd.reqId));
        }
      },

      close(ws) {
        wsClients.delete(ws.data.id);
        wsLog.info('Client disconnected', { clientId: ws.data.id });
      },
    },
  });

  httpLog.info('Server listening', { host: config.hostname ?? '0.0.0.0', port: config.port });

  return {
    server,
    wsClients,
    sseClients,

    /** Get WebSocket client count */
    getWsClientCount(): number {
      return wsClients.size;
    },

    /** Get SSE client count */
    getSseClientCount(): number {
      return sseClients.size;
    },

    /** Stop the server */
    stop(): void {
      // Close all SSE connections
      for (const [, client] of sseClients) {
        try {
          client.controller.close();
        } catch {
          // Ignore
        }
      }
      sseClients.clear();

      void server.stop();
      httpLog.info('Server stopped');
    },
  };
}

/**
 * Route HTTP request to appropriate handler
 */
async function routeRequest(
  req: Request,
  path: string,
  ctx: HandlerContext,
  corsOrigins: Set<string>
): Promise<Response> {
  const method = req.method;

  // Stats endpoint
  if (path === '/stats' && method === 'GET') {
    const stats = ctx.queueManager.getStats();
    return jsonResponse(
      {
        ok: true,
        stats: {
          ...stats,
          totalPushed: Number(stats.totalPushed),
          totalPulled: Number(stats.totalPulled),
          totalCompleted: Number(stats.totalCompleted),
          totalFailed: Number(stats.totalFailed),
        },
      },
      200,
      corsOrigins
    );
  }

  // Metrics endpoint
  if (path === '/metrics' && method === 'GET') {
    const stats = ctx.queueManager.getStats();
    return jsonResponse(
      {
        ok: true,
        metrics: {
          totalPushed: Number(stats.totalPushed),
          totalPulled: Number(stats.totalPulled),
          totalCompleted: Number(stats.totalCompleted),
          totalFailed: Number(stats.totalFailed),
        },
      },
      200,
      corsOrigins
    );
  }

  // Queue operations: POST /queues/:queue/jobs
  const queueJobsMatch = path.match(/^\/queues\/([^/]+)\/jobs$/);
  if (queueJobsMatch) {
    const queue = decodeURIComponent(queueJobsMatch[1]);

    if (method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, corsOrigins);
      }
      const cmd = { cmd: 'PUSH' as const, queue, ...body } as Parameters<typeof handleCommand>[0];
      const response = await handleCommand(cmd, ctx);
      return jsonResponse(response, response.ok ? 200 : 400, corsOrigins);
    }

    if (method === 'GET') {
      // Pull job
      const timeout = parseInt(new URL(req.url).searchParams.get('timeout') ?? '0');
      const cmd = { cmd: 'PULL' as const, queue, timeout };
      const response = await handleCommand(cmd, ctx);
      return jsonResponse(response, 200, corsOrigins);
    }
  }

  // Job operations: GET/DELETE /jobs/:id
  const jobMatch = path.match(/^\/jobs\/(\d+)$/);
  if (jobMatch) {
    const id = jobMatch[1];

    if (method === 'GET') {
      const cmd = { cmd: 'GetJob' as const, id };
      const response = await handleCommand(cmd, ctx);
      return jsonResponse(response, response.ok ? 200 : 404, corsOrigins);
    }

    if (method === 'DELETE') {
      const cmd = { cmd: 'Cancel' as const, id };
      const response = await handleCommand(cmd, ctx);
      return jsonResponse(response, 200, corsOrigins);
    }
  }

  // Job ack: POST /jobs/:id/ack
  const ackMatch = path.match(/^\/jobs\/(\d+)\/ack$/);
  if (ackMatch && method === 'POST') {
    const id = ackMatch[1];
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cmd = { cmd: 'ACK' as const, id, result: body['result'] };
    const response = await handleCommand(cmd, ctx);
    return jsonResponse(response, response.ok ? 200 : 400, corsOrigins);
  }

  // Job fail: POST /jobs/:id/fail
  const failMatch = path.match(/^\/jobs\/(\d+)\/fail$/);
  if (failMatch && method === 'POST') {
    const id = failMatch[1];
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cmd = { cmd: 'FAIL' as const, id, error: body['error'] as string | undefined };
    const response = await handleCommand(cmd, ctx);
    return jsonResponse(response, response.ok ? 200 : 400, corsOrigins);
  }

  // Not found
  return jsonResponse({ ok: false, error: 'Not found' }, 404, corsOrigins);
}

/** Create JSON response with CORS headers */
function jsonResponse(data: unknown, status = 200, corsOrigins?: Set<string>): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (corsOrigins) {
    headers['Access-Control-Allow-Origin'] = corsOrigins.has('*')
      ? '*'
      : Array.from(corsOrigins).join(', ');
  }

  return new Response(JSON.stringify(data), { status, headers });
}

/** Create CORS preflight response */
function corsResponse(corsOrigins: Set<string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigins.has('*')
        ? '*'
        : Array.from(corsOrigins).join(', '),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export type HttpServer = ReturnType<typeof createHttpServer>;
