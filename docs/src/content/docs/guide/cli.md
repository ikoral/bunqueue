---
title: CLI Commands
description: Command-line interface reference
---

# CLI Commands

bunqueue includes a powerful CLI for server management and job operations.

## Core Operations

```bash
# Push a job
bunqueue push <queue> <json> [--priority N] [--delay ms]

# Pull a job
bunqueue pull <queue> [--timeout ms]

# Acknowledge completion
bunqueue ack <id> [--result json]

# Mark as failed
bunqueue fail <id> [--error message]
```

## Job Management

```bash
# Get job info
bunqueue job get <id>
bunqueue job state <id>
bunqueue job result <id>

# Control jobs
bunqueue job cancel <id>
bunqueue job promote <id>
bunqueue job discard <id>

# Update job
bunqueue job progress <id> <0-100> [--message msg]
bunqueue job priority <id> <priority>
bunqueue job delay <id> <ms>

# Logs
bunqueue job logs <id>
bunqueue job log <id> <message> [--level info|warn|error]
```

## Queue Control

```bash
bunqueue queue list
bunqueue queue pause <queue>
bunqueue queue resume <queue>
bunqueue queue drain <queue>
bunqueue queue obliterate <queue>
bunqueue queue clean <queue> --grace <ms> [--state S]
bunqueue queue jobs <queue> [--state S] [--limit N]
```

## DLQ Operations

```bash
bunqueue dlq list <queue>
bunqueue dlq retry <queue> [--id <job-id>]
bunqueue dlq purge <queue>
```

## Cron Jobs

```bash
bunqueue cron list
bunqueue cron add <name> -q <queue> -d <json> [-s "cron"] [-e ms]
bunqueue cron delete <name>
```

## Rate Limiting

```bash
bunqueue rate-limit set <queue> <limit>
bunqueue rate-limit clear <queue>
bunqueue concurrency set <queue> <limit>
bunqueue concurrency clear <queue>
```

## Monitoring

```bash
bunqueue stats
bunqueue metrics   # Prometheus format
bunqueue health
```

## Backup

```bash
bunqueue backup now
bunqueue backup list
bunqueue backup restore <key> [-f]
bunqueue backup status
```

## Global Options

| Option | Description |
|--------|-------------|
| `-H, --host` | Server host (default: localhost) |
| `-p, --port` | TCP port (default: 6789) |
| `-t, --token` | Auth token |
| `--json` | Output as JSON |
| `--help` | Show help |
| `--version` | Show version |
