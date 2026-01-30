/**
 * Shared TCP Client Instance
 * Singleton pattern for shared client management
 */

import type { ConnectionOptions } from './types';
import { TcpClient } from './client';

/** Shared client instance */
let sharedClient: TcpClient | null = null;

/** Get shared TCP client */
export function getSharedTcpClient(options?: Partial<ConnectionOptions>): TcpClient {
  sharedClient ??= new TcpClient(options);
  return sharedClient;
}

/** Close shared client */
export function closeSharedTcpClient(): void {
  if (sharedClient) {
    sharedClient.close();
    sharedClient = null;
  }
}
