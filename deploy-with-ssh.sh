#!/bin/bash
# Deployment script using SSH (for private repos)

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🚀 Deploying Trailerio (SSH Method)${NC}"
echo "=================================="
echo ""

if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use sudo)${NC}"
    exit 1
fi

REPO="git@github.com:9mousaa/trailerio.git"
SUBDOMAIN="${1:-trailerio}"
DIR="/opt/trailerio"
NETWORK="plaio_default"

echo -e "${GREEN}📋 Configuration:${NC}"
echo "  Repository: $REPO"
echo "  Install dir: $DIR"
echo "  Subdomain: $SUBDOMAIN.plaio.cc"
echo "  Network: $NETWORK"
echo ""

# Check SSH key
if [ ! -f ~/.ssh/id_rsa ] && [ ! -f ~/.ssh/id_ed25519 ]; then
    echo -e "${YELLOW}⚠️  No SSH key found. Generating one...${NC}"
    ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/id_ed25519 -N "" -q
    echo -e "${GREEN}✅ SSH key generated${NC}"
    echo ""
    echo -e "${YELLOW}📋 Add this public key to GitHub:${NC}"
    echo "1. Go to: https://github.com/9mousaa/trailerio/settings/keys"
    echo "2. Click 'Add deploy key'"
    echo "3. Paste this key:"
    echo ""
    cat ~/.ssh/id_ed25519.pub
    echo ""
    read -p "Press Enter after adding the key to GitHub..."
fi

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

# Test SSH connection
echo -e "${YELLOW}🔐 Testing SSH connection to GitHub...${NC}"
ssh -T git@github.com 2>&1 | grep -q "successfully authenticated" && echo -e "${GREEN}✅ SSH connection works!${NC}" || echo -e "${YELLOW}⚠️  SSH test inconclusive (this is usually OK)${NC}"

# Clone or update
mkdir -p "$(dirname $DIR)"
if [ -d "$DIR" ]; then
    echo -e "${YELLOW}📥 Updating repository...${NC}"
    cd "$DIR"
    git remote set-url origin "$REPO" 2>/dev/null || true
    git pull || {
        echo -e "${RED}❌ Git pull failed. Trying fresh clone...${NC}"
        cd /opt
        rm -rf trailerio
        git clone "$REPO" trailerio
        cd trailerio
    }
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
else
    echo -e "${RED}❌ Container failed to start${NC}"
    docker compose logs
    exit 1
fi

