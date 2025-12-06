#!/bin/bash

# Script to check current VPS setup
# Run this on your VPS to see what's currently configured

echo "=== Current VPS Setup Check ==="
echo ""

echo "📦 Docker Containers:"
docker ps -a
echo ""

echo "🌐 Nginx Configuration:"
if [ -d "/etc/nginx/sites-available" ]; then
    echo "Available sites:"
    ls -la /etc/nginx/sites-available/
    echo ""
    echo "Enabled sites:"
    ls -la /etc/nginx/sites-enabled/
    echo ""
    echo "Main nginx config:"
    cat /etc/nginx/nginx.conf | head -20
else
    echo "Nginx not found or not in standard location"
fi
echo ""

echo "🔌 Listening Ports:"
netstat -tulpn | grep LISTEN || ss -tulpn | grep LISTEN
echo ""

echo "📁 Common App Directories:"
for dir in /opt /var/www /home/*/apps /root/apps; do
    if [ -d "$dir" ]; then
        echo "$dir:"
        ls -la "$dir" 2>/dev/null | head -10
        echo ""
    fi
done

echo "🐳 Docker Compose Files:"
find /opt /var/www /home -name "docker-compose.yml" 2>/dev/null | head -10
echo ""

echo "✅ Check complete!"

