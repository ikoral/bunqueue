---
title: S3 Backup
description: Automated backups to S3-compatible storage
---

# S3 Backup

Automated backups to any S3-compatible storage.

## Configuration

```bash
# Environment variables
S3_BACKUP_ENABLED=1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=my-backups
S3_REGION=us-east-1
S3_BACKUP_INTERVAL=21600000  # 6 hours
S3_BACKUP_RETENTION=7         # Keep 7 backups
S3_BACKUP_PREFIX=bunqueue/
```

## Supported Providers

| Provider | Endpoint |
|----------|----------|
| AWS S3 | (default) |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` |
| MinIO | `http://localhost:9000` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` |

## CLI Commands

```bash
# Create backup now
bunqueue backup now

# List backups
bunqueue backup list

# Restore from backup
bunqueue backup restore <key>
bunqueue backup restore <key> -f  # Force overwrite

# Check status
bunqueue backup status
```

## Backup Contents

Each backup includes:
- SQLite database (all jobs, cron, DLQ)
- WAL file (if exists)
- Metadata (timestamp, version)
