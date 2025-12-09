#!/bin/bash
# Update and restart TrailerIO services
# This script preserves TMDB key and rebuilds/restarts services

set -e

cd /opt/trailerio || exit 1

# Preserve TMDB key
TMDB_KEY=$(grep "^TMDB_API_KEY=" .env 2>/dev/null | cut -d= -f2)

# Stash local changes, pull updates
git stash
git pull

# Restore TMDB key
echo "TMDB_API_KEY=${TMDB_KEY:-bfe73358661a995b992ae9a812aa0d2f}" > .env

# Rebuild and restart services
echo "Building and starting services..."
DOCKER_BUILDKIT=1 docker compose up -d --build

# Note: Traefik automatically picks up Docker label changes, no restart needed
# If you need to restart Traefik manually, do it separately:
# docker restart traefik

echo "✓ Services updated and restarted"
echo "View logs with: docker compose logs -f backend"

