/**
 * HTTP Routes - Queue operations
 * All /queues/:queue/* endpoints + /queues list
 */

import { handleCommand } from './handler';
import type { HandlerContext } from './types';
import { jsonResponse, parseJsonBody } from './httpEndpoints';

type Body = Record<string, unknown>;

/** Route push/pull/bulk job operations */
async function routeJobOps(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Set<string>
): Promise<Response | null> {
  // POST/GET /queues/:queue/jobs - push/pull
  const queueJobsMatch = path.match(/^\/queues\/([^/]+)\/jobs$/);
  if (queueJobsMatch) {
    const queue = decodeURIComponent(queueJobsMatch[1]);

    if (method === 'POST') {
      let body: Body;
      try {
        body = (await req.json()) as Body;
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
      }
      const cmd = {
        cmd: 'PUSH' as const,
        queue,
        data: body.data,
        priority: body.priority,
        delay: body.delay,
        maxAttempts: body.maxAttempts ?? body.attempts,
        backoff: body.backoff,
        timeout: body.timeout,
        jobId: body.jobId,
        removeOnComplete: body.removeOnComplete,
        removeOnFail: body.removeOnFail,
        durable: body.durable,
        ttl: body.ttl,
        uniqueKey: body.uniqueKey,
        groupId: body.groupId,
        dependsOn: body.dependsOn,
        tags: body.tags,
        lifo: body.lifo,
        repeat: body.repeat,
      } as Parameters<typeof handleCommand>[0];
      const r = await handleCommand(cmd, ctx);
      return jsonResponse(r, r.ok ? 200 : 400, cors);
    }

    if (method === 'GET') {
      const timeout = parseInt(new URL(req.url).searchParams.get('timeout') ?? '0');
      const r = await handleCommand({ cmd: 'PULL', queue, timeout }, ctx);
      return jsonResponse(r, 200, cors);
    }
  }

  // POST /queues/:queue/jobs/bulk - bulk push
  const bulkMatch = path.match(/^\/queues\/([^/]+)\/jobs\/bulk$/);
  if (bulkMatch && method === 'POST') {
    const queue = decodeURIComponent(bulkMatch[1]);
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    const r = await handleCommand(
      {
        cmd: 'PUSHB',
        queue,
        jobs: body['jobs'] as unknown[],
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, r.ok ? 200 : 400, cors);
  }

  // POST /queues/:queue/jobs/pull-batch
  const pullBatchMatch = path.match(/^\/queues\/([^/]+)\/jobs\/pull-batch$/);
  if (pullBatchMatch && method === 'POST') {
    const queue = decodeURIComponent(pullBatchMatch[1]);
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'PULLB',
        queue,
        count: body['count'] as number,
        timeout: body['timeout'] as number | undefined,
        owner: body['owner'] as string | undefined,
        lockTtl: body['lockTtl'] as number | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // GET /queues/:queue/jobs/list?state=&limit=&offset=
  const listMatch = path.match(/^\/queues\/([^/]+)\/jobs\/list$/);
  if (listMatch && method === 'GET') {
    const queue = decodeURIComponent(listMatch[1]);
    const url = new URL(req.url);
    const state = url.searchParams.get('state') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = limitParam ? parseInt(limitParam) : undefined;
    const offset = offsetParam ? parseInt(offsetParam) : undefined;
    const r = await handleCommand(
      {
        cmd: 'GetJobs',
        queue,
        state,
        limit,
        offset,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  return null;
}

/** Route /queues/* requests. Returns Response or null if no match. */
export async function routeQueueRoutes(
  req: Request,
  path: string,
  method: string,
  ctx: HandlerContext,
  cors: Set<string>
): Promise<Response | null> {
  // GET /queues - list all queues
  if (path === '/queues' && method === 'GET') {
    const r = await handleCommand({ cmd: 'ListQueues' }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // Delegate push/pull/bulk/list operations
  const jobOpsResult = await routeJobOps(req, path, method, ctx, cors);
  if (jobOpsResult) return jobOpsResult;

  // GET /queues/:queue/counts
  const countsMatch = path.match(/^\/queues\/([^/]+)\/counts$/);
  if (countsMatch && method === 'GET') {
    const queue = decodeURIComponent(countsMatch[1]);
    const r = await handleCommand({ cmd: 'GetJobCounts', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // GET /queues/:queue/count
  const countMatch = path.match(/^\/queues\/([^/]+)\/count$/);
  if (countMatch && method === 'GET') {
    const queue = decodeURIComponent(countMatch[1]);
    const r = await handleCommand({ cmd: 'Count', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // GET /queues/:queue/priority-counts
  const priCountsMatch = path.match(/^\/queues\/([^/]+)\/priority-counts$/);
  if (priCountsMatch && method === 'GET') {
    const queue = decodeURIComponent(priCountsMatch[1]);
    const r = await handleCommand({ cmd: 'GetCountsPerPriority', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // GET /queues/:queue/paused
  const pausedMatch = path.match(/^\/queues\/([^/]+)\/paused$/);
  if (pausedMatch && method === 'GET') {
    const queue = decodeURIComponent(pausedMatch[1]);
    const r = await handleCommand({ cmd: 'IsPaused', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/pause
  const pauseMatch = path.match(/^\/queues\/([^/]+)\/pause$/);
  if (pauseMatch && method === 'POST') {
    const queue = decodeURIComponent(pauseMatch[1]);
    const r = await handleCommand({ cmd: 'Pause', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/resume
  const resumeMatch = path.match(/^\/queues\/([^/]+)\/resume$/);
  if (resumeMatch && method === 'POST') {
    const queue = decodeURIComponent(resumeMatch[1]);
    const r = await handleCommand({ cmd: 'Resume', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/drain
  const drainMatch = path.match(/^\/queues\/([^/]+)\/drain$/);
  if (drainMatch && method === 'POST') {
    const queue = decodeURIComponent(drainMatch[1]);
    const r = await handleCommand({ cmd: 'Drain', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/obliterate
  const obliterateMatch = path.match(/^\/queues\/([^/]+)\/obliterate$/);
  if (obliterateMatch && method === 'POST') {
    const queue = decodeURIComponent(obliterateMatch[1]);
    const r = await handleCommand({ cmd: 'Obliterate', queue }, ctx);
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/clean
  const cleanMatch = path.match(/^\/queues\/([^/]+)\/clean$/);
  if (cleanMatch && method === 'POST') {
    const queue = decodeURIComponent(cleanMatch[1]);
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'Clean',
        queue,
        grace: typeof body['grace'] === 'number' ? body['grace'] : 0,
        state: body['state'] as string | undefined,
        limit: body['limit'] as number | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/promote-jobs
  const promoteJobsMatch = path.match(/^\/queues\/([^/]+)\/promote-jobs$/);
  if (promoteJobsMatch && method === 'POST') {
    const queue = decodeURIComponent(promoteJobsMatch[1]);
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'PromoteJobs',
        queue,
        count: body['count'] as number | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  // POST /queues/:queue/retry-completed
  const retryCompMatch = path.match(/^\/queues\/([^/]+)\/retry-completed$/);
  if (retryCompMatch && method === 'POST') {
    const queue = decodeURIComponent(retryCompMatch[1]);
    const body = await parseJsonBody(req, cors);
    if (body instanceof Response) return body;
    const r = await handleCommand(
      {
        cmd: 'RetryCompleted',
        queue,
        id: body['id'] as string | undefined,
      } as Parameters<typeof handleCommand>[0],
      ctx
    );
    return jsonResponse(r, 200, cors);
  }

  return null;
}
