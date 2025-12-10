#!/bin/bash
# Comprehensive SOCKS5 diagnosis

set -e

echo "🔍 Comprehensive SOCKS5 Diagnosis"
echo ""

# 1. Check gluetun logs for SOCKS5
echo "=== 1. Gluetun logs (SOCKS5 related) ==="
docker compose logs gluetun 2>&1 | grep -i 'socks\|1080' | tail -20 || echo "No SOCKS5 messages found"
echo ""

# 2. Check for errors
echo "=== 2. Gluetun errors/warnings ==="
docker compose logs gluetun 2>&1 | grep -i 'error\|warn\|fail' | tail -20 || echo "No errors found"
echo ""

# 3. Check environment variables
echo "=== 3. Gluetun SOCKS5 environment variables ==="
docker exec gluetun env | grep -i 'SOCKS5' | sort || echo "No SOCKS5 variables found"
echo ""

# 4. Check VPN status
echo "=== 4. VPN connection status ==="
docker exec gluetun wget -qO- http://localhost:8000/v1/openvpn/status 2>&1 || echo "Cannot check VPN status"
echo ""

# 5. Check if any process is listening on 1080
echo "=== 5. Processes listening on port 1080 ==="
docker exec gluetun netstat -tlnp 2>/dev/null | grep 1080 || \
docker exec gluetun ss -tlnp 2>/dev/null | grep 1080 || \
echo "Port 1080 not listening"
echo ""

# 6. Check all listening ports
echo "=== 6. All listening ports in gluetun ==="
docker exec gluetun netstat -tlnp 2>/dev/null | grep LISTEN || \
docker exec gluetun ss -tlnp 2>/dev/null | grep LISTEN || \
echo "Cannot check ports"
echo ""

# 7. Check gluetun version
echo "=== 7. Gluetun version ==="
docker exec gluetun /gluetun --version 2>&1 | head -5 || echo "Cannot get version"
echo ""

# 8. Full startup logs (last 50 lines)
echo "=== 8. Full gluetun startup logs (last 50 lines) ==="
docker compose logs gluetun --tail=50
echo ""

echo "✅ Diagnosis complete!"

