#!/bin/bash
# Find and configure Traefik SSL - More flexible container detection
set -e

EMAIL="${1:-mousa@hey.com}"

echo "=== Find and Configure Traefik SSL ==="
echo "Email: $EMAIL"
echo ""

# Find Traefik container - try multiple methods
echo "Searching for Traefik container..."

# Method 1: Exact name match
TRAEFIK_CONTAINER=$(docker ps --format "{{.Names}}" | grep -iE "^traefik$" | head -1)

# Method 2: Name contains traefik
if [ -z "$TRAEFIK_CONTAINER" ]; then
    TRAEFIK_CONTAINER=$(docker ps --format "{{.Names}}" | grep -i traefik | head -1)
fi

# Method 3: Check all containers
if [ -z "$TRAEFIK_CONTAINER" ]; then
    echo "Listing all running containers:"
    docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
    echo ""
    echo "Please enter the Traefik container name:"
    read TRAEFIK_CONTAINER
fi

# Method 4: Check stopped containers too
if [ -z "$TRAEFIK_CONTAINER" ]; then
    TRAEFIK_CONTAINER=$(docker ps -a --format "{{.Names}}" | grep -i traefik | head -1)
    if [ -n "$TRAEFIK_CONTAINER" ]; then
        echo "Found stopped Traefik container: $TRAEFIK_CONTAINER"
        echo "Starting it first..."
        docker start $TRAEFIK_CONTAINER
        sleep 2
    fi
fi

if [ -z "$TRAEFIK_CONTAINER" ]; then
    echo "✗ Traefik container not found"
    echo ""
    echo "Available containers:"
    docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
    echo ""
    echo "Please run: docker ps -a"
    echo "And manually identify the Traefik container name"
    exit 1
fi

echo "✓ Found Traefik: $TRAEFIK_CONTAINER"
echo ""

# Verify it's actually Traefik
IMAGE=$(docker inspect $TRAEFIK_CONTAINER --format '{{.Config.Image}}' 2>/dev/null || echo "")
if [[ ! "$IMAGE" =~ traefik ]]; then
    echo "⚠ Warning: Container image is '$IMAGE' - doesn't look like Traefik"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Get full container details
echo "Inspecting Traefik container..."
docker inspect $TRAEFIK_CONTAINER > /tmp/traefik_inspect.json 2>/dev/null || {
    echo "✗ Cannot inspect container. Is it running?"
    docker ps -a | grep $TRAEFIK_CONTAINER
    exit 1
}

# Extract key information
RESTART=$(docker inspect $TRAEFIK_CONTAINER --format '{{.HostConfig.RestartPolicy.Name}}')
NETWORKS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}} {{end}}' | tr ' ' '\n' | grep -v '^$')
ENV_VARS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}')
MOUNTS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}} {{end}}')
PORTS=$(docker port $TRAEFIK_CONTAINER 2>/dev/null | awk '{print "-p " $0}' | tr '\n' ' ' || echo "")

echo "Image: $IMAGE"
echo "Restart: $RESTART"
echo "Networks: $NETWORKS"
echo ""

# Check if /letsencrypt volume exists
HAS_LETSENCRYPT_VOLUME=false
if docker exec $TRAEFIK_CONTAINER test -d /letsencrypt 2>/dev/null; then
    HAS_LETSENCRYPT_VOLUME=true
    echo "✓ /letsencrypt directory exists in container"
else
    echo "⚠ /letsencrypt directory not found"
    echo "  Will create volume mount"
fi

# Check current labels
CURRENT_LABELS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}')

if echo "$CURRENT_LABELS" | grep -q "certificatesresolvers.letsencrypt"; then
    echo "⚠ Certresolver labels already exist:"
    echo "$CURRENT_LABELS" | grep letsencrypt
    echo ""
    read -p "Recreate anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Configuration already exists. Restarting Traefik..."
        docker restart $TRAEFIK_CONTAINER
        echo "Done!"
        exit 0
    fi
fi

echo ""
echo "⚠ This will stop and recreate the Traefik container"
echo "  Make sure you have access to restore it if needed"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Stop container
echo ""
echo "Stopping Traefik container..."
docker stop $TRAEFIK_CONTAINER

# Create /letsencrypt directory on host if needed
LETSENCRYPT_HOST="/opt/traefik/letsencrypt"
if [ ! -d "$LETSENCRYPT_HOST" ]; then
    echo "Creating /letsencrypt directory on host..."
    mkdir -p "$LETSENCRYPT_HOST"
    chmod 755 "$LETSENCRYPT_HOST"
fi

# Build docker run command
echo ""
echo "Building docker run command..."

CMD="docker run -d --name $TRAEFIK_CONTAINER"

# Add restart policy
if [ "$RESTART" != "no" ]; then
    CMD="$CMD --restart=$RESTART"
fi

# Add certresolver labels
CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.email=$EMAIL"
CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
CMD="$CMD -l traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"

# Add existing labels (preserve them)
while IFS= read -r label; do
    if [[ $label == *"="* ]] && [[ $label != *"letsencrypt"* ]]; then
        KEY=$(echo "$label" | cut -d'=' -f1)
        VALUE=$(echo "$label" | cut -d'=' -f2-)
        # Escape special characters in value
        VALUE=$(echo "$VALUE" | sed 's/"/\\"/g')
        CMD="$CMD -l \"$KEY=$VALUE\""
    fi
done <<< "$CURRENT_LABELS"

# Add networks
for net in $NETWORKS; do
    CMD="$CMD --network $net"
done

# Add volumes (preserve existing + add /letsencrypt)
if [ -n "$MOUNTS" ]; then
    CMD="$CMD $MOUNTS"
fi
# Add /letsencrypt volume
CMD="$CMD -v $LETSENCRYPT_HOST:/letsencrypt"

# Add environment variables
while IFS= read -r env_var; do
    if [ -n "$env_var" ]; then
        # Escape quotes
        env_var=$(echo "$env_var" | sed 's/"/\\"/g')
        CMD="$CMD -e \"$env_var\""
    fi
done <<< "$ENV_VARS"

# Add ports
if [ -n "$PORTS" ]; then
    CMD="$CMD $PORTS"
fi

# Add image
CMD="$CMD $IMAGE"

# Remove old container
echo "Removing old container..."
docker rm $TRAEFIK_CONTAINER

# Show the command (for debugging)
echo ""
echo "Recreating container with certresolver configuration..."
echo ""

# Execute - use eval to handle quotes properly
eval $CMD

# Create acme.json if it doesn't exist
echo ""
echo "Creating acme.json file..."
sleep 2  # Wait for container to start
docker exec $TRAEFIK_CONTAINER sh -c "touch /letsencrypt/acme.json && chmod 600 /letsencrypt/acme.json" 2>/dev/null || {
    echo "⚠ Could not create acme.json in container"
    echo "  Creating on host instead..."
    touch "$LETSENCRYPT_HOST/acme.json"
    chmod 600 "$LETSENCRYPT_HOST/acme.json"
    echo "  You may need to restart Traefik: docker restart $TRAEFIK_CONTAINER"
}

# Verify labels were added
echo ""
echo "Verifying configuration..."
sleep 1
NEW_LABELS=$(docker inspect $TRAEFIK_CONTAINER --format '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' 2>/dev/null | grep letsencrypt || echo "")
if [ -n "$NEW_LABELS" ]; then
    echo "✓ Certresolver labels added:"
    echo "$NEW_LABELS"
else
    echo "⚠ Could not verify labels (container may still be starting)"
    echo "  Check manually: docker inspect $TRAEFIK_CONTAINER | grep letsencrypt"
fi

echo ""
echo "=== Success! ==="
echo "Traefik container recreated with certresolver configuration"
echo ""
echo "Next steps:"
echo "1. Check Traefik is running: docker ps | grep $TRAEFIK_CONTAINER"
echo "2. Check logs: docker logs $TRAEFIK_CONTAINER | grep -i acme"
echo "3. Wait 2-3 minutes for certificate issuance"
echo "4. Test: curl -I https://trailerio.plaio.cc"
echo ""
echo "If you see certificate errors, check:"
echo "  - DNS: dig trailerio.plaio.cc"
echo "  - Port 80 is accessible"
echo "  - Traefik logs: docker logs $TRAEFIK_CONTAINER"

