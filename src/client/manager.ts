/**
 * Shared QueueManager singleton
 */

import { QueueManager } from '../application/queueManager';

/** Shared manager type export */
export type SharedManager = QueueManager;

let instance: QueueManager | null = null;

/** Get data path from environment (priority: BUNQUEUE_DATA_PATH > BQ_DATA_PATH > DATA_PATH) */
function getDataPath(): string | undefined {
  return (
    Bun.env.BUNQUEUE_DATA_PATH ?? Bun.env.BQ_DATA_PATH ?? Bun.env.DATA_PATH ?? Bun.env.SQLITE_PATH
  );
}

/** Get shared QueueManager instance. Programmatic dataPath overrides env var. */
export function getSharedManager(dataPath?: string): QueueManager {
  instance ??= new QueueManager({ dataPath: dataPath ?? getDataPath() });
  return instance;
}

/** Shutdown shared manager */
export function shutdownManager(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
