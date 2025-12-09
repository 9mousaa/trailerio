#!/bin/bash
# Script to help configure Traefik certresolver
# This script checks Traefik configuration and provides instructions

echo "=== Traefik Certificate Resolver Configuration Helper ==="
echo ""

# Check if Traefik container exists
if ! docker ps -a | grep -q traefik; then
    echo "✗ Traefik container not found"
    echo "  Make sure Traefik is running: docker ps | grep traefik"
    exit 1
fi

TRAEFIK_CONTAINER=$(docker ps -a | grep traefik | awk '{print $1}' | head -1)
echo "✓ Found Traefik container: $TRAEFIK_CONTAINER"
echo ""

# Check if certresolver is already configured
echo "Checking for existing certresolver configuration..."
CERTRESOLVER_CHECK=$(docker exec $TRAEFIK_CONTAINER cat /etc/traefik/traefik.yml 2>/dev/null | grep -i "certresolver\|letsencrypt" || echo "")

if [ -z "$CERTRESOLVER_CHECK" ]; then
    # Check Docker labels
    CERTRESOLVER_CHECK=$(docker inspect $TRAEFIK_CONTAINER 2>/dev/null | grep -i "certresolver\|letsencrypt" || echo "")
fi

if [ -n "$CERTRESOLVER_CHECK" ]; then
    echo "⚠ Found certresolver configuration:"
    echo "$CERTRESOLVER_CHECK" | head -5
    echo ""
    echo "If 'letsencrypt' resolver exists, the issue might be:"
    echo "  1. Wrong resolver name (check if it's 'le' instead of 'letsencrypt')"
    echo "  2. Configuration syntax error"
    echo "  3. Storage path not writable"
else
    echo "✗ No certresolver configuration found"
    echo ""
    echo "To fix this, you need to add certresolver to Traefik configuration:"
    echo ""
    echo "Option 1: Add to Traefik static config file"
    echo "  Edit: /etc/traefik/traefik.yml (or wherever Traefik config is)"
    echo "  Add:"
    echo "    certificatesResolvers:"
    echo "      letsencrypt:"
    echo "        acme:"
    echo "          email: your-email@example.com"
    echo "          storage: /letsencrypt/acme.json"
    echo "          httpChallenge:"
    echo "            entryPoint: web"
    echo ""
    echo "Option 2: Add as Docker labels to Traefik container"
    echo "  Add these labels to Traefik container:"
    echo "    - traefik.certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
    echo "    - traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    echo "    - traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
    echo ""
    echo "Then restart Traefik: docker restart traefik"
fi

echo ""
echo "=== Current Traefik Configuration ==="
echo "Container: $TRAEFIK_CONTAINER"
echo ""

# Show Traefik logs for certresolver errors
echo "Recent certresolver errors from Traefik logs:"
docker logs $TRAEFIK_CONTAINER 2>&1 | grep -i "certresolver\|letsencrypt" | tail -5
echo ""

# Check what entrypoints are configured
echo "Checking entrypoints..."
docker logs $TRAEFIK_CONTAINER 2>&1 | grep -i "entrypoint" | head -3
echo ""

echo "=== Next Steps ==="
echo "1. Configure certresolver in Traefik (see instructions above)"
echo "2. Restart Traefik: docker restart traefik"
echo "3. Wait 2-3 minutes for certificate issuance"
echo "4. Check logs: docker logs traefik | grep -i acme"
echo "5. Test: curl -I https://trailerio.plaio.cc"

