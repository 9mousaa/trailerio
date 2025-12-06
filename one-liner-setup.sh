#!/bin/bash

# One-liner setup script for trailerio on VPS
# This script handles everything automatically

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Trailerio One-Liner Setup${NC}"
echo "=================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use sudo)${NC}"
    exit 1
fi

# Configuration
INSTALL_DIR="/opt/trailerio"
PORT="8081"
REPO_URL="${1:-}"

# If no repo URL provided, try to detect or ask
if [ -z "$REPO_URL" ]; then
    if [ -d "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/.git" ]; then
        REPO_URL=$(cd "$INSTALL_DIR" && git remote get-url origin 2>/dev/null || echo "")
        if [ -n "$REPO_URL" ]; then
            echo -e "${GREEN}✅ Found existing repo: $REPO_URL${NC}"
        fi
    fi
    
    if [ -z "$REPO_URL" ]; then
        echo -e "${YELLOW}⚠️  No repository URL provided${NC}"
        echo "Usage: $0 <git-repo-url> [subdomain]"
        echo "Example: $0 https://github.com/user/trailerio.git trailerio"
        exit 1
    fi
fi

SUBDOMAIN="${2:-trailerio}"

echo -e "${GREEN}📋 Configuration:${NC}"
echo "  Repository: $REPO_URL"
echo "  Install dir: $INSTALL_DIR"
echo "  Port: $PORT"
echo "  Subdomain: $SUBDOMAIN.plaio.cc"
echo ""

# Install Docker if needed
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}📦 Installing Docker...${NC}"
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm /tmp/get-docker.sh
    echo -e "${GREEN}✅ Docker installed${NC}"
else
    echo -e "${GREEN}✅ Docker already installed${NC}"
fi

# Install Docker Compose if needed
if ! docker compose version &> /dev/null 2>&1; then
    echo -e "${YELLOW}📦 Installing Docker Compose...${NC}"
    apt-get update -qq
    apt-get install -y docker-compose-plugin
    echo -e "${GREEN}✅ Docker Compose installed${NC}"
else
    echo -e "${GREEN}✅ Docker Compose already installed${NC}"
fi

# Create install directory
mkdir -p "$(dirname $INSTALL_DIR)"

# Clone or update repository
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}📥 Updating existing repository...${NC}"
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/main 2>/dev/null || git reset --hard origin/master 2>/dev/null || true
    git pull
else
    echo -e "${YELLOW}📥 Cloning repository...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Ensure docker-compose.yml has correct port
if ! grep -q "8081:80" docker-compose.yml 2>/dev/null; then
    echo -e "${YELLOW}🔧 Updating docker-compose.yml port...${NC}"
    sed -i 's/"80:80"/"8081:80"/g' docker-compose.yml 2>/dev/null || true
fi

# Build and start containers
echo -e "${YELLOW}🔨 Building and starting containers...${NC}"
docker compose down 2>/dev/null || true
docker compose up -d --build

# Wait for container
echo -e "${YELLOW}⏳ Waiting for container to start...${NC}"
sleep 5

# Check if running
if docker compose ps | grep -q "Up"; then
    echo -e "${GREEN}✅ Container is running!${NC}"
else
    echo -e "${RED}❌ Container failed to start${NC}"
    docker compose logs
    exit 1
fi

# Setup Nginx
if command -v nginx &> /dev/null; then
    echo -e "${YELLOW}🌐 Configuring Nginx...${NC}"
    
    # Create nginx config
    NGINX_CONFIG="/etc/nginx/sites-available/trailerio"
    cat > "$NGINX_CONFIG" <<EOF
server {
    listen 80;
    server_name $SUBDOMAIN.plaio.cc;

    location / {
        proxy_pass http://localhost:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

    # Enable site
    ln -sf "$NGINX_CONFIG" /etc/nginx/sites-enabled/trailerio
    
    # Test and reload
    if nginx -t 2>/dev/null; then
        systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null
        echo -e "${GREEN}✅ Nginx configured for $SUBDOMAIN.plaio.cc${NC}"
        echo -e "${YELLOW}⚠️  Don't forget to:${NC}"
        echo "  1. Add DNS A record: $SUBDOMAIN -> $(hostname -I | awk '{print $1}')"
        echo "  2. Run SSL setup: certbot --nginx -d $SUBDOMAIN.plaio.cc"
    else
        echo -e "${RED}❌ Nginx config test failed. Please check manually.${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Nginx not found. Install it to set up reverse proxy.${NC}"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "📋 Quick Commands:"
echo "  View logs:    cd $INSTALL_DIR && docker compose logs -f"
echo "  Restart:      cd $INSTALL_DIR && docker compose restart"
echo "  Update:       cd $INSTALL_DIR && git pull && docker compose up -d --build"
echo ""
echo "🌐 Access:"
echo "  Direct:       http://$(hostname -I | awk '{print $1}'):$PORT"
if command -v nginx &> /dev/null; then
    echo "  Via Nginx:    http://$SUBDOMAIN.plaio.cc (after DNS setup)"
fi
echo ""

