#!/bin/bash

echo "=========================================="
echo "502 Error Debugging Script"
echo "=========================================="
echo ""

echo "1. Checking backend container status..."
docker ps -a | grep backend || echo "  ✗ Backend container not found"
echo ""

echo "2. Checking if backend container is running..."
if docker ps | grep -q backend; then
  echo "  ✓ Backend container is running"
else
  echo "  ✗ Backend container is NOT running"
  echo ""
  echo "  Checking why it stopped..."
  docker compose logs backend --tail=50
  exit 1
fi
echo ""

echo "3. Checking backend logs (last 50 lines)..."
docker compose logs backend --tail=50
echo ""

echo "4. Checking if backend is listening on port 3001..."
if docker exec trailerio-backend-1 netstat -tlnp 2>/dev/null | grep -q ":3001"; then
  echo "  ✓ Backend is listening on port 3001"
elif docker exec trailerio-backend-1 ss -tlnp 2>/dev/null | grep -q ":3001"; then
  echo "  ✓ Backend is listening on port 3001"
else
  echo "  ✗ Backend is NOT listening on port 3001"
  echo "  This means the server didn't start properly"
fi
echo ""

echo "5. Testing backend health endpoint from inside container..."
if docker exec trailerio-backend-1 wget -qO- http://localhost:3001/health 2>/dev/null; then
  echo "  ✓ Backend health endpoint responds"
else
  echo "  ✗ Backend health endpoint does NOT respond"
  echo "  Trying with curl..."
  docker exec trailerio-backend-1 curl -s http://localhost:3001/health || echo "  ✗ Backend not responding at all"
fi
echo ""

echo "6. Testing backend from host network..."
if curl -s http://localhost:3001/health 2>/dev/null; then
  echo "  ✓ Backend accessible from host"
else
  echo "  ✗ Backend NOT accessible from host"
  echo "  This could be a network configuration issue"
fi
echo ""

echo "7. Checking Traefik routing..."
if docker ps | grep -q traefik; then
  echo "  Traefik container found, checking logs..."
  docker logs traefik --tail=30 2>/dev/null || echo "  Could not read Traefik logs"
else
  echo "  Traefik not found in containers (might be running as service)"
fi
echo ""

echo "8. Checking backend container resource usage..."
docker stats trailerio-backend-1 --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"
echo ""

echo "9. Checking for recent errors in backend logs..."
docker compose logs backend --since=5m | grep -i "error\|exception\|crash\|fatal" || echo "  No recent errors found"
echo ""

echo "10. Testing a simple request to backend..."
echo "  Making request to /health endpoint..."
docker exec trailerio-backend-1 wget -qO- --timeout=5 http://localhost:3001/health 2>&1 || echo "  ✗ Request failed or timed out"
echo ""

echo "=========================================="
echo "Debugging complete!"
echo "=========================================="

