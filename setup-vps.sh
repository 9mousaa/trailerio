#!/bin/bash

# Setup script for deploying trailerio on existing VPS
# This script helps integrate with your existing plaio.cc setup

set -e

echo "🚀 Trailerio VPS Setup Script"
echo "=============================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ Please run as root (use sudo)"
    exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "📦 Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
else
    echo "✅ Docker is already installed"
fi

# Check Docker Compose
if ! docker compose version &> /dev/null; then
    echo "📦 Installing Docker Compose..."
    apt-get update
    apt-get install docker-compose-plugin -y
else
    echo "✅ Docker Compose is already installed"
fi

# Determine installation directory
INSTALL_DIR="/opt/trailerio"
if [ -d "/opt" ]; then
    echo "📁 Will install to: $INSTALL_DIR"
else
    INSTALL_DIR="/var/www/trailerio"
    mkdir -p /var/www
    echo "📁 Will install to: $INSTALL_DIR"
fi

# Clone or update repository
if [ -d "$INSTALL_DIR" ]; then
    echo "📥 Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull
else
    echo "📥 Cloning repository..."
    read -p "Enter your git repository URL: " REPO_URL
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Build and start containers
echo "🔨 Building Docker containers..."
docker compose up -d --build

# Wait for container to start
echo "⏳ Waiting for container to start..."
sleep 5

# Check if container is running
if docker compose ps | grep -q "Up"; then
    echo "✅ Container is running!"
else
    echo "❌ Container failed to start. Check logs:"
    docker compose logs
    exit 1
fi

# Setup Nginx
echo ""
echo "🌐 Nginx Configuration"
echo "Choose setup method:"
echo "1) Subdomain (trailerio.plaio.cc)"
echo "2) Path-based (/trailerio)"
echo "3) Skip nginx setup (manual configuration)"
read -p "Enter choice [1-3]: " NGINX_CHOICE

if [ "$NGINX_CHOICE" = "1" ]; then
    # Subdomain setup
    read -p "Enter subdomain (e.g., trailerio): " SUBDOMAIN
    SERVER_NAME="${SUBDOMAIN}.plaio.cc"
    
    cp nginx-subdomain.conf /etc/nginx/sites-available/trailerio
    sed -i "s/trailerio.plaio.cc/$SERVER_NAME/g" /etc/nginx/sites-available/trailerio
    
    ln -sf /etc/nginx/sites-available/trailerio /etc/nginx/sites-enabled/trailerio
    
    nginx -t
    if [ $? -eq 0 ]; then
        systemctl reload nginx
        echo "✅ Nginx configured for subdomain: $SERVER_NAME"
        echo "🔒 To enable SSL, run: certbot --nginx -d $SERVER_NAME"
    else
        echo "❌ Nginx configuration error. Please check manually."
    fi
    
elif [ "$NGINX_CHOICE" = "2" ]; then
    # Path-based setup
    echo ""
    echo "📝 Add this to your existing plaio.cc nginx config:"
    echo "---"
    cat nginx-path.conf
    echo "---"
    echo ""
    read -p "Press enter after you've added the config to nginx..."
    
    nginx -t
    if [ $? -eq 0 ]; then
        systemctl reload nginx
        echo "✅ Nginx reloaded"
    else
        echo "❌ Nginx configuration error. Please check manually."
    fi
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Useful commands:"
echo "  - View logs: cd $INSTALL_DIR && docker compose logs -f"
echo "  - Restart: cd $INSTALL_DIR && docker compose restart"
echo "  - Update: cd $INSTALL_DIR && git pull && docker compose up -d --build"
echo ""
echo "🌐 Your app should be accessible at:"
if [ "$NGINX_CHOICE" = "1" ]; then
    echo "  http://$SERVER_NAME (or https:// after SSL setup)"
elif [ "$NGINX_CHOICE" = "2" ]; then
    echo "  http://plaio.cc/trailerio"
else
    echo "  http://your-vps-ip:8081"
fi

