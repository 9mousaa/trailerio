#!/bin/bash

# One-liner setup script for trailerio with Traefik
# Automatically detects Traefik network and configures everything

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🚀 Trailerio Setup with Traefik${NC}"
echo "=================================="
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use sudo)${NC}"
    exit 1
fi

# Configuration
INSTALL_DIR="/opt/trailerio"
REPO_URL="${1:-}"
SUBDOMAIN="${2:-trailerio}"

if [ -z "$REPO_URL" ]; then
    if [ -d "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/.git" ]; then
        REPO_URL=$(cd "$INSTALL_DIR" && git remote get-url origin 2>/dev/null || echo "")
    fi
    
    if [ -z "$REPO_URL" ]; then
        echo -e "${YELLOW}⚠️  Usage: $0 <git-repo-url> [subdomain]${NC}"
        echo "Example: $0 https://github.com/user/trailerio.git trailerio"
        exit 1
    fi
fi

echo -e "${GREEN}📋 Configuration:${NC}"
echo "  Repository: $REPO_URL"
echo "  Install dir: $INSTALL_DIR"
echo "  Subdomain: $SUBDOMAIN.plaio.cc"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}📦 Installing Docker...${NC}"
    curl -fsSL https://get.docker.com | sh
fi

# Check Docker Compose
if ! docker compose version &> /dev/null 2>&1; then
    echo -e "${YELLOW}📦 Installing Docker Compose...${NC}"
    apt-get update -qq
    apt-get install -y docker-compose-plugin
fi

# Detect Traefik network
echo -e "${YELLOW}🔍 Detecting Traefik network...${NC}"
TRAEFIK_NETWORK=$(docker inspect traefik 2>/dev/null | grep -A 20 "Networks" | grep -oE '"[^"]+"' | head -1 | tr -d '"' || echo "plaio_default")

# If detection failed, try alternative method
if [ -z "$TRAEFIK_NETWORK" ] || [ "$TRAEFIK_NETWORK" = "default" ]; then
    TRAEFIK_NETWORK=$(docker inspect traefik 2>/dev/null | grep -oE 'NetworkMode": "[^"]+"' | cut -d'"' -f3 || echo "plaio_default")
fi

# Default to plaio_default if still not found
if [ -z "$TRAEFIK_NETWORK" ] || [ "$TRAEFIK_NETWORK" = "default" ]; then
    TRAEFIK_NETWORK="plaio_default"
fi

echo -e "${GREEN}✅ Using Traefik network: $TRAEFIK_NETWORK${NC}"

# Clone or update repo
mkdir -p "$(dirname $INSTALL_DIR)"
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}📥 Updating repository...${NC}"
    cd "$INSTALL_DIR"
    git pull
else
    echo -e "${YELLOW}📥 Cloning repository...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Update docker-compose.yml with Traefik labels
echo -e "${YELLOW}🔧 Configuring docker-compose.yml for Traefik...${NC}"
cat > docker-compose.yml <<EOF
version: '3.8'

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      - NODE_ENV=production
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.trailerio.rule=Host(\`$SUBDOMAIN.plaio.cc\`)"
      - "traefik.http.routers.trailerio.entrypoints=web"
      - "traefik.http.routers.trailerio.entrypoints=websecure"
      - "traefik.http.routers.trailerio.tls.certresolver=letsencrypt"
      - "traefik.http.services.trailerio.loadbalancer.server.port=80"
    networks:
      - $TRAEFIK_NETWORK

networks:
  $TRAEFIK_NETWORK:
    external: true
EOF

# Build and start
echo -e "${YELLOW}🔨 Building and starting container...${NC}"
docker compose down 2>/dev/null || true
docker compose up -d --build

# Wait
sleep 5

# Check status
if docker compose ps | grep -q "Up"; then
    echo -e "${GREEN}✅ Container is running!${NC}"
else
    echo -e "${RED}❌ Container failed to start${NC}"
    docker compose logs
    exit 1
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "📋 Next Steps:"
echo "  1. Add DNS A record: $SUBDOMAIN -> $(hostname -I | awk '{print $1}')"
echo "  2. Traefik will automatically handle SSL via Let's Encrypt"
echo ""
echo "📋 Commands:"
echo "  View logs:    cd $INSTALL_DIR && docker compose logs -f"
echo "  Restart:      cd $INSTALL_DIR && docker compose restart"
echo "  Update:       cd $INSTALL_DIR && git pull && docker compose up -d --build"
echo ""
echo "🌐 Access:"
echo "  After DNS:    https://$SUBDOMAIN.plaio.cc"
echo ""

