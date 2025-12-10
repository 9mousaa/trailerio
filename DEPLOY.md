# 🚀 One-Liner Deployment

## Quick Deploy Command

```bash
cd /opt/trailerio && git pull && DOCKER_BUILDKIT=1 docker compose build backend web && docker compose down --timeout 30 && DOCKER_BUILDKIT=1 docker compose up -d && sleep 5 && curl -f http://localhost:3001/health && echo "✅ Deployment successful!"
```

## Or Use the Deploy Script

```bash
cd /opt/trailerio && ./deploy.sh
```

## ✅ Uptime Guarantees

### 1. **Always Restart Policy**
- All services use `restart: always` (not `unless-stopped`)
- Containers automatically restart on any failure
- Docker will keep trying until service is healthy

### 2. **Health Checks**
- Backend health check: `/health` endpoint every 30s
- Web service waits for backend to be healthy before starting
- Docker automatically restarts unhealthy containers

### 3. **Manifest Endpoint Protection**
- Manifest endpoint (`/manifest.json`) is:
  - Skipped from request queue (always available)
  - Has proper cache headers
  - Never blocks on other requests
  - Always returns immediately

### 4. **Error Handling**
- Global error handlers prevent crashes
- Uncaught exceptions don't kill the server
- Unhandled rejections are logged but don't crash
- Database errors are handled gracefully

### 5. **Graceful Shutdown**
- 30-second timeout for graceful shutdown
- In-flight requests complete before restart
- No data loss during updates

## 🔍 Troubleshooting

### Check Service Status
```bash
docker compose ps
```

### View Logs
```bash
docker compose logs -f backend
```

### Check Health
```bash
curl http://localhost:3001/health
curl http://localhost:3001/manifest.json
```

### Force Restart
```bash
docker compose restart backend
```

### Check Why Service is Down
```bash
docker compose logs backend --tail 100
docker inspect trailerio-backend-1 | grep -A 10 State
```

## 📊 Monitoring

The `/health` endpoint provides:
- Service status
- Memory usage
- Cache statistics
- Request statistics
- Uptime

Access it at: `http://localhost:3001/health`
