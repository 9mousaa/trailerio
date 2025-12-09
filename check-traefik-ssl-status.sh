#!/bin/bash
# Check Traefik SSL certificate status
echo "=== Traefik SSL Certificate Status ==="
echo ""

# Check if Traefik is running
if ! docker ps | grep -q traefik; then
    echo "✗ Traefik is not running"
    echo "Start it: cd /opt/traefik && docker compose up -d"
    exit 1
fi

echo "✓ Traefik is running"
echo ""

# Check logs for certresolver
echo "Checking Traefik logs for certresolver configuration..."
echo "---"
docker logs traefik 2>&1 | grep -i "certresolver\|letsencrypt\|acme" | tail -10
echo "---"
echo ""

# Check for certificate errors
ERRORS=$(docker logs traefik 2>&1 | grep -i "error\|failed" | grep -i "cert\|acme\|letsencrypt" | tail -5)
if [ -n "$ERRORS" ]; then
    echo "⚠ Certificate-related errors found:"
    echo "$ERRORS"
    echo ""
else
    echo "✓ No certificate errors in recent logs"
    echo ""
fi

# Check if acme.json exists and has content
if [ -f "/opt/traefik/letsencrypt/acme.json" ]; then
    SIZE=$(stat -c%s /opt/traefik/letsencrypt/acme.json 2>/dev/null || stat -f%z /opt/traefik/letsencrypt/acme.json 2>/dev/null || echo "0")
    if [ "$SIZE" -gt 100 ]; then
        echo "✓ acme.json exists and has content ($SIZE bytes)"
        echo "  Certificate data is being stored"
    else
        echo "⚠ acme.json exists but is small ($SIZE bytes)"
        echo "  Certificate may still be issuing..."
    fi
else
    echo "⚠ acme.json not found"
fi
echo ""

# Test HTTPS connection
echo "Testing HTTPS connection to trailerio.plaio.cc..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 10 https://trailerio.plaio.cc 2>&1 || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ HTTPS is working! (HTTP 200)"
    echo ""
    echo "Checking certificate..."
    CERT_INFO=$(echo | openssl s_client -connect trailerio.plaio.cc:443 -servername trailerio.plaio.cc 2>/dev/null | openssl x509 -noout -dates -subject 2>/dev/null || echo "")
    if [ -n "$CERT_INFO" ]; then
        echo "$CERT_INFO"
        echo ""
        echo "🎉 SSL Certificate is working!"
    else
        echo "⚠ Could not verify certificate details"
    fi
elif [ "$HTTP_CODE" = "000" ]; then
    echo "⚠ Connection failed or timeout"
    echo "  This might be normal if certificate is still issuing (wait 2-3 minutes)"
elif [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "503" ]; then
    echo "⚠ Bad Gateway - Traefik is running but backend might not be ready"
elif [ "$HTTP_CODE" = "404" ]; then
    echo "⚠ Not Found - Check Traefik routing configuration"
else
    echo "⚠ HTTP $HTTP_CODE - Check Traefik configuration"
fi
echo ""

# Check Traefik detected containers
echo "Containers Traefik has detected:"
docker logs traefik 2>&1 | grep -i "configuration.*reloaded\|new.*configuration" | tail -3
echo ""

echo "=== Summary ==="
echo "1. Traefik is running: ✓"
echo "2. Certresolver configured: Check logs above"
echo "3. Certificate issued: Check HTTPS test above"
echo ""
echo "If certificate is not working yet:"
echo "  - Wait 2-3 more minutes"
echo "  - Check logs: docker logs traefik | tail -50"
echo "  - Verify DNS: dig trailerio.plaio.cc"
echo "  - Check port 80 is accessible (needed for Let's Encrypt challenge)"

