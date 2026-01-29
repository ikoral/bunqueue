/**
 * Shared QueueManager singleton
 */

import { QueueManager } from '../application/queueManager';

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
