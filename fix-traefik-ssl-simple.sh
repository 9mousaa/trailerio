#!/bin/bash
# Simple script to add certresolver labels to existing Traefik container
# This is the easiest method if Traefik is running as a Docker container

set -e

EMAIL="${1:-admin@plaio.cc}"

echo "=== Simple Traefik SSL Fix ==="
echo "Email: $EMAIL"
echo ""

# Find Traefik container
TRAEFIK_CONTAINER=$(docker ps --format "{{.Names}}" | grep -i traefik | head -1)

if [ -z "$TRAEFIK_CONTAINER" ]; then
    echo "✗ Traefik container not found"
    exit 1
fi

echo "✓ Found Traefik: $TRAEFIK_CONTAINER"
echo ""

# Check if already configured
if docker inspect $TRAEFIK_CONTAINER --format '{{.Config.Labels}}' | grep -q "letsencrypt"; then
    echo "⚠ Certresolver might already be configured"
    docker inspect $TRAEFIK_CONTAINER --format '{{.Config.Labels}}' | grep letsencrypt
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

echo "This script will help you add certresolver configuration."
echo ""
echo "Since we can't modify running container labels directly,"
echo "you have two options:"
echo ""
echo "Option 1: If Traefik is in Docker Compose"
echo "  - Edit the docker-compose.yml file for Traefik"
echo "  - Add the labels shown below"
echo "  - Run: docker compose up -d traefik"
echo ""
echo "Option 2: Recreate Traefik container with new labels"
echo "  - This script can help with that"
echo ""
read -p "Which option? (1/2) " -n 1 -r
echo

if [[ $REPLY == "1" ]]; then
    echo ""
    echo "Add these labels to your Traefik service in docker-compose.yml:"
    echo ""
    echo "    labels:"
    echo "      - \"traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL\""
    echo "      - \"traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json\""
    echo "      - \"traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web\""
    echo ""
    echo "Then run: docker compose up -d traefik"
    
elif [[ $REPLY == "2" ]]; then
    echo ""
    echo "Getting Traefik container details..."
    
    # Get container info
    IMAGE=$(docker inspect $TRAEFIK_CONTAINER --format '{{.Config.Image}}')
    RESTART=$(docker inspect $TRAEFIK_CONTAINER --format '{{.HostConfig.RestartPolicy.Name}}')
    
    echo "Image: $IMAGE"
    echo "Restart policy: $RESTART"
    echo ""
    echo "⚠ WARNING: This will stop and recreate the Traefik container"
    echo "Make sure you have the exact docker run command or docker-compose file"
    echo ""
    read -p "Do you have a backup/way to restore Traefik? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted. Please configure manually using Option 1."
        exit 0
    fi
    
    echo ""
    echo "To recreate with certresolver, you need to:"
    echo "1. Stop: docker stop $TRAEFIK_CONTAINER"
    echo "2. Remove: docker rm $TRAEFIK_CONTAINER"
    echo "3. Recreate with labels (use your original docker run/compose command + add):"
    echo "   -l traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL"
    echo "   -l traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    echo "   -l traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
    echo ""
    echo "Or better: Use docker compose and add labels to the service"
fi

echo ""
echo "=== After Configuration ==="
echo "1. Restart Traefik: docker restart $TRAEFIK_CONTAINER"
echo "2. Check logs: docker logs $TRAEFIK_CONTAINER | grep -i acme"
echo "3. Wait 2-3 minutes for certificate"
echo "4. Test: curl -I https://trailerio.plaio.cc"

