/**
 * Shared QueueManager singleton
 */

import { QueueManager } from '../application/queueManager';

/** Shared manager type export */
export type SharedManager = QueueManager;

let instance: QueueManager | null = null;

/** Get shared QueueManager instance */
export function getSharedManager(): QueueManager {
  instance ??= new QueueManager();
  return instance;
}

/** Shutdown shared manager */
export function shutdownManager(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
