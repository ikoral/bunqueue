/**
 * TCP Client - Re-exports from tcp module
 * @deprecated Import from './tcp' instead
 */

export type { ConnectionOptions, ConnectionHealth } from './tcp';
export { DEFAULT_CONNECTION, TcpClient, getSharedTcpClient, closeSharedTcpClient } from './tcp';
