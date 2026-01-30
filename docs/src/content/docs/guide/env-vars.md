---
title: Environment Variables
description: Complete reference for bunqueue environment variables
---


bunqueue can be configured through environment variables.

## Server Configuration

### `TCP_PORT`

TCP server port for client connections.

| Type | Default | Example |
|------|---------|---------|
| number | `6789` | `6789` |

```bash
TCP_PORT=6789 bunqueue start
```

### `HTTP_PORT`

HTTP server port for REST API and metrics.

| Type | Default | Example |
|------|---------|---------|
| number | `6790` | `6790` |

```bash
HTTP_PORT=6790 bunqueue start
```

### `DATA_PATH`

Path to SQLite database file.

| Type | Default | Example |
|------|---------|---------|
| string | `./data/bunq.db` | `/var/lib/bunqueue/queue.db` |

```bash
DATA_PATH=/var/lib/bunqueue/queue.db bunqueue start
```

### `AUTH_TOKENS`

Comma-separated list of authentication tokens.

| Type | Default | Example |
|------|---------|---------|
| string | (none) | `token1,token2,token3` |

```bash
AUTH_TOKENS=secret-token-1,secret-token-2 bunqueue start
```

When set, all TCP and HTTP requests must include a valid token:

```bash
# TCP client
bunqueue push emails '{"to":"test@example.com"}' --token secret-token-1

# HTTP API
curl -H "Authorization: Bearer secret-token-1" http://localhost:6790/api/queues
```

## Logging

### `LOG_LEVEL`

Minimum log level to output.

| Type | Default | Values |
|------|---------|--------|
| string | `info` | `debug`, `info`, `warn`, `error` |

```bash
LOG_LEVEL=debug bunqueue start
```

### `LOG_FORMAT`

Log output format.

| Type | Default | Values |
|------|---------|--------|
| string | `text` | `text`, `json` |

```bash
LOG_FORMAT=json bunqueue start
```

JSON format output:
```json
{"level":"info","msg":"Server started","tcp":6789,"http":6790,"ts":"2024-01-15T10:30:00Z"}
```

## S3 Backup Configuration

### `S3_BACKUP_ENABLED`

Enable automated S3 backups.

| Type | Default | Values |
|------|---------|--------|
| boolean | `false` | `0`, `1`, `false`, `true` |

```bash
S3_BACKUP_ENABLED=1 bunqueue start
```

### `S3_ACCESS_KEY_ID`

S3 access key for authentication.

| Type | Default | Aliases |
|------|---------|---------|
| string | (none) | `AWS_ACCESS_KEY_ID` |

```bash
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE bunqueue start
```

### `S3_SECRET_ACCESS_KEY`

S3 secret key for authentication.

| Type | Default | Aliases |
|------|---------|---------|
| string | (none) | `AWS_SECRET_ACCESS_KEY` |

```bash
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY bunqueue start
```

### `S3_BUCKET`

S3 bucket name for backups.

| Type | Default | Aliases |
|------|---------|---------|
| string | (none) | `AWS_BUCKET` |

```bash
S3_BUCKET=my-bunqueue-backups bunqueue start
```

### `S3_REGION`

AWS region for S3 bucket.

| Type | Default | Aliases |
|------|---------|---------|
| string | `us-east-1` | `AWS_REGION` |

```bash
S3_REGION=eu-west-1 bunqueue start
```

### `S3_ENDPOINT`

Custom S3 endpoint for non-AWS providers.

| Type | Default | Example |
|------|---------|---------|
| string | (none) | `https://account.r2.cloudflarestorage.com` |

```bash
# Cloudflare R2
S3_ENDPOINT=https://abc123.r2.cloudflarestorage.com bunqueue start

# MinIO
S3_ENDPOINT=http://localhost:9000 bunqueue start

# DigitalOcean Spaces
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com bunqueue start
```

### `S3_BACKUP_INTERVAL`

Interval between automated backups (milliseconds).

| Type | Default | Example |
|------|---------|---------|
| number | `21600000` (6 hours) | `3600000` (1 hour) |

```bash
S3_BACKUP_INTERVAL=3600000 bunqueue start
```

### `S3_BACKUP_RETENTION`

Number of backups to keep.

| Type | Default | Example |
|------|---------|---------|
| number | `7` | `30` |

```bash
S3_BACKUP_RETENTION=30 bunqueue start
```

### `S3_BACKUP_PREFIX`

Prefix for backup files in S3.

| Type | Default | Example |
|------|---------|---------|
| string | `backups/` | `bunqueue/prod/` |

```bash
S3_BACKUP_PREFIX=bunqueue/production/ bunqueue start
```

## Complete Examples

### Development

```bash
# .env.development
TCP_PORT=6789
HTTP_PORT=6790
DATA_PATH=./data/dev.db
LOG_LEVEL=debug
LOG_FORMAT=text
```

### Production

```bash
# .env.production
TCP_PORT=6789
HTTP_PORT=6790
DATA_PATH=/var/lib/bunqueue/production.db
LOG_LEVEL=info
LOG_FORMAT=json
AUTH_TOKENS=prod-token-abc123,prod-token-xyz789

# S3 Backup
S3_BACKUP_ENABLED=1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=company-bunqueue-backups
S3_REGION=us-east-1
S3_BACKUP_INTERVAL=3600000
S3_BACKUP_RETENTION=30
S3_BACKUP_PREFIX=production/
```

### Docker Compose

```yaml
version: '3.8'

services:
  bunqueue:
    image: bunqueue:latest
    ports:
      - "6789:6789"
      - "6790:6790"
    volumes:
      - bunqueue-data:/data
    environment:
      - TCP_PORT=6789
      - HTTP_PORT=6790
      - DATA_PATH=/data/queue.db
      - LOG_LEVEL=info
      - LOG_FORMAT=json
      - AUTH_TOKENS=${AUTH_TOKENS}
      - S3_BACKUP_ENABLED=1
      - S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
      - S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
      - S3_BUCKET=${S3_BUCKET}
      - S3_REGION=${S3_REGION}
      - S3_BACKUP_INTERVAL=21600000
      - S3_BACKUP_RETENTION=7

volumes:
  bunqueue-data:
```

### Kubernetes

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: bunqueue-config
data:
  TCP_PORT: "6789"
  HTTP_PORT: "6790"
  DATA_PATH: "/data/queue.db"
  LOG_LEVEL: "info"
  LOG_FORMAT: "json"
  S3_BACKUP_ENABLED: "1"
  S3_REGION: "us-east-1"
  S3_BACKUP_INTERVAL: "21600000"
  S3_BACKUP_RETENTION: "7"
  S3_BACKUP_PREFIX: "kubernetes/"

---
apiVersion: v1
kind: Secret
metadata:
  name: bunqueue-secrets
type: Opaque
stringData:
  AUTH_TOKENS: "your-production-token"
  S3_ACCESS_KEY_ID: "your-access-key"
  S3_SECRET_ACCESS_KEY: "your-secret-key"
  S3_BUCKET: "your-bucket"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bunqueue
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bunqueue
  template:
    metadata:
      labels:
        app: bunqueue
    spec:
      containers:
        - name: bunqueue
          image: bunqueue:latest
          ports:
            - containerPort: 6789
            - containerPort: 6790
          envFrom:
            - configMapRef:
                name: bunqueue-config
            - secretRef:
                name: bunqueue-secrets
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: bunqueue-pvc
```

## Precedence

Environment variables take precedence in this order:

1. Command-line arguments (highest)
2. Environment variables
3. Configuration file
4. Default values (lowest)

```bash
# Command-line wins
TCP_PORT=6789 bunqueue start --tcp-port 7000
# Uses port 7000
```
