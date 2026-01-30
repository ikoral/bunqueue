/**
 * Job Parser
 * Parses job data from TCP responses
 */

import type { Job as InternalJob } from '../../domain/types/job';
import { jobId } from '../../domain/types/job';

/**
 * Parse job from TCP response data
 */
export function parseJobFromResponse(
  jobData: Record<string, unknown>,
  queueName: string
): InternalJob {
  return {
    id: jobId(jobData.id as string),
    queue: queueName,
    data: jobData.data,
    priority: (jobData.priority as number | undefined) ?? 0,
    createdAt: (jobData.createdAt as number | undefined) ?? Date.now(),
    runAt: (jobData.runAt as number | undefined) ?? Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    attempts: (jobData.attempts as number | undefined) ?? 0,
    maxAttempts: (jobData.maxAttempts as number | undefined) ?? 3,
    backoff: (jobData.backoff as number | undefined) ?? 1000,
    ttl: (jobData.ttl as number | undefined) ?? null,
    timeout: (jobData.timeout as number | undefined) ?? null,
    uniqueKey: (jobData.uniqueKey as string | undefined) ?? null,
    customId: (jobData.customId as string | undefined) ?? null,
    progress: (jobData.progress as number | undefined) ?? 0,
    progressMessage: (jobData.progressMessage as string | undefined) ?? null,
    dependsOn: [],
    parentId: null,
    childrenIds: [],
    childrenCompleted: 0,
    tags: [],
    groupId: null,
    lifo: false,
    removeOnComplete: (jobData.removeOnComplete as boolean | undefined) ?? false,
    removeOnFail: false,
    stallCount: 0,
    stallTimeout: null,
    lastHeartbeat: Date.now(),
    repeat: null,
  } as InternalJob;
}
