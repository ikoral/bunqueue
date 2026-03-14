/**
 * HTTP Routes - Job operations
 * All /jobs/:id/* endpoints, split into sub-routers for complexity
 */

import { handleCommand } from './handler';
import type { HandlerContext } from './types';
import { jsonResponse, parseJsonBody } from './httpEndpoints';

type Body = Record<string, unknown>;
type Cors = Set<string>;

/** Job management: promote, update, state, result, progress, priority, discard */
async function routeJobManagement(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Cors
): Promise<Response | null> {
  const promoteMatch = path.match(/^\/jobs\/([^/]+)\/promote$/);
  if (promoteMatch && method === 'POST') {
    const r = await handleCommand({ cmd: 'Promote', id: promoteMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const dataMatch = path.match(/^\/jobs\/([^/]+)\/data$/);
  if (dataMatch && method === 'PUT') {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    const r = await handleCommand({ cmd: 'Update', id: dataMatch[1], data: body['data'] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const stateMatch = path.match(/^\/jobs\/([^/]+)\/state$/);
  if (stateMatch && method === 'GET') {
    const r = await handleCommand({ cmd: 'GetState', id: stateMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  const resultMatch = path.match(/^\/jobs\/([^/]+)\/result$/);
  if (resultMatch && method === 'GET') {
    const r = await handleCommand({ cmd: 'GetResult', id: resultMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  const progressMatch = path.match(/^\/jobs\/([^/]+)\/progress$/);
  if (progressMatch && method === 'GET') {
    const r = await handleCommand({ cmd: 'GetProgress', id: progressMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }
  if (progressMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'Progress',
        id: progressMatch[1],
        progress: body['progress'] as number,
        message: body['message'] as string | undefined,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const priorityMatch = path.match(/^\/jobs\/([^/]+)\/priority$/);
  if (priorityMatch && method === 'PUT') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'ChangePriority',
        id: priorityMatch[1],
        priority: body['priority'] as number,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const discardMatch = path.match(/^\/jobs\/([^/]+)\/discard$/);
  if (discardMatch && method === 'POST') {
    const r = await handleCommand({ cmd: 'Discard', id: discardMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  return null;
}

/** Job advanced: delay, children, logs, heartbeat, wait, lock, move-to-wait */
async function routeJobAdvanced(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Cors
): Promise<Response | null> {
  const moveDelayedMatch = path.match(/^\/jobs\/([^/]+)\/move-to-delayed$/);
  if (moveDelayedMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'MoveToDelayed',
        id: moveDelayedMatch[1],
        delay: body['delay'] as number,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const changeDelayMatch = path.match(/^\/jobs\/([^/]+)\/delay$/);
  if (changeDelayMatch && method === 'PUT') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'ChangeDelay',
        id: changeDelayMatch[1],
        delay: body['delay'] as number,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const childrenMatch = path.match(/^\/jobs\/([^/]+)\/children$/);
  if (childrenMatch && method === 'GET') {
    const r = await handleCommand({ cmd: 'GetChildrenValues', id: childrenMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  const logsMatch = path.match(/^\/jobs\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    const r = await handleCommand({ cmd: 'GetLogs', id: logsMatch[1] }, ctx);
    return jsonResponse(r, 200, cors);
  }
  if (logsMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'AddLog',
        id: logsMatch[1],
        message: body['message'] as string,
        level: body['level'] as 'info' | 'warn' | 'error' | undefined,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }
  if (logsMatch && method === 'DELETE') {
    const r = await handleCommand({ cmd: 'ClearLogs', id: logsMatch[1] }, ctx);
    return jsonResponse(r, 200, cors);
  }

  const heartbeatMatch = path.match(/^\/jobs\/([^/]+)\/heartbeat$/);
  if (heartbeatMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'JobHeartbeat',
        id: heartbeatMatch[1],
        token: body['token'] as string | undefined,
        duration: body['duration'] as number | undefined,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const waitMatch = path.match(/^\/jobs\/([^/]+)\/wait$/);
  if (waitMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'WaitJob',
        id: waitMatch[1],
        timeout: body['timeout'] as number | undefined,
      },
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  const extendLockMatch = path.match(/^\/jobs\/([^/]+)\/extend-lock$/);
  if (extendLockMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'ExtendLock',
        id: extendLockMatch[1],
        duration: body['duration'] as number,
        token: body['token'] as string | undefined,
      },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  const moveToWaitMatch = path.match(/^\/jobs\/([^/]+)\/move-to-wait$/);
  if (moveToWaitMatch && method === 'POST') {
    const r = await handleCommand({ cmd: 'MoveToWait', id: moveToWaitMatch[1] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  return null;
}

/** Route /jobs/* requests. Returns Response or null if no match. */
export async function routeJobRoutes(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Cors
): Promise<Response | null> {
  // Batch endpoints FIRST (exact match, before generic /jobs/:id pattern)
  if (path === '/jobs/ack-batch' && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'ACKB',
        ids: body['ids'] as string[],
        results: body['results'] as unknown[] | undefined,
        tokens: body['tokens'] as string[] | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }
  if (path === '/jobs/extend-locks' && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'ExtendLocks',
        ids: body['ids'] as string[],
        tokens: body['tokens'] as string[],
        durations: body['durations'] as number[],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }
  if (path === '/jobs/heartbeat-batch' && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'JobHeartbeatB',
        ids: body['ids'] as string[],
        tokens: body['tokens'] as string[] | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // GET /jobs/custom/:customId (before generic /jobs/:id)
  const customIdMatch = path.match(/^\/jobs\/custom\/([^/]+)$/);
  if (customIdMatch && method === 'GET') {
    const customId = decodeURIComponent(customIdMatch[1]);
    const r = await handleCommand({ cmd: 'GetJobByCustomId', customId }, ctx);
    return jsonResponse(r, r.ok ? 200 : 404, cors);
  }

  // GET/DELETE /jobs/:id (generic, after specific paths)
  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const id = jobMatch[1];
    if (method === 'GET') {
      const r = await handleCommand({ cmd: 'GetJob', id }, ctx);
      return jsonResponse(r, r.ok ? 200 : 404, cors);
    }
    if (method === 'DELETE') {
      const r = await handleCommand({ cmd: 'Cancel', id }, ctx);
      return jsonResponse(r, 200, cors);
    }
  }

  // POST /jobs/:id/ack
  const ackMatch = path.match(/^\/jobs\/([^/]+)\/ack$/);
  if (ackMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand({ cmd: 'ACK', id: ackMatch[1], result: body['result'] }, ctx);
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // POST /jobs/:id/fail
  const failMatch = path.match(/^\/jobs\/([^/]+)\/fail$/);
  if (failMatch && method === 'POST') {
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      { cmd: 'FAIL', id: failMatch[1], error: body['error'] as string | undefined },
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // Delegate to sub-routers
  const mgmt = await routeJobManagement(req, path, method, ctx, cors);
  if (mgmt) return mgmt;
  return routeJobAdvanced(req, path, method, ctx, cors);
}
