/**
 * S3 Backup Module
 * Automated database backup to S3-compatible storage
 *
 * Supports: AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, etc.
 */

import { S3Client } from 'bun';
import { backupLog } from '../../shared/logger';

/** S3 Backup configuration */
export interface S3BackupConfig {
  /** Enable S3 backup */
  enabled: boolean;
  /** S3 access key ID */
  accessKeyId: string;
  /** S3 secret access key */
  secretAccessKey: string;
  /** S3 bucket name */
  bucket: string;
  /** S3 endpoint (optional, for non-AWS S3-compatible services) */
  endpoint?: string;
  /** S3 region (optional, default: us-east-1) */
  region?: string;
  /** Backup interval in milliseconds (default: 6 hours) */
  intervalMs: number;
  /** Number of backups to retain (default: 7) */
  retention: number;
  /** Prefix for backup files (default: 'backups/') */
  prefix: string;
  /** Path to the SQLite database file */
  databasePath: string;
}

/** Backup result */
export interface BackupResult {
  success: boolean;
  key?: string;
  size?: number;
  duration?: number;
  error?: string;
}

/** Backup metadata stored in S3 */
interface BackupMetadata {
  timestamp: string;
  version: string;
  size: number;
  checksum: string;
}

/** Default configuration values */
const DEFAULTS = {
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  retention: 7,
  prefix: 'backups/',
  region: 'us-east-1',
} as const;

/**
 * S3 Backup Manager
 * Handles automated and manual backups to S3-compatible storage
 */
export class S3BackupManager {
  private readonly config: S3BackupConfig;
  private readonly client: S3Client;
  private backupInterval: ReturnType<typeof setInterval> | null = null;
  private initialBackupTimeout: ReturnType<typeof setTimeout> | null = null;
  private isBackupInProgress = false;

  constructor(config: Partial<S3BackupConfig> & { databasePath: string }) {
    this.config = {
      enabled: config.enabled ?? false,
      accessKeyId: config.accessKeyId ?? '',
      secretAccessKey: config.secretAccessKey ?? '',
      bucket: config.bucket ?? '',
      endpoint: config.endpoint,
      region: config.region ?? DEFAULTS.region,
      intervalMs: config.intervalMs ?? DEFAULTS.intervalMs,
      retention: config.retention ?? DEFAULTS.retention,
      prefix: config.prefix ?? DEFAULTS.prefix,
      databasePath: config.databasePath,
    };

    // Initialize S3 client
    this.client = new S3Client({
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint,
      region: this.config.region,
    });
  }

  /**
   * Create configuration from environment variables
   */
  static fromEnv(databasePath: string): S3BackupConfig {
    return {
      enabled: process.env.S3_BACKUP_ENABLED === '1' || process.env.S3_BACKUP_ENABLED === 'true',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? '',
      bucket: process.env.S3_BUCKET ?? process.env.AWS_BUCKET ?? '',
      endpoint: process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT,
      region: process.env.S3_REGION ?? process.env.AWS_REGION ?? DEFAULTS.region,
      intervalMs: parseInt(process.env.S3_BACKUP_INTERVAL ?? '', 10) || DEFAULTS.intervalMs,
      retention: parseInt(process.env.S3_BACKUP_RETENTION ?? '', 10) || DEFAULTS.retention,
      prefix: process.env.S3_BACKUP_PREFIX ?? DEFAULTS.prefix,
      databasePath,
    };
  }

  /**
   * Validate configuration
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.accessKeyId) {
      errors.push('S3_ACCESS_KEY_ID is required');
    }
    if (!this.config.secretAccessKey) {
      errors.push('S3_SECRET_ACCESS_KEY is required');
    }
    if (!this.config.bucket) {
      errors.push('S3_BUCKET is required');
    }
    if (!this.config.databasePath) {
      errors.push('Database path is required');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Start automated backup scheduler
   */
  start(): void {
    if (!this.config.enabled) {
      backupLog.info('S3 backup disabled');
      return;
    }

    const validation = this.validate();
    if (!validation.valid) {
      backupLog.error('S3 backup configuration invalid', { errors: validation.errors });
      return;
    }

    backupLog.info('S3 backup scheduler started', {
      bucket: this.config.bucket,
      endpoint: this.config.endpoint ?? 'AWS S3',
      interval: `${Math.round(this.config.intervalMs / 1000 / 60)} minutes`,
      retention: this.config.retention,
    });

    // Run initial backup after 1 minute
    this.initialBackupTimeout = setTimeout(() => {
      this.initialBackupTimeout = null;
      this.backup().catch((err: unknown) => {
        backupLog.error('Initial backup failed', { error: String(err) });
      });
    }, 60 * 1000);

    // Schedule periodic backups
    this.backupInterval = setInterval(() => {
      this.backup().catch((err: unknown) => {
        backupLog.error('Scheduled backup failed', { error: String(err) });
      });
    }, this.config.intervalMs);
  }

  /**
   * Stop automated backup scheduler
   */
  stop(): void {
    if (this.initialBackupTimeout) {
      clearTimeout(this.initialBackupTimeout);
      this.initialBackupTimeout = null;
    }
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
    }
    backupLog.info('S3 backup scheduler stopped');
  }

  /**
   * Perform a backup
   */
  async backup(): Promise<BackupResult> {
    if (this.isBackupInProgress) {
      backupLog.warn('Backup already in progress, skipping');
      return { success: false, error: 'Backup already in progress' };
    }

    this.isBackupInProgress = true;
    const startTime = Date.now();

    try {
      // Check if database file exists
      const dbFile = Bun.file(this.config.databasePath);
      const exists = await dbFile.exists();

      if (!exists) {
        throw new Error(`Database file not found: ${this.config.databasePath}`);
      }

      // Generate backup key with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `${this.config.prefix}bunqueue-${timestamp}.db`;

      // Read database file
      const data = await dbFile.arrayBuffer();
      const size = data.byteLength;

      // Calculate checksum
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(new Uint8Array(data));
      const checksum = hasher.digest('hex');

      // Upload to S3
      const s3File = this.client.file(key);
      await s3File.write(new Uint8Array(data), {
        type: 'application/x-sqlite3',
      });

      // Upload metadata
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version ?? '1.0.0',
        size,
        checksum,
      };

      const metadataKey = `${key}.meta.json`;
      await this.client.file(metadataKey).write(JSON.stringify(metadata, null, 2), {
        type: 'application/json',
      });

      const duration = Date.now() - startTime;

      backupLog.info('Backup completed', {
        key,
        size: `${(size / 1024 / 1024).toFixed(2)} MB`,
        duration: `${duration}ms`,
        checksum: checksum.substring(0, 16) + '...',
      });

      // Clean up old backups
      await this.cleanupOldBackups();

      return { success: true, key, size, duration };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backupLog.error('Backup failed', { error: message });
      return { success: false, error: message };
    } finally {
      this.isBackupInProgress = false;
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    try {
      const result = await this.client.list({
        prefix: this.config.prefix,
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
          // Handle both Date and string types from S3 response
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
  async restore(key: string): Promise<BackupResult> {
    const startTime = Date.now();

    try {
      // Verify backup exists
      const s3File = this.client.file(key);
      const exists = await s3File.exists();

      if (!exists) {
        throw new Error(`Backup not found: ${key}`);
      }

      // Download backup
      const data = await s3File.arrayBuffer();

      // Verify checksum if metadata exists
      const metadataKey = `${key}.meta.json`;
      const metadataFile = this.client.file(metadataKey);
      const metadataExists = await metadataFile.exists();

      if (metadataExists) {
        const metadataRaw = (await metadataFile.json()) as BackupMetadata;
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(new Uint8Array(data));
        const checksum = hasher.digest('hex');

        if (checksum !== metadataRaw.checksum) {
          throw new Error('Backup checksum mismatch - file may be corrupted');
        }
      }

      // Write to database path
      await Bun.write(this.config.databasePath, new Uint8Array(data));

      const duration = Date.now() - startTime;

      backupLog.info('Restore completed', {
        key,
        size: `${(data.byteLength / 1024 / 1024).toFixed(2)} MB`,
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
  private async cleanupOldBackups(): Promise<void> {
    try {
      const backups = await this.listBackups();

      if (backups.length <= this.config.retention) {
        return;
      }

      // Sort by date (newest first) and get backups to delete
      const toDelete = backups.slice(this.config.retention);

      for (const backup of toDelete) {
        try {
          // Delete backup file
          await this.client.delete(backup.key);

          // Delete metadata file if exists
          const metadataKey = `${backup.key}.meta.json`;
          const metadataFile = this.client.file(metadataKey);
          if (await metadataFile.exists()) {
            await this.client.delete(metadataKey);
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

  /**
   * Get backup status
   */
  getStatus(): {
    enabled: boolean;
    bucket: string;
    endpoint: string;
    intervalMs: number;
    retention: number;
    isRunning: boolean;
  } {
    return {
      enabled: this.config.enabled,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint ?? 'AWS S3',
      intervalMs: this.config.intervalMs,
      retention: this.config.retention,
      isRunning: this.backupInterval !== null,
    };
  }
}
