# bunqueue MCP Server

bunqueue includes a native MCP (Model Context Protocol) server for AI agent integration. 73 tools, 5 resources, 3 diagnostic prompts.

## Setup

### Claude Code (claude_desktop_config.json or .mcp.json)

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "npx",
      "args": ["bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "embedded",
        "DATA_PATH": "./data/bunq.db"
      }
    }
  }
}
```

### TCP Mode (connect to remote server)

```json
{
  "mcpServers": {
    "bunqueue": {
      "command": "npx",
      "args": ["bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "tcp",
        "BUNQUEUE_HOST": "localhost",
        "BUNQUEUE_PORT": "6789",
        "BUNQUEUE_TOKEN": "secret"
      }
    }
  }
}
```

## Available Tools (73)

### Job Operations (11)
- `bunqueue_add_job` — Add a job to a queue
- `bunqueue_add_jobs_bulk` — Add multiple jobs at once
- `bunqueue_get_job` — Get job by ID
- `bunqueue_get_job_by_custom_id` — Get job by custom ID
- `bunqueue_get_job_state` — Get job state
- `bunqueue_get_job_result` — Get job result
- `bunqueue_cancel_job` — Cancel a job
- `bunqueue_promote_job` — Promote delayed job to waiting
- `bunqueue_update_progress` — Update job progress
- `bunqueue_get_children_values` — Get child job results
- `bunqueue_wait_for_job` — Wait for job to complete

### Job Management (6)
- `bunqueue_update_job_data` — Update job data
- `bunqueue_change_job_priority` — Change job priority
- `bunqueue_move_to_delayed` — Move job to delayed
- `bunqueue_discard_job` — Discard a job
- `bunqueue_get_progress` — Get job progress
- `bunqueue_change_delay` — Change job delay

### Job Consumption (8)
- `bunqueue_pull_job` — Pull a job for processing
- `bunqueue_pull_job_batch` — Pull multiple jobs
- `bunqueue_ack_job` — Acknowledge (complete) a job
- `bunqueue_ack_job_batch` — Batch acknowledge jobs
- `bunqueue_fail_job` — Fail a job
- `bunqueue_job_heartbeat` — Send heartbeat for active job
- `bunqueue_job_heartbeat_batch` — Batch heartbeats
- `bunqueue_extend_lock` — Extend job lock

### Queue Control (11)
- `bunqueue_list_queues` — List all queues
- `bunqueue_count_jobs` — Count jobs in queue
- `bunqueue_get_jobs` — Get jobs by state
- `bunqueue_get_job_counts` — Get job counts per state
- `bunqueue_pause_queue` — Pause a queue
- `bunqueue_resume_queue` — Resume a queue
- `bunqueue_drain_queue` — Remove all waiting jobs
- `bunqueue_obliterate_queue` — Delete everything
- `bunqueue_clean_queue` — Clean old jobs
- `bunqueue_is_paused` — Check if queue is paused
- `bunqueue_get_counts_per_priority` — Job counts per priority

### Dead Letter Queue (4)
- `bunqueue_get_dlq` — Get DLQ entries
- `bunqueue_retry_dlq` — Retry DLQ jobs
- `bunqueue_purge_dlq` — Purge DLQ
- `bunqueue_retry_completed` — Retry completed jobs

### Cron Jobs (4)
- `bunqueue_add_cron` — Schedule a cron job
- `bunqueue_list_crons` — List cron jobs
- `bunqueue_get_cron` — Get cron details
- `bunqueue_delete_cron` — Delete a cron job

### Rate Limiting & Concurrency (4)
- `bunqueue_set_rate_limit` — Set rate limit
- `bunqueue_clear_rate_limit` — Clear rate limit
- `bunqueue_set_concurrency` — Set concurrency limit
- `bunqueue_clear_concurrency` — Clear concurrency limit

### Webhooks (4)
- `bunqueue_add_webhook` — Register a webhook
- `bunqueue_remove_webhook` — Remove a webhook
- `bunqueue_list_webhooks` — List all webhooks
- `bunqueue_set_webhook_enabled` — Enable/disable webhook

### Workers (3)
- `bunqueue_register_worker` — Register a worker
- `bunqueue_unregister_worker` — Unregister a worker
- `bunqueue_worker_heartbeat` — Worker heartbeat

### Monitoring (11)
- `bunqueue_get_stats` — Global server stats
- `bunqueue_get_queue_stats` — Stats for one queue
- `bunqueue_list_workers` — List active workers
- `bunqueue_get_job_logs` — Get job logs
- `bunqueue_add_job_log` — Add log entry
- `bunqueue_get_storage_status` — SQLite storage status
- `bunqueue_get_per_queue_stats` — Per-queue metrics
- `bunqueue_get_memory_stats` — Memory usage
- `bunqueue_get_prometheus_metrics` — Prometheus format
- `bunqueue_clear_job_logs` — Clear logs
- `bunqueue_compact_memory` — Force memory compaction

### Workflows (4)
- `bunqueue_add_flow` — Create parent-child flow
- `bunqueue_add_flow_chain` — Create sequential chain
- `bunqueue_add_flow_bulk_then` — Fan-out flow
- `bunqueue_get_flow` — Get flow tree

### HTTP Handlers (3)
- `bunqueue_register_handler` — Auto-process jobs via HTTP
- `bunqueue_unregister_handler` — Remove handler
- `bunqueue_list_handlers` — List active handlers

## Resources (Read-Only)

| URI | Description |
|-----|-------------|
| `bunqueue://stats` | Global server statistics |
| `bunqueue://queues` | All queues with job counts |
| `bunqueue://crons` | Scheduled cron jobs |
| `bunqueue://workers` | Active workers |
| `bunqueue://webhooks` | Registered webhooks |

## Diagnostic Prompts

| Prompt | Description |
|--------|-------------|
| `bunqueue_health_report` | Comprehensive health check with severity levels |
| `bunqueue_debug_queue` | Deep diagnostic of a specific queue |
| `bunqueue_incident_response` | Step-by-step triage playbook |

## Agent Workflow Example

An AI agent can use bunqueue MCP to:

1. **Create a job**: `bunqueue_add_job` with queue, name, data
2. **Wait for result**: `bunqueue_wait_for_job` with jobId
3. **Check progress**: `bunqueue_get_progress` during processing
4. **Handle failures**: `bunqueue_get_dlq` to inspect failed jobs
5. **Monitor health**: `bunqueue_get_stats` for system overview

Or use HTTP handlers for autonomous processing:

1. **Register handler**: `bunqueue_register_handler` with queue and endpoint URL
2. **Add jobs**: `bunqueue_add_job` — they auto-process via HTTP to your endpoint
3. **Check results**: `bunqueue_get_job_result` to see HTTP responses
