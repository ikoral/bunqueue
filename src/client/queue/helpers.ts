/**
 * Queue Helpers
 * Utility functions for queue operations
 */

import type { getSharedManager } from '../manager';
import { shardIndex } from '../../shared/hash';
import type { Shard } from '../../domain/queue/shard';
import type { DlqFilter, DlqConfig as DomainDlqConfig } from '../../domain/types/dlq';
import type { DlqFilter as ClientDlqFilter } from '../types';
import type * as dlqOps from '../../application/dlqManager';

/** Check if embedded mode should be forced (for tests) */
export const FORCE_EMBEDDED = process.env.BUNQUEUE_EMBEDDED === '1';

/** Get shard from manager (embedded mode only) */
export function getShard(manager: ReturnType<typeof getSharedManager>, queue: string): Shard {
  const idx = shardIndex(queue);
  return (manager as unknown as { shards: Shard[] }).shards[idx];
}

/** Create DLQ context (embedded mode only) */
export function getDlqContext(manager: ReturnType<typeof getSharedManager>): dlqOps.DlqContext {
  return {
    shards: (manager as unknown as { shards: Shard[] }).shards,
    jobIndex: manager.getJobIndex(),
  };
}

/** Convert client filter to domain filter */
export function toDomainFilter(filter: ClientDlqFilter | undefined): DlqFilter | undefined {
  if (!filter) return undefined;
  return filter as unknown as DlqFilter;
}

/** Convert client DLQ config to domain config */
export function toDomainDlqConfig(config: Record<string, unknown>): Partial<DomainDlqConfig> {
  return config as Partial<DomainDlqConfig>;
}
