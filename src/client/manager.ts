/**
 * Shared QueueManager singleton
 */

import { QueueManager } from '../application/queueManager';

/** Shared manager type export */
export type SharedManager = QueueManager;

let instance: QueueManager | null = null;

/** Get data path from environment */
function getDataPath(): string | undefined {
  return process.env.DATA_PATH ?? process.env.SQLITE_PATH;
}

/** Get shared QueueManager instance */
export function getSharedManager(): QueueManager {
  if (!instance) {
    const dataPath = getDataPath();
    instance = new QueueManager({ dataPath });
  }
  return instance;
}

/** Shutdown shared manager */
export function shutdownManager(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
