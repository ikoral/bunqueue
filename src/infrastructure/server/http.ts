/**
 * HTTP Server
 * REST API and WebSocket support
 */

import type { Server, ServerWebSocket } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import { handleCommand, type HandlerContext } from './handler';
import { constantTimeEqual, uuid } from '../../shared/hash';
import type { JobEvent } from '../../domain/types/queue';
import { httpLog } from '../../shared/logger';
import { getRateLimiter } from './rateLimiter';
import { SseHandler } from './sseHandler';
import { WsHandler, type WsData } from './wsHandler';
import {
  jsonResponse,
  corsResponse,
  healthEndpoint,
  gcEndpoint,
  heapStatsEndpoint,
  statsEndpoint,
  metricsEndpoint,
} from './httpEndpoints';

/**
 * Validate auth token against valid tokens set
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
  port?: number;
  hostname?: string;
  socketPath?: string;
  authTokens?: string[];
  corsOrigins?: string[];
  requireAuthForMetrics?: boolean;
}

/**
 * Create and start HTTP server
 */
export function createHttpServer(queueManager: QueueManager, config: HttpServerConfig) {
  const authTokens = new Set(config.authTokens ?? []);
  const corsOrigins = new Set(config.corsOrigins ?? ['*']);
  const wsHandler = new WsHandler();
  const sseHandler = new SseHandler();

  // Subscribe to queue events for broadcast
  queueManager.subscribe((event: JobEvent) => {
    wsHandler.broadcast(event);
    sseHandler.broadcast(event);
  });

  // Helper to get CORS origin string
  const getCorsOrigin = () => (corsOrigins.has('*') ? '*' : Array.from(corsOrigins).join(', '));

  // Fetch handler
  const fetch = async (req: Request, server: Server<WsData>) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return corsResponse(corsOrigins);
    }

    // Health endpoints (no auth, no rate limit)
    if (path === '/health') {
      return healthEndpoint(queueManager, wsHandler.size, sseHandler.size);
    }
    if (path === '/healthz' || path === '/live') {
      return new Response('OK', { status: 200 });
    }
    if (path === '/ready') {
      return jsonResponse({ ok: true, ready: true });
    }

    // Debug endpoints
    if (path === '/gc' && req.method === 'POST') {
      return gcEndpoint(queueManager);
    }
    if (path === '/heapstats' && req.method === 'GET') {
      return heapStatsEndpoint(queueManager);
    }

    // Rate limiting
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      'unknown';
    if (!getRateLimiter().isAllowed(clientIp)) {
      return jsonResponse({ ok: false, error: 'Rate limit exceeded' }, 429);
    }

    // WebSocket upgrade
    if (path === '/ws' || path.startsWith('/ws/')) {
      // Validate auth token if authentication is required
      if (authTokens.size > 0) {
        const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
        if (!validateAuthToken(token, authTokens)) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
      }
      const queueFilter = path.startsWith('/ws/queues/') ? path.slice('/ws/queues/'.length) : null;
      const upgraded = server.upgrade(req, {
        data: { id: uuid(), authenticated: true, queueFilter },
      });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // SSE endpoint
    if (path === '/events' || path.startsWith('/events/')) {
      if (authTokens.size > 0) {
        const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
        if (!validateAuthToken(token, authTokens)) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
      }
      const queueFilter = path.startsWith('/events/queues/')
        ? path.slice('/events/queues/'.length)
        : null;
      return sseHandler.createResponse(queueFilter, getCorsOrigin());
    }

    // Prometheus metrics
    if (path === '/prometheus' && req.method === 'GET') {
      if (config.requireAuthForMetrics && authTokens.size > 0) {
        const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
        if (!validateAuthToken(token, authTokens)) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
      }
      return new Response(queueManager.getPrometheusMetrics(), {
        headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
      });
    }

    // Check authentication for other endpoints
    if (authTokens.size > 0) {
      const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
      if (!validateAuthToken(token, authTokens)) {
        return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
      }
    }

    // Generate unique clientId for HTTP request (stateless, but needed for job ownership tracking)
    const clientId = uuid();
    const ctx: HandlerContext = { queueManager, authTokens, authenticated: true, clientId };

    try {
      return await routeRequest(req, path, ctx, corsOrigins);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return jsonResponse({ ok: false, error: message }, 500);
    }
  };

  // WebSocket handlers
  const websocket = {
    open(ws: ServerWebSocket<WsData>) {
      wsHandler.onOpen(ws);
    },
    async message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      const ctx: HandlerContext = {
        queueManager,
        authTokens,
        authenticated: ws.data.authenticated,
        clientId: ws.data.id, // Use WebSocket connection ID for job ownership tracking
      };
      await wsHandler.onMessage(ws, message, ctx);
    },
    close(ws: ServerWebSocket<WsData>) {
      const clientId = ws.data.id;
      wsHandler.onClose(ws);
      // Release all jobs owned by this WebSocket client back to queue
      queueManager
        .releaseClientJobs(clientId)
        .then((released) => {
          if (released > 0) {
            httpLog.info('WebSocket client disconnected, released jobs', { clientId, released });
          }
        })
        .catch((err: unknown) => {
          httpLog.error('Failed to release WebSocket client jobs', {
            clientId,
            error: String(err),
          });
        });
    },
  };

  // Create server
  let server: Server<WsData>;
  if (config.socketPath) {
    server = Bun.serve<WsData>({ unix: config.socketPath, fetch, websocket });
    httpLog.info('Server listening', { unix: config.socketPath });
  } else {
    server = Bun.serve<WsData>({
      hostname: config.hostname ?? '0.0.0.0',
      port: config.port ?? 6790,
      fetch,
      websocket,
    });
    httpLog.info('Server listening', { host: config.hostname ?? '0.0.0.0', port: config.port });
  }

  return {
    server,
    wsClients: wsHandler.getClients(),
    sseClients: sseHandler.getClients(),
    getWsClientCount: () => wsHandler.size,
    getSseClientCount: () => sseHandler.size,
    stop(): void {
      sseHandler.closeAll();
      void server.stop();
      httpLog.info('Server stopped');
    },
  };
}

/** Route HTTP request to handler */
async function routeRequest(
  req: Request,
  path: string,
  ctx: HandlerContext,
  corsOrigins: Set<string>
): Promise<Response> {
  const method = req.method;

  // Stats endpoint
  if (path === '/stats' && method === 'GET') {
    return statsEndpoint(ctx.queueManager, corsOrigins);
  }

  // Metrics endpoint
  if (path === '/metrics' && method === 'GET') {
    return metricsEndpoint(ctx.queueManager, corsOrigins);
  }

  // Queue operations: POST/GET /queues/:queue/jobs
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

  return jsonResponse({ ok: false, error: 'Not found' }, 404, corsOrigins);
}

export type HttpServer = ReturnType<typeof createHttpServer>;
