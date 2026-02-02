/**
 * Stall Detection Operations
 * setStallConfig, getStallConfig
 */

import type { StallConfig } from '../types';
import * as dlqOps from './dlqOps';

interface StallContext {
  name: string;
  embedded: boolean;
}

/** Set stall detection configuration (embedded only) */
export function setStallConfig(ctx: StallContext, config: Partial<StallConfig>): void {
  if (!ctx.embedded) {
    console.error('setStallConfig: embedded only');
    return;
  }
  dlqOps.setStallConfigEmbedded(ctx.name, config as Record<string, unknown>);
}

/** Get stall detection configuration */
export function getStallConfig(ctx: StallContext): StallConfig {
  if (!ctx.embedded) {
    return { enabled: true, stallInterval: 30000, maxStalls: 3, gracePeriod: 5000 };
  }
  return dlqOps.getStallConfigEmbedded(ctx.name);
}
