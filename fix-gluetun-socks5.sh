#!/bin/bash
# Comprehensive fix for gluetun SOCKS5 setup

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
cd "$PROJECT_DIR"

echo "🔍 Diagnosing gluetun SOCKS5 setup..."
echo ""

# 1. Check if SOCKS5 is mentioned in logs
echo "=== Checking gluetun logs for SOCKS5 ==="
docker compose logs gluetun 2>&1 | grep -i "socks\|1080" || echo "No SOCKS5 messages found in logs"
echo ""

# 2. Check WireGuard status (not OpenVPN)
echo "=== Checking WireGuard VPN status ==="
docker exec gluetun wget -qO- http://localhost:8000/v1/wireguard/status 2>&1 || echo "WireGuard status endpoint not available"
echo ""

# 3. Check if SOCKS5 port is listening
echo "=== Checking if port 1080 is listening ==="
docker exec gluetun netstat -tlnp 2>/dev/null | grep 1080 || \
docker exec gluetun ss -tlnp 2>/dev/null | grep 1080 || \
echo "Port 1080 not found - SOCKS5 server not running"
echo ""

# 4. Check gluetun environment
echo "=== Checking gluetun environment variables ==="
docker exec gluetun env | grep -i "SOCKS5\|WIREGUARD" | sort
echo ""

# 5. Test internet connectivity through gluetun
echo "=== Testing internet connectivity through gluetun ==="
docker exec gluetun wget -qO- --timeout=5 http://httpbin.org/ip 2>&1 | head -3 || echo "Cannot reach internet through gluetun"
echo ""

# 6. Check for errors in gluetun logs
echo "=== Checking for errors in gluetun logs ==="
docker compose logs gluetun --tail=100 | grep -i "error\|warn\|fail" | tail -10 || echo "No errors found"
echo ""

# 7. Verify docker-compose.yml has SOCKS5 config
echo "=== Verifying docker-compose.yml configuration ==="
if grep -q "SOCKS5_SERVER=on" docker-compose.yml; then
    echo "✓ SOCKS5_SERVER=on found in docker-compose.yml"
else
    echo "✗ SOCKS5_SERVER=on NOT found in docker-compose.yml"
fi

if grep -q "SOCKS5_SERVER_PORT=1080" docker-compose.yml; then
    echo "✓ SOCKS5_SERVER_PORT=1080 found in docker-compose.yml"
else
    echo "✗ SOCKS5_SERVER_PORT=1080 NOT found in docker-compose.yml"
fi
echo ""

# 8. Test SOCKS5 from backend container
echo "=== Testing SOCKS5 from backend container ==="
docker exec trailerio-backend-1 wget -qO- --timeout=3 --proxy=socks5://gluetun:1080 "http://httpbin.org/ip" 2>&1 | head -5 || echo "SOCKS5 test failed"
echo ""

echo "✅ Diagnosis complete!"
echo ""
echo "If SOCKS5 is not working, try:"
echo "  1. docker compose restart gluetun"
echo "  2. Wait 10 seconds for VPN to connect"
echo "  3. Check logs: docker compose logs gluetun --tail=30"

