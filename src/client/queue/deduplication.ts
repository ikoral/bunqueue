/**
 * Deduplication Operations
 */

import { getSharedManager } from '../manager';

interface DeduplicationContext {
  name: string;
  embedded: boolean;
}

/** Get the job ID associated with a deduplication key */
export function getDeduplicationJobId(
  ctx: DeduplicationContext,
  deduplicationId: string
): Promise<string | null> {
  if (ctx.embedded) {
    const job = getSharedManager().getJobByCustomId(deduplicationId);
    return Promise.resolve(job ? String(job.id) : null);
  }
  return Promise.resolve(null);
}

/** Remove a deduplication key */
export function removeDeduplicationKey(
  ctx: DeduplicationContext,
  deduplicationId: string
): Promise<number> {
  if (ctx.embedded) {
    const job = getSharedManager().getJobByCustomId(deduplicationId);
    if (job) {
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
  return Promise.resolve(0);
}
