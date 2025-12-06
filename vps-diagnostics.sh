#!/bin/bash

# Comprehensive VPS diagnostics script
# Run this to understand your current setup

echo "═══════════════════════════════════════════════════════════"
echo "🔍 VPS DIAGNOSTICS - Understanding Your Setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

echo "📦 DOCKER STATUS"
echo "───────────────────────────────────────────────────────────"
if command -v docker &> /dev/null; then
    echo "✅ Docker is installed"
    docker --version
    echo ""
    echo "Running containers:"
    docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "All containers (including stopped):"
    docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
else
    echo "❌ Docker is NOT installed"
fi
echo ""

echo "🐳 DOCKER COMPOSE STATUS"
echo "───────────────────────────────────────────────────────────"
if docker compose version &> /dev/null 2>&1; then
    echo "✅ Docker Compose is installed"
    docker compose version
else
    echo "❌ Docker Compose is NOT installed"
fi
echo ""

echo "🌐 NGINX STATUS"
echo "───────────────────────────────────────────────────────────"
if command -v nginx &> /dev/null; then
    echo "✅ Nginx is installed"
    nginx -v 2>&1
    echo ""
    echo "Nginx service status:"
    systemctl status nginx --no-pager -l 2>/dev/null | head -5 || service nginx status 2>/dev/null | head -5
    echo ""
    echo "Available sites:"
    if [ -d "/etc/nginx/sites-available" ]; then
        ls -la /etc/nginx/sites-available/ | grep -v "^total"
    else
        echo "  /etc/nginx/sites-available/ not found"
    fi
    echo ""
    echo "Enabled sites:"
    if [ -d "/etc/nginx/sites-enabled" ]; then
        ls -la /etc/nginx/sites-enabled/ | grep -v "^total"
    else
        echo "  /etc/nginx/sites-enabled/ not found"
    fi
    echo ""
    echo "Main nginx config location:"
    nginx -t 2>&1 | grep "configuration file"
else
    echo "❌ Nginx is NOT installed"
fi
echo ""

echo "🔌 NETWORK PORTS"
echo "───────────────────────────────────────────────────────────"
echo "Listening ports:"
if command -v ss &> /dev/null; then
    ss -tulpn | grep LISTEN | awk '{print $5, $7}' | sed 's/users:((\"//g' | sed 's/\"))//g' | column -t
elif command -v netstat &> /dev/null; then
    netstat -tulpn 2>/dev/null | grep LISTEN | awk '{print $4, $7}' | column -t
else
    echo "  Cannot check ports (ss/netstat not available)"
fi
echo ""

echo "📁 APP DIRECTORIES"
echo "───────────────────────────────────────────────────────────"
for dir in /opt /var/www /home/*/apps /root/apps /home/*/www; do
    if [ -d "$dir" ]; then
        echo "$dir:"
        ls -la "$dir" 2>/dev/null | head -15 | tail -n +2
        echo ""
    fi
done

echo "🔍 DOCKER COMPOSE FILES"
echo "───────────────────────────────────────────────────────────"
find /opt /var/www /home -name "docker-compose.yml" -o -name "docker-compose.yaml" 2>/dev/null | while read file; do
    echo "Found: $file"
    echo "  Directory: $(dirname $file)"
    echo "  Services:"
    grep -E "^\s+[a-zA-Z0-9_-]+:" "$file" 2>/dev/null | sed 's/^/    /' || echo "    (could not parse)"
    echo ""
done

echo "🌍 DOMAIN/DNS INFO"
echo "───────────────────────────────────────────────────────────"
if [ -f "/etc/nginx/sites-enabled/"* ] 2>/dev/null; then
    echo "Server names in nginx configs:"
    grep -h "server_name" /etc/nginx/sites-enabled/* 2>/dev/null | grep -v "#" | sed 's/server_name//' | sed 's/;//' | sed 's/^/  /'
fi
echo ""

echo "🔐 SSL CERTIFICATES"
echo "───────────────────────────────────────────────────────────"
if [ -d "/etc/letsencrypt/live" ]; then
    echo "Let's Encrypt certificates:"
    ls -la /etc/letsencrypt/live/ 2>/dev/null | grep "^d" | awk '{print "  " $9}'
else
    echo "  No Let's Encrypt certificates found"
fi
echo ""

echo "💾 DISK SPACE"
echo "───────────────────────────────────────────────────────────"
df -h / | tail -1 | awk '{print "  Available: " $4 " / Total: " $2 " (" $5 " used)"}'
echo ""

echo "🖥️  SYSTEM INFO"
echo "───────────────────────────────────────────────────────────"
echo "  OS: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -a)"
echo "  Uptime: $(uptime -p 2>/dev/null || uptime)"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "✅ Diagnostics complete!"
echo "═══════════════════════════════════════════════════════════"

