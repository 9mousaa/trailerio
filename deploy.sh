#!/bin/bash
# One-liner deployment script for TrailerIO
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Deploying TrailerIO..."
echo ""

# Navigate to project directory
cd /opt/trailerio || { echo "❌ Error: /opt/trailerio not found"; exit 1; }

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull origin main || { echo "⚠️  Warning: git pull failed, continuing anyway..."; }

# Build and deploy
echo "🔨 Building and deploying..."
DOCKER_BUILDKIT=1 docker compose build --no-cache backend web || { echo "❌ Build failed"; exit 1; }

# Stop old containers gracefully
echo "🛑 Stopping old containers..."
docker compose down --timeout 30 || true

# Start new containers
echo "▶️  Starting new containers..."
DOCKER_BUILDKIT=1 docker compose up -d || { echo "❌ Failed to start containers"; exit 1; }

# Wait for health checks
echo "⏳ Waiting for services to be healthy..."
sleep 5

# Check health
echo "🏥 Checking service health..."
for i in {1..30}; do
  if curl -f -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ Backend is healthy!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "⚠️  Warning: Backend health check failed after 30 attempts"
    echo "📋 Showing logs..."
    docker compose logs backend --tail 50
    exit 1
  fi
  sleep 2
done

# Check manifest endpoint
echo "📋 Checking manifest endpoint..."
if curl -f -s http://localhost:3001/manifest.json > /dev/null 2>&1; then
  echo "✅ Manifest endpoint is working!"
else
  echo "⚠️  Warning: Manifest endpoint check failed"
fi

# Show status
echo ""
echo "📊 Container status:"
docker compose ps

echo ""
echo "✅ Deployment complete!"
echo "📝 View logs: docker compose logs -f"
echo "🏥 Health check: curl http://localhost:3001/health"
echo "📋 Manifest: curl http://localhost:3001/manifest.json"

