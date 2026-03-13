/**
 * Stall Detection Operations
 * setStallConfig, getStallConfig
 */

import type { TcpConnectionPool } from '../tcpPool';
import type { StallConfig } from '../types';
import * as dlqOps from './dlqOps';

interface StallContext {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

/** Set stall detection configuration */
export function setStallConfig(ctx: StallContext, config: Partial<StallConfig>): void {
  if (ctx.embedded) {
    dlqOps.setStallConfigEmbedded(ctx.name, config as Record<string, unknown>);
  } else if (ctx.tcp) {
    void ctx.tcp.send({ cmd: 'SetStallConfig', queue: ctx.name, config });
  }
}

/** Get stall detection configuration */
export function getStallConfig(ctx: StallContext): StallConfig {
  if (ctx.embedded) {
    return dlqOps.getStallConfigEmbedded(ctx.name);
  }
  // Return defaults synchronously; use getStallConfigAsync for TCP
  return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
}

/** Get stall detection configuration (async, works in TCP mode) */
export async function getStallConfigAsync(ctx: StallContext): Promise<StallConfig> {
  if (ctx.embedded) {
    return dlqOps.getStallConfigEmbedded(ctx.name);
  }
  if (!ctx.tcp) {
    return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
  }
  const response = await ctx.tcp.send({ cmd: 'GetStallConfig', queue: ctx.name });
  if (!response.ok) {
    return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
  }
  return (response as { config: StallConfig }).config;
}
