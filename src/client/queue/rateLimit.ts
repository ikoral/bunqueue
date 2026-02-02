/**
 * Rate Limit and Concurrency Operations
 */

import { getSharedManager } from '../manager';
import type { TcpConnectionPool } from '../tcpPool';

interface RateLimitContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

/** Set global concurrency limit */
export function setGlobalConcurrency(ctx: RateLimitContext, concurrency: number): void {
  if (ctx.embedded) {
    getSharedManager().setConcurrency(ctx.name, concurrency);
  } else if (ctx.tcp) {
    void ctx.tcp.send({ cmd: 'SetConcurrency', queue: ctx.name, limit: concurrency });
  }
}

/** Remove global concurrency limit */
export function removeGlobalConcurrency(ctx: RateLimitContext): void {
  if (ctx.embedded) {
    getSharedManager().clearConcurrency(ctx.name);
  } else if (ctx.tcp) {
    void ctx.tcp.send({ cmd: 'ClearConcurrency', queue: ctx.name });
  }
}

/** Get global concurrency limit */
export function getGlobalConcurrency(_ctx: RateLimitContext): Promise<number | null> {
  return Promise.resolve(null);
}

/** Set global rate limit */
export function setGlobalRateLimit(ctx: RateLimitContext, max: number, _duration?: number): void {
  if (ctx.embedded) {
    getSharedManager().setRateLimit(ctx.name, max);
  } else if (ctx.tcp) {
    void ctx.tcp.send({ cmd: 'RateLimit', queue: ctx.name, limit: max });
  }
}

/** Remove global rate limit */
export function removeGlobalRateLimit(ctx: RateLimitContext): void {
  if (ctx.embedded) {
    getSharedManager().clearRateLimit(ctx.name);
  } else if (ctx.tcp) {
    void ctx.tcp.send({ cmd: 'RateLimitClear', queue: ctx.name });
  }
}

/** Get global rate limit */
export function getGlobalRateLimit(
  _ctx: RateLimitContext
): Promise<{ max: number; duration: number } | null> {
  return Promise.resolve(null);
}

/** Set temporary rate limit with expiration */
export async function rateLimit(ctx: RateLimitContext, expireTimeMs: number): Promise<void> {
  if (ctx.embedded) {
    getSharedManager().setRateLimit(ctx.name, 1);
    setTimeout(() => {
      getSharedManager().clearRateLimit(ctx.name);
    }, expireTimeMs);
  } else if (ctx.tcp) {
    await ctx.tcp.send({ cmd: 'RateLimit', queue: ctx.name, limit: 1 });
  }
}

/** Get rate limit TTL */
export function getRateLimitTtl(_ctx: RateLimitContext, _maxJobs?: number): Promise<number> {
  return Promise.resolve(0);
}

/** Check if queue is at max capacity */
export function isMaxed(_ctx: RateLimitContext): Promise<boolean> {
  return Promise.resolve(false);
}
