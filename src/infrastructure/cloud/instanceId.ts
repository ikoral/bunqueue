/**
 * Instance ID Manager
 * Generates and persists a unique instance ID to disk
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const INSTANCE_ID_FILE = 'cloud-instance-id';

/** Load or generate a persistent instance ID */
export function getInstanceId(dataPath: string | null): string {
  if (!dataPath) return crypto.randomUUID();

  const dir = dirname(dataPath);
  const filePath = join(dir, INSTANCE_ID_FILE);

  try {
    if (existsSync(filePath)) {
      const id = readFileSync(filePath, 'utf-8').trim();
      if (id.length > 0) return id;
    }
  } catch {
    // Fall through to generate new ID
  }

  const id = crypto.randomUUID();

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, id, 'utf-8');
  } catch {
    // Non-fatal: use ephemeral ID if we can't persist
  }

  return id;
}
