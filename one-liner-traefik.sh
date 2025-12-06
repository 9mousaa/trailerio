#!/bin/bash
# One-liner Traefik setup - copy this entire script and run on VPS

set -e
REPO="${1:-https://github.com/YOUR_USERNAME/trailerio.git}"
SUBDOMAIN="${2:-trailerio}"
DIR="/opt/trailerio"

# Install Docker if needed
command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)
docker compose version >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y docker-compose-plugin)

# Detect Traefik network
TRAEFIK_NET=$(docker inspect traefik 2>/dev/null | grep -oE 'NetworkMode": "[^"]+"' | cut -d'"' -f3 || docker network ls | grep traefik | head -1 | awk '{print $2}' || echo "traefik")
if [ "$TRAEFIK_NET" = "default" ] || [ -z "$TRAEFIK_NET" ]; then TRAEFIK_NET="traefik"; fi

# Clone/update
mkdir -p /opt && (cd /opt && ([ -d trailerio ] && (cd trailerio && git pull)) || git clone "$REPO" trailerio)

# Create docker-compose.yml
cd "$DIR" && cat > docker-compose.yml <<EOF
version: '3.8'
services:
  web:
    build: { context: ., dockerfile: Dockerfile }
    restart: unless-stopped
    environment: [NODE_ENV=production]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.trailerio.rule=Host(\`$SUBDOMAIN.plaio.cc\`)"
      - "traefik.http.routers.trailerio.entrypoints=web"
      - "traefik.http.routers.trailerio.entrypoints=websecure"
      - "traefik.http.routers.trailerio.tls.certresolver=letsencrypt"
      - "traefik.http.services.trailerio.loadbalancer.server.port=80"
    networks: [$TRAEFIK_NET]
networks:
  $TRAEFIK_NET: { external: true }
EOF

# Build and start
docker compose down 2>/dev/null; docker compose up -d --build
sleep 3
docker compose ps | grep -q Up && echo "✅ Done! Add DNS: $SUBDOMAIN -> $(hostname -I | awk '{print $1}')" || (echo "❌ Failed"; docker compose logs)

