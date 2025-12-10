#!/bin/bash
# Test SOCKS5 connectivity for yt-dlp

set -e

echo "🔍 Testing SOCKS5 connectivity for yt-dlp..."
echo ""

# 1. Test if port 1080 is accessible
echo "=== 1. Testing port 1080 connectivity ==="
if docker exec trailerio-backend-1 timeout 2 bash -c '</dev/tcp/gluetun/1080' 2>/dev/null; then
    echo "✅ Port 1080 is open and accessible"
else
    echo "❌ Port 1080 is closed or not accessible"
    echo "   This means SOCKS5 server is not running or not accessible"
    exit 1
fi
echo ""

# 2. Test with curl (should work if SOCKS5 is working)
echo "=== 2. Testing SOCKS5 with curl ==="
CURL_TEST=$(docker exec trailerio-backend-1 curl -s --proxy socks5://gluetun:1080 --max-time 5 http://httpbin.org/ip 2>&1)
if echo "$CURL_TEST" | grep -q "origin"; then
    echo "✅ curl works through SOCKS5"
    echo "   Response: $CURL_TEST"
else
    echo "❌ curl failed through SOCKS5"
    echo "   Error: $CURL_TEST"
fi
echo ""

# 3. Test yt-dlp with verbose output
echo "=== 3. Testing yt-dlp with SOCKS5 (verbose) ==="
echo "Testing with a simple video (Rick Roll - should work):"
docker exec trailerio-backend-1 yt-dlp \
    --proxy socks5://gluetun:1080 \
    --verbose \
    --no-download \
    --get-url \
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ' 2>&1 | head -30 || echo "yt-dlp test failed"
echo ""

# 4. Check gluetun logs for SOCKS5
echo "=== 4. Checking gluetun logs for SOCKS5 ==="
docker compose logs gluetun 2>&1 | grep -i "socks\|1080" | tail -10 || echo "No SOCKS5 messages in logs"
echo ""

echo "✅ Testing complete!"

