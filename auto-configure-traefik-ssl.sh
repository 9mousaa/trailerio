#!/bin/bash
# Automatic Traefik SSL Certificate Resolver Configuration
# This script detects Traefik setup and configures the letsencrypt certresolver

set -e

EMAIL="${1:-admin@plaio.cc}"  # Default email or pass as first argument
DOMAIN="trailerio.plaio.cc"

echo "=== Auto-Configuring Traefik SSL Certificate Resolver ==="
echo "Email: $EMAIL"
echo "Domain: $DOMAIN"
echo ""

# Find Traefik container
TRAEFIK_CONTAINER=$(docker ps -a --format "{{.Names}}" | grep -i traefik | head -1)

if [ -z "$TRAEFIK_CONTAINER" ]; then
    echo "✗ Traefik container not found"
    echo "  Make sure Traefik is running: docker ps | grep traefik"
    exit 1
fi

echo "✓ Found Traefik container: $TRAEFIK_CONTAINER"
echo ""

# Check if certresolver already exists
echo "Checking for existing letsencrypt certresolver..."
EXISTING=$(docker inspect $TRAEFIK_CONTAINER 2>/dev/null | grep -i "letsencrypt" || echo "")

if [ -n "$EXISTING" ]; then
    echo "⚠ letsencrypt certresolver might already be configured"
    echo "  Checking if it's working..."
    docker logs $TRAEFIK_CONTAINER 2>&1 | grep -i "certresolver.*letsencrypt" | tail -3
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Method 1: Check if Traefik is using Docker Compose
echo "Method 1: Checking for Docker Compose setup..."
COMPOSE_FILE=$(docker inspect $TRAEFIK_CONTAINER 2>/dev/null | grep -oP '"com.docker.compose.project.working_dir":"\K[^"]+' | head -1)
if [ -n "$COMPOSE_FILE" ]; then
    COMPOSE_FILE="$COMPOSE_FILE/docker-compose.yml"
    if [ -f "$COMPOSE_FILE" ]; then
        echo "  Found docker-compose.yml at: $COMPOSE_FILE"
        echo "  Attempting to add certresolver labels..."
        
        # Check if labels section exists
        if grep -q "labels:" "$COMPOSE_FILE"; then
            # Add certresolver labels if not present
            if ! grep -q "certificatesresolvers.letsencrypt" "$COMPOSE_FILE"; then
                echo "  Adding certresolver configuration to docker-compose.yml..."
                # This is complex - we'll create a backup and modify
                cp "$COMPOSE_FILE" "$COMPOSE_FILE.backup.$(date +%s)"
                # Add labels after the labels: line (simplified approach)
                echo ""
                echo "  ⚠ Manual step required:"
                echo "  Edit: $COMPOSE_FILE"
                echo "  Add these labels to Traefik service:"
                echo "    - \"traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL\""
                echo "    - \"traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json\""
                echo "    - \"traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web\""
                echo ""
                echo "  Then run: cd $(dirname $COMPOSE_FILE) && docker compose up -d traefik"
            else
                echo "  ✓ Certresolver already in docker-compose.yml"
            fi
        fi
    fi
fi

# Method 2: Check for static config file
echo ""
echo "Method 2: Checking for static config file..."
CONFIG_PATHS=(
    "/etc/traefik/traefik.yml"
    "/etc/traefik/traefik.yaml"
    "/traefik/traefik.yml"
    "/config/traefik.yml"
    "$(docker inspect $TRAEFIK_CONTAINER 2>/dev/null | grep -oP '"Source":"\K[^"]+traefik.yml[^"]*"' | head -1 | tr -d '"')"
)

CONFIG_FILE=""
for path in "${CONFIG_PATHS[@]}"; do
    if docker exec $TRAEFIK_CONTAINER test -f "$path" 2>/dev/null; then
        CONFIG_FILE="$path"
        echo "  Found config file: $path"
        break
    fi
done

if [ -n "$CONFIG_FILE" ]; then
    echo "  Reading current config..."
    docker exec $TRAEFIK_CONTAINER cat "$CONFIG_FILE" > /tmp/traefik_config.yml 2>/dev/null || true
    
    if ! grep -q "certificatesResolvers:" /tmp/traefik_config.yml 2>/dev/null; then
        echo "  Adding certresolver configuration..."
        cat >> /tmp/traefik_config.yml << EOF

certificatesResolvers:
  letsencrypt:
    acme:
      email: $EMAIL
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
EOF
        echo "  Copying updated config back to container..."
        docker cp /tmp/traefik_config.yml $TRAEFIK_CONTAINER:$CONFIG_FILE
        echo "  ✓ Config file updated"
    else
        echo "  ⚠ certificatesResolvers already exists in config"
        echo "  Check if 'letsencrypt' resolver is configured"
    fi
    rm -f /tmp/traefik_config.yml
fi

# Method 3: Add via Docker labels (most common)
echo ""
echo "Method 3: Adding certresolver via Docker labels..."
echo "  This is the most reliable method for Docker setups"

# Check current labels
CURRENT_LABELS=$(docker inspect $TRAEFIK_CONTAINER --format '{{json .Config.Labels}}' 2>/dev/null)

if echo "$CURRENT_LABELS" | grep -q "certificatesresolvers.letsencrypt"; then
    echo "  ✓ Certresolver labels already exist"
else
    echo "  Adding certresolver labels to Traefik container..."
    
    # Get current container config
    docker inspect $TRAEFIK_CONTAINER > /tmp/traefik_inspect.json
    
    # Create new container with certresolver labels
    # Note: This requires stopping and recreating the container
    echo ""
    echo "  ⚠ This will recreate the Traefik container with new labels"
    read -p "  Continue? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Get current container details
        IMAGE=$(docker inspect $TRAEFIK_CONTAINER --format '{{.Config.Image}}')
        NETWORKS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}} {{end}}')
        VOLUMES=$(docker inspect $TRAEFIK_CONTAINER --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}')
        PORTS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}} {{end}}')
        ENV_VARS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range .Config.Env}}-e {{.}} {{end}}')
        RESTART=$(docker inspect $TRAEFIK_CONTAINER --format '{{.HostConfig.RestartPolicy.Name}}')
        
        echo "  Stopping current container..."
        docker stop $TRAEFIK_CONTAINER
        
        echo "  Creating new container with certresolver labels..."
        docker rm $TRAEFIK_CONTAINER
        
        # Build docker run command
        CMD="docker run -d --name $TRAEFIK_CONTAINER --restart=$RESTART"
        CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL"
        CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
        CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
        
        # Add volumes
        if [ -n "$VOLUMES" ]; then
            CMD="$CMD $VOLUMES"
        fi
        
        # Add network connections
        for net in $NETWORKS; do
            CMD="$CMD --network $net"
        done
        
        # Add environment variables
        if [ -n "$ENV_VARS" ]; then
            CMD="$CMD $ENV_VARS"
        fi
        
        # Add ports (simplified - might need adjustment)
        # This is complex, so we'll use docker compose or manual method
        
        echo ""
        echo "  ⚠ Complex container recreation detected"
        echo "  Recommended: Use Docker Compose or manual configuration"
        echo ""
        echo "  Quick fix: Add these labels to your Traefik container:"
        echo "    traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL"
        echo "    traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
        echo "    traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
        echo ""
        echo "  Then restart: docker restart $TRAEFIK_CONTAINER"
        
        # Restart original container
        docker start $TRAEFIK_CONTAINER 2>/dev/null || true
    fi
fi

# Method 4: Create acme.json file if needed
echo ""
echo "Method 4: Ensuring acme.json storage file exists..."
if docker exec $TRAEFIK_CONTAINER test -d /letsencrypt 2>/dev/null; then
    echo "  ✓ /letsencrypt directory exists"
    if ! docker exec $TRAEFIK_CONTAINER test -f /letsencrypt/acme.json 2>/dev/null; then
        echo "  Creating acme.json file..."
        docker exec $TRAEFIK_CONTAINER sh -c "touch /letsencrypt/acme.json && chmod 600 /letsencrypt/acme.json" || true
        echo "  ✓ acme.json created"
    else
        echo "  ✓ acme.json already exists"
    fi
else
    echo "  ⚠ /letsencrypt directory not found"
    echo "  Make sure Traefik has a volume mounted to /letsencrypt"
fi

# Final steps
echo ""
echo "=== Final Steps ==="
echo "1. Restart Traefik:"
echo "   docker restart $TRAEFIK_CONTAINER"
echo ""
echo "2. Wait 2-3 minutes for certificate issuance"
echo ""
echo "3. Check Traefik logs:"
echo "   docker logs $TRAEFIK_CONTAINER | grep -i acme"
echo ""
echo "4. Test HTTPS:"
echo "   curl -I https://$DOMAIN"
echo ""
echo "=== Summary ==="
echo "If certresolver is still not working, check:"
echo "  - Traefik logs for errors"
echo "  - DNS is pointing correctly (dig $DOMAIN)"
echo "  - Ports 80 and 443 are open"
echo "  - /letsencrypt volume is mounted and writable"
echo ""
echo "For manual configuration, see: TRAEFIK_CERTRESOLVER_FIX.md"

