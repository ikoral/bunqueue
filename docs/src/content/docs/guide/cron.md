---
title: Cron Jobs
description: Schedule recurring jobs
---


Schedule jobs to run on a recurring basis using cron expressions or intervals.

## Server Mode

```bash
# Add a cron job
bunqueue cron add daily-report \
  -q reports \
  -d '{"type":"daily"}' \
  -s "0 9 * * *"

# List cron jobs
bunqueue cron list

# Delete
bunqueue cron delete daily-report
```

## Cron Expressions

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *
```

Examples:
- `0 9 * * *` - Every day at 9:00 AM
- `*/15 * * * *` - Every 15 minutes
- `0 0 * * MON` - Every Monday at midnight
- `0 0 1 * *` - First day of every month

## Interval-Based

```bash
# Every 5 minutes
bunqueue cron add heartbeat \
  -q system \
  -d '{"check":"health"}' \
  -e 300000
```

## Embedded Mode (Repeatable Jobs)

```typescript
await queue.add('report', { type: 'daily' }, {
  repeat: {
    pattern: '0 9 * * *',
  }
});

// Or interval-based
await queue.add('heartbeat', {}, {
  repeat: {
    every: 60000,  // Every minute
    limit: 100,    // Max 100 executions
  }
});
```
