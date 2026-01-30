/**
 * Package version - dynamically read from package.json
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

interface PackageJson {
  version?: string;
}

function getVersion(): string {
  try {
    // Try to read from package.json in different possible locations
    const paths = [
      join(dirname(import.meta.dir), '..', 'package.json'),
      join(process.cwd(), 'package.json'),
    ];

    for (const path of paths) {
      try {
        const pkg = JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
        if (pkg.version) return pkg.version;
      } catch {
        // Try next path
      }
    }
  } catch {
    // Fallback
  }
  return '1.6.0'; // Fallback version
}

export const VERSION = getVersion();
