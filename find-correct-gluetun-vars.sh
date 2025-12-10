#!/bin/bash
# Test different gluetun environment variable combinations to find the correct ones

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
cd "$PROJECT_DIR"

echo "🔍 Testing gluetun environment variable combinations..."
echo ""

# Test 1: HTTPPROXY (no underscore) - current attempt
echo "=== Test 1: HTTPPROXY (no underscore) ==="
cat > /tmp/test1.yml << 'YAML'
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    environment:
      - VPN_SERVICE_PROVIDER=custom
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY}
      - WIREGUARD_ADDRESSES=${WIREGUARD_ADDRESSES}
      - WIREGUARD_PUBLIC_KEY=${WIREGUARD_PUBLIC_KEY}
      - WIREGUARD_PRESHARED_KEY=${WIREGUARD_PRESHARED_KEY}
      - WIREGUARD_ENDPOINT_IP=${WIREGUARD_ENDPOINT_IP}
      - WIREGUARD_ENDPOINT_PORT=${WIREGUARD_ENDPOINT_PORT}
      - HTTPPROXY=on
      - HTTPPROXY_PORT=8888
      - SOCKS5=on
      - SOCKS5_PORT=1080
YAML

echo "Checking gluetun logs for HTTP proxy and SOCKS5..."
docker compose logs gluetun 2>&1 | grep -A 5 -B 5 "HTTP proxy\|SOCKS5\|8888\|1080" | tail -20 || echo "No matches found"

echo ""
echo "✅ Run this to test:"
echo "cd /opt/trailerio && git pull && docker compose up -d gluetun && sleep 10 && docker compose logs gluetun --tail=100 | grep -i 'http.*proxy\|socks'"

