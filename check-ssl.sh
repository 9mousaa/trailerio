#!/bin/bash
# SSL/TLS Diagnostic Script for TrailerIO

DOMAIN="trailerio.plaio.cc"

echo "=== SSL/TLS Diagnostic for $DOMAIN ==="
echo ""

echo "1. Checking DNS resolution..."
DNS_IP=$(dig +short $DOMAIN | head -1)
if [ -z "$DNS_IP" ]; then
    echo "   ✗ DNS not resolving for $DOMAIN"
    echo "   → Fix: Update DNS A record to point to your server IP"
else
    echo "   ✓ DNS resolves to: $DNS_IP"
fi
echo ""

echo "2. Checking HTTP connection..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 5 http://$DOMAIN)
if [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    echo "   ✓ HTTP redirects to HTTPS (code: $HTTP_CODE)"
elif [ "$HTTP_CODE" = "200" ]; then
    echo "   ⚠ HTTP returns 200 (should redirect to HTTPS)"
else
    echo "   ✗ HTTP connection failed (code: $HTTP_CODE)"
fi
echo ""

echo "3. Checking HTTPS connection..."
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 5 https://$DOMAIN 2>&1)
if echo "$HTTPS_CODE" | grep -q "200"; then
    echo "   ✓ HTTPS connection successful"
elif echo "$HTTPS_CODE" | grep -q "SSL\|certificate\|cert"; then
    echo "   ✗ HTTPS SSL error:"
    echo "   $HTTPS_CODE" | head -3
else
    echo "   ✗ HTTPS connection failed (code: $HTTPS_CODE)"
fi
echo ""

echo "4. Checking certificate details..."
CERT_INFO=$(echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -dates -subject -issuer 2>/dev/null)
if [ -z "$CERT_INFO" ]; then
    echo "   ✗ No certificate found or connection failed"
    echo "   → Fix: Check Traefik logs for certificate issuance errors"
else
    echo "   ✓ Certificate found:"
    echo "$CERT_INFO" | sed 's/^/      /'
    
    # Check if certificate is expired
    EXPIRY=$(echo "$CERT_INFO" | grep "notAfter" | cut -d= -f2)
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %H:%M:%S %Y %Z" "$EXPIRY" +%s 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    if [ "$EXPIRY_EPOCH" -lt "$NOW_EPOCH" ]; then
        echo "   ✗ Certificate is EXPIRED!"
    else
        DAYS_LEFT=$(( ($EXPIRY_EPOCH - $NOW_EPOCH) / 86400 ))
        echo "   ✓ Certificate valid for $DAYS_LEFT more days"
    fi
fi
echo ""

echo "5. Checking Traefik container..."
if docker ps | grep -q traefik; then
    echo "   ✓ Traefik container is running"
    
    echo "   Checking Traefik logs for certificate errors..."
    TRAEFIK_LOGS=$(docker logs traefik 2>&1 | grep -i "certificate\|acme\|letsencrypt\|error" | tail -5)
    if [ -z "$TRAEFIK_LOGS" ]; then
        echo "   ✓ No certificate errors in recent logs"
    else
        echo "   ⚠ Recent certificate-related logs:"
        echo "$TRAEFIK_LOGS" | sed 's/^/      /'
    fi
else
    echo "   ✗ Traefik container is not running"
    echo "   → Fix: Start Traefik with: docker start traefik"
fi
echo ""

echo "6. Testing SSL Labs API (if available)..."
SSL_TEST=$(curl -s "https://api.ssllabs.com/api/v3/analyze?host=$DOMAIN&publish=off&fromCache=on" 2>/dev/null)
if echo "$SSL_TEST" | grep -q "grade"; then
    GRADE=$(echo "$SSL_TEST" | grep -o '"grade":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "   ✓ SSL Labs grade: $GRADE"
    if [ "$GRADE" = "A" ] || [ "$GRADE" = "A+" ]; then
        echo "   ✓ Excellent SSL configuration"
    elif [ "$GRADE" = "B" ]; then
        echo "   ⚠ Good, but could be improved"
    else
        echo "   ⚠ SSL configuration needs improvement"
    fi
else
    echo "   ⚠ SSL Labs API not available (rate limited or network issue)"
fi
echo ""

echo "=== Summary ==="
echo "If you see 'Not Secure' in browser:"
echo "1. Wait 5-10 minutes after deployment for Let's Encrypt to issue certificate"
echo "2. Check Traefik static config has 'letsencrypt' certresolver configured"
echo "3. Verify domain DNS points to your server"
echo "4. Check Traefik logs: docker logs traefik | grep -i acme"
echo "5. Restart Traefik: docker restart traefik"
echo ""
echo "For detailed guide, see: FIX_SSL_NOT_SECURE.md"

