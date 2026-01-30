---
title: Server Mode
description: Running bunqueue as a standalone server
---


Run bunqueue as a standalone server with HTTP and TCP APIs.

## Starting the Server

```bash
# Default ports (TCP: 6789, HTTP: 6790)
bunqueue

# With custom configuration
bunqueue start \
  --tcp-port 6789 \
  --http-port 6790 \
  --data-path ./data/queue.db

# With authentication
AUTH_TOKENS=secret1,secret2 bunqueue
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_PORT` | `6789` | TCP server port |
| `HTTP_PORT` | `6790` | HTTP server port |
| `HOST` | `0.0.0.0` | Server hostname |
| `DATA_PATH` | (memory) | SQLite database path |
| `AUTH_TOKENS` | (none) | Comma-separated auth tokens |
| `CORS_ALLOW_ORIGIN` | `*` | CORS allowed origins |
| `LOG_FORMAT` | `text` | Log format (text/json) |

## Docker

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY . .
EXPOSE 6789 6790
CMD ["bun", "run", "src/main.ts"]
```

```bash
docker build -t bunqueue .
docker run -p 6789:6789 -p 6790:6790 \
  -v ./data:/app/data \
  -e DATA_PATH=/app/data/queue.db \
  bunqueue
```

## Graceful Shutdown

The server handles `SIGINT` and `SIGTERM`:

1. Stops accepting new connections
2. Waits for active jobs to complete (30s timeout)
3. Flushes data to disk
4. Exits cleanly
