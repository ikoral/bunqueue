/**
 * Monitor Command Builders
 * Stats, metrics, and health operations
 */

/** Build a monitoring command */
export function buildMonitorCommand(command: string): Record<string, unknown> {
  switch (command) {
    case 'stats':
      return { cmd: 'Stats' };
    case 'metrics':
      return { cmd: 'Prometheus' };
    case 'health':
      // Health uses the same Stats command - the output formatter handles it
      return { cmd: 'Stats' };
    case 'ping':
      return { cmd: 'Ping' };
    default:
      return { cmd: 'Stats' };
  }
}
