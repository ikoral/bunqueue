/**
 * S3 Backup Operations
 * Core backup, restore, list, and cleanup operations
 */

import type { S3Client } from 'bun';
import { backupLog } from '../../shared/logger';
import { VERSION } from '../../shared/version';
import type { S3BackupConfig, BackupResult, BackupMetadata, BackupItem } from './s3BackupConfig';

/**
 * Perform a backup to S3
 */
export async function performBackup(
  config: S3BackupConfig,
  client: S3Client
): Promise<BackupResult> {
  const startTime = Date.now();

  try {
    // Check if database file exists
    const dbFile = Bun.file(config.databasePath);
    const exists = await dbFile.exists();

    if (!exists) {
      throw new Error(`Database file not found: ${config.databasePath}`);
    }

    // Generate backup key with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${config.prefix}bunqueue-${timestamp}.db`;

    // Read database file
    const data = await dbFile.arrayBuffer();
    const originalSize = data.byteLength;

    // Compress with gzip for efficient storage
    const compressed = Bun.gzipSync(new Uint8Array(data));
    const compressedSize = compressed.byteLength;

    // Calculate checksum of original data (for integrity verification)
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(data));
    const checksum = hasher.digest('hex');

    // Upload compressed backup to S3
    const s3File = client.file(key);
    await s3File.write(compressed, {
      type: 'application/gzip',
    });

    // Upload metadata
    const metadata: BackupMetadata = {
      timestamp: new Date().toISOString(),
      version: VERSION,
      size: originalSize,
      compressedSize,
      checksum,
      compressed: true,
    };

    const metadataKey = `${key}.meta.json`;
    await client.file(metadataKey).write(JSON.stringify(metadata, null, 2), {
      type: 'application/json',
    });

    const duration = Date.now() - startTime;

    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    backupLog.info('Backup completed', {
      key,
      size: `${(originalSize / 1024 / 1024).toFixed(2)} MB`,
      compressed: `${(compressedSize / 1024 / 1024).toFixed(2)} MB (${ratio}% saved)`,
      duration: `${duration}ms`,
      checksum: checksum.substring(0, 16) + '...',
    });

    return { success: true, key, size: originalSize, duration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    backupLog.error('Backup failed', { error: message });
    return { success: false, error: message };
  }
}

/**
 * List available backups
 */
export async function listBackups(config: S3BackupConfig, client: S3Client): Promise<BackupItem[]> {
  try {
    const result = await client.list({
      prefix: config.prefix,
      maxKeys: 100,
    });

    if (!result.contents) {
      return [];
    }

    return result.contents
      .filter(
        (item): item is typeof item & { key: string } =>
          typeof item.key === 'string' &&
          item.key.endsWith('.db') &&
          !item.key.endsWith('.meta.json')
      )
      .map((item) => {
        const lastMod = item.lastModified;
        const lastModDate = lastMod ? new Date(lastMod as Date | string) : new Date();
        return {
          key: item.key,
          size: item.size ?? 0,
          lastModified: lastModDate,
        };
      })
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  } catch (error) {
    backupLog.error('Failed to list backups', { error: String(error) });
    return [];
  }
}

/**
 * Restore from a backup
 */
export async function restoreBackup(
  key: string,
  config: S3BackupConfig,
  client: S3Client
): Promise<BackupResult> {
  const startTime = Date.now();

  try {
    // Verify backup exists
    const s3File = client.file(key);
    const exists = await s3File.exists();

    if (!exists) {
      throw new Error(`Backup not found: ${key}`);
    }

    // Download backup
    const compressedData = await s3File.arrayBuffer();

    // Check metadata to determine if backup is compressed
    const metadataKey = `${key}.meta.json`;
    const metadataFile = client.file(metadataKey);
    const metadataExists = await metadataFile.exists();
    let metadataRaw: BackupMetadata | null = null;

    if (metadataExists) {
      metadataRaw = (await metadataFile.json()) as BackupMetadata;
    }

    // Decompress if backup is compressed (new format) or try to detect gzip magic bytes
    const isCompressed =
      metadataRaw?.compressed ??
      (compressedData.byteLength >= 2 &&
        new Uint8Array(compressedData)[0] === 0x1f &&
        new Uint8Array(compressedData)[1] === 0x8b);

    const data = isCompressed
      ? Bun.gunzipSync(new Uint8Array(compressedData))
      : new Uint8Array(compressedData);

    // Verify checksum if metadata exists
    if (metadataRaw?.checksum) {
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(data);
      const checksum = hasher.digest('hex');

      if (checksum !== metadataRaw.checksum) {
        throw new Error('Backup checksum mismatch - file may be corrupted');
      }
    }

    // Write to database path
    await Bun.write(config.databasePath, data);

    const duration = Date.now() - startTime;

    backupLog.info('Restore completed', {
      key,
      size: `${(data.byteLength / 1024 / 1024).toFixed(2)} MB`,
      compressed: isCompressed
        ? `${(compressedData.byteLength / 1024 / 1024).toFixed(2)} MB`
        : 'no',
      duration: `${duration}ms`,
    });

    return { success: true, key, size: data.byteLength, duration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    backupLog.error('Restore failed', { error: message });
    return { success: false, error: message };
  }
}

/**
 * Clean up old backups based on retention policy
 */
export async function cleanupOldBackups(config: S3BackupConfig, client: S3Client): Promise<void> {
  try {
    const backups = await listBackups(config, client);

    if (backups.length <= config.retention) {
      return;
    }

    // Sort by date (newest first) and get backups to delete
    const toDelete = backups.slice(config.retention);

    for (const backup of toDelete) {
      try {
        // Delete backup file
        await client.delete(backup.key);

        // Delete metadata file if exists
        const metadataKey = `${backup.key}.meta.json`;
        const metadataFile = client.file(metadataKey);
        if (await metadataFile.exists()) {
          await client.delete(metadataKey);
        }

        backupLog.info('Deleted old backup', { key: backup.key });
      } catch (err) {
        backupLog.warn('Failed to delete old backup', {
          key: backup.key,
          error: String(err),
        });
      }
    }
  } catch (error) {
    backupLog.warn('Failed to cleanup old backups', { error: String(error) });
  }
}
