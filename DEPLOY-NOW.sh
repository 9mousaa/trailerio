#!/bin/bash
# Ready-to-use deployment script for plaio.cc
# Network: plaio_default
# Repo: https://github.com/9mousaa/trailerio

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🚀 Deploying Trailerio to plaio.cc${NC}"
echo "=================================="
echo ""

if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use sudo)${NC}"
    exit 1
fi

REPO="https://github.com/9mousaa/trailerio"
SUBDOMAIN="${1:-trailerio}"
DIR="/opt/trailerio"
NETWORK="plaio_default"

echo -e "${GREEN}📋 Configuration:${NC}"
echo "  Repository: $REPO"
echo "  Install dir: $DIR"
echo "  Subdomain: $SUBDOMAIN.plaio.cc"
echo "  Network: $NETWORK"
echo ""

# Install Docker if needed
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}📦 Installing Docker...${NC}"
    curl -fsSL https://get.docker.com | sh
fi

# Install Docker Compose if needed
if ! docker compose version &> /dev/null 2>&1; then
    echo -e "${YELLOW}📦 Installing Docker Compose...${NC}"
    apt-get update -qq
    apt-get install -y docker-compose-plugin
fi

# Clone or update
mkdir -p "$(dirname $DIR)"
if [ -d "$DIR" ]; then
    echo -e "${YELLOW}📥 Updating repository...${NC}"
    cd "$DIR"
    git pull
else
    echo -e "${YELLOW}📥 Cloning repository...${NC}"
    git clone "$REPO" "$DIR"
    cd "$DIR"
fi

# Create docker-compose.yml
echo -e "${YELLOW}🔧 Creating docker-compose.yml...${NC}"
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
      - $NETWORK

networks:
  $NETWORK:
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
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✅ Deployment Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "📋 Next Steps:"
    echo "  1. Add DNS A record: $SUBDOMAIN -> $(hostname -I | awk '{print $1}')"
    echo "  2. Traefik will automatically handle SSL via Let's Encrypt"
    echo ""
    echo "📋 Useful Commands:"
    echo "  View logs:    cd $DIR && docker compose logs -f"
    echo "  Restart:      cd $DIR && docker compose restart"
    echo "  Update:       cd $DIR && git pull && docker compose up -d --build"
    echo ""
    echo "🌐 Access:"
    echo "  After DNS:    https://$SUBDOMAIN.plaio.cc"
    echo ""
else
    echo -e "${RED}❌ Container failed to start${NC}"
    echo "Checking logs..."
    docker compose logs
    exit 1
fi

