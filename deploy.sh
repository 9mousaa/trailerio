#!/bin/bash

# Deployment script for DigitalOcean VPS
# Usage: ./deploy.sh

set -e

echo "🚀 Starting deployment..."

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull

# Build and restart containers
echo "🔨 Building and starting containers..."
docker compose down
docker compose up -d --build

# Wait for containers to be healthy
echo "⏳ Waiting for containers to start..."
sleep 5

# Check if container is running
if docker compose ps | grep -q "Up"; then
    echo "✅ Deployment successful!"
    echo "🌐 Application should be available at:"
    echo "   - Direct: http://$(hostname -I | awk '{print $1}'):8081"
    echo "   - Via Nginx: Check your nginx configuration"
else
    echo "❌ Deployment failed. Check logs with: docker compose logs"
    exit 1
fi

# Show logs
echo "📋 Recent logs:"
docker compose logs --tail=20

