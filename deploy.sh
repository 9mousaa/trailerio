#!/bin/bash
# One-liner deployment script for TrailerIO
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Deploying TrailerIO..."
echo ""

# Navigate to project directory
cd /opt/trailerio || { echo "❌ Error: /opt/trailerio not found"; exit 1; }

# Pull latest changes (handle .env conflicts)
echo "📥 Pulling latest changes..."

# Remove .env from git tracking if it's tracked (it should never be in git)
if git ls-files --error-unmatch .env > /dev/null 2>&1; then
  echo "⚠️  .env is tracked in git (shouldn't be). Removing from tracking..."
  git rm --cached .env 2>/dev/null || true
  if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
    echo ".env" >> .gitignore
    git add .gitignore
  fi
  git commit -m "Remove .env from git tracking" 2>/dev/null || true
fi

# Stash .env if it has local changes, then pull
if git diff --quiet .env 2>/dev/null 2>&1; then
  # No local changes to .env, safe to pull
  git pull origin main || { echo "⚠️  Warning: git pull failed, continuing anyway..."; }
else
  # .env has local changes, stash them first
  echo "💾 Stashing local .env changes..."
  git stash push -m "Stash .env before deploy $(date +%Y%m%d-%H%M%S)" .env 2>/dev/null || true
  git pull origin main || { 
    echo "⚠️  Warning: git pull failed, checking for merge conflicts...";
    # If there's a merge conflict in .env, resolve it by keeping local version
    if git status --porcelain | grep -q "^UU.*\.env$"; then
      echo "🔧 Resolving .env merge conflict (keeping local version)...";
      git checkout --ours .env 2>/dev/null || true;
      git add .env 2>/dev/null || true;
      git commit -m "Resolve .env merge conflict - keep local version" 2>/dev/null || true;
    fi
  }
  echo "📦 Restoring local .env changes..."
  git stash pop 2>/dev/null || {
    # If stash pop fails due to conflicts, resolve by keeping local
    if git status --porcelain | grep -q "^UU.*\.env$"; then
      echo "🔧 Resolving .env stash conflict (keeping local version)...";
      git checkout --ours .env 2>/dev/null || true;
      git add .env 2>/dev/null || true;
      git reset HEAD .env 2>/dev/null || true;  # Unstage but keep changes
    fi
  }
fi

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

# Check health (from inside container or via exposed port)
echo "🏥 Checking service health..."
for i in {1..30}; do
  # Try checking from inside container first (more reliable)
  if docker exec trailerio-backend-1 curl -f -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ Backend is healthy!"
    break
  # Fallback: try from host if port is exposed
  elif curl -f -s http://localhost:3001/health > /dev/null 2>&1; then
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
if docker exec trailerio-backend-1 curl -f -s http://localhost:3001/manifest.json > /dev/null 2>&1; then
  echo "✅ Manifest endpoint is working!"
elif curl -f -s http://localhost:3001/manifest.json > /dev/null 2>&1; then
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

