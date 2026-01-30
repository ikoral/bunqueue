---
title: Troubleshooting
description: Common issues and solutions
---

# Troubleshooting

Solutions to common issues when using bunqueue.

## Installation Issues

### "bunqueue requires Bun runtime"

bunqueue only works with Bun, not Node.js.

```bash
# Check if Bun is installed
bun --version

# Install Bun if needed
curl -fsSL https://bun.sh/install | bash
```

### Permission errors on install

```bash
# Try with sudo (not recommended)
sudo bun add bunqueue

# Better: fix npm permissions
mkdir ~/.bun
chown -R $(whoami) ~/.bun
```

## Database Issues

### "SQLITE_BUSY: database is locked"

Multiple processes trying to write simultaneously.

**Solutions:**
1. Use WAL mode (default in bunqueue)
2. Ensure only one server instance per database file
3. Use server mode for multi-process access

```bash
# Check for multiple processes
lsof ./data/queue.db

# Kill stale processes
pkill -f bunqueue
```

### "SQLITE_CORRUPT: database disk image is malformed"

Database corruption, usually from crash during write.

**Solutions:**
1. Restore from S3 backup
2. Delete and recreate database (data loss)

```bash
# Restore from backup
bunqueue backup list
bunqueue backup restore <key> --force

# Or recreate (loses data)
rm ./data/queue.db*
bunqueue start
```

### Database file keeps growing

SQLite doesn't automatically reclaim space.

```bash
# Vacuum the database (run when server is stopped)
sqlite3 ./data/queue.db "VACUUM;"

# Enable auto-vacuum (before creating database)
sqlite3 ./data/queue.db "PRAGMA auto_vacuum = INCREMENTAL;"
```

## Job Processing Issues

### Jobs stuck in "active" state

Worker crashed while processing.

**Solutions:**
1. Enable stall detection
2. Restart workers

```typescript
queue.setStallConfig({
  enabled: true,
  stallInterval: 30000,
  maxStalls: 3,
});
```

### Jobs not being processed

**Check these:**
1. Is the queue paused?
2. Is there a worker for this queue?
3. Is rate limiting blocking jobs?

```typescript
// Check if paused
const isPaused = queue.isPaused();

// Check counts
const counts = queue.getJobCounts();
console.log(counts);

// Check rate limit
const config = queue.getRateLimit();
```

### Jobs failing immediately

Check the error in failed event:

```typescript
worker.on('failed', (job, error) => {
  console.error('Job failed:', error);
  console.error('Job data:', job.data);
  console.error('Attempts:', job.attemptsMade);
});
```

### Memory usage keeps growing

**Possible causes:**
1. Jobs not being removed after completion
2. Too many jobs in DLQ
3. Memory leak in processor

```typescript
// Enable removeOnComplete
await queue.add('task', data, {
  removeOnComplete: true,
});

// Purge old DLQ entries
queue.purgeDlq();

// Check for leaks in processor
worker.on('completed', () => {
  console.log('Memory:', process.memoryUsage().heapUsed);
});
```

## Connection Issues

### "Connection refused" to server

Server not running or wrong port.

```bash
# Check if server is running
ps aux | grep bunqueue

# Check listening ports
lsof -i :6789
lsof -i :6790

# Start server
bunqueue start
```

### TCP connection drops

Network issues or server overload.

```typescript
// Add reconnection logic
let client = createClient();

client.on('error', async () => {
  await sleep(1000);
  client = createClient();
});
```

### Authentication failures

```bash
# Check token is set
echo $AUTH_TOKENS

# Test with curl
curl -H "Authorization: Bearer your-token" \
  http://localhost:6790/health
```

## Performance Issues

### Slow job processing

**Optimize:**
1. Increase worker concurrency
2. Use batch operations
3. Check database I/O

```typescript
// Increase concurrency
const worker = new Worker('queue', processor, {
  concurrency: 20,
});

// Use bulk add
await queue.addBulk([...jobs]);

// Use bulk ack
await queue.ackBatch([...jobIds]);
```

### High latency on pull

**Check:**
1. Index on queue table
2. Too many delayed jobs
3. Database on slow disk

```sql
-- Check indexes exist
.indices jobs

-- Check delayed jobs count
SELECT COUNT(*) FROM jobs WHERE state = 'delayed';
```

### Server CPU at 100%

Too many connections or jobs.

```bash
# Check connection count
bunqueue stats

# Reduce polling frequency
# Add backoff in clients
```

## Backup Issues

### S3 backup failing

```bash
# Check credentials
echo $S3_ACCESS_KEY_ID
echo $S3_BUCKET

# Test connectivity
aws s3 ls s3://$S3_BUCKET/

# Check logs
bunqueue backup status
```

### Restore failing

```bash
# List available backups
bunqueue backup list

# Force restore (overwrites existing)
bunqueue backup restore <key> --force
```

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `SQLITE_BUSY` | Database locked | Use single writer |
| `SQLITE_FULL` | Disk full | Free disk space |
| `ECONNREFUSED` | Server not running | Start server |
| `ETIMEDOUT` | Network issue | Check connectivity |
| `Job not found` | Already completed/removed | Check job lifecycle |

## Debug Mode

Enable verbose logging:

```bash
# Server mode
LOG_FORMAT=json DEBUG=bunqueue:* bunqueue start

# Check logs
tail -f /var/log/bunqueue.log
```

## Getting Help

If these solutions don't help:

1. Check [GitHub Issues](https://github.com/egeominotti/bunqueue/issues)
2. Search [Discussions](https://github.com/egeominotti/bunqueue/discussions)
3. Open a new issue with:
   - bunqueue version
   - Bun version
   - OS and hardware
   - Error message and stack trace
   - Minimal reproduction code
