#!/bin/bash
# Find Traefik wherever it might be running
set -e

echo "=== Finding Traefik Installation ==="
echo ""

# Method 1: Check for Traefik process
echo "Method 1: Checking for Traefik process..."
TRAEFIK_PID=$(pgrep -f traefik | head -1)
if [ -n "$TRAEFIK_PID" ]; then
    echo "✓ Found Traefik process (PID: $TRAEFIK_PID)"
    ps aux | grep $TRAEFIK_PID | grep -v grep
    echo ""
    echo "Traefik is running as a process, not in Docker"
    echo "You'll need to configure it via config file or systemd service"
    exit 0
fi

# Method 2: Check Docker containers (all, including stopped)
echo "Method 2: Checking all Docker containers..."
TRAEFIK_CONTAINER=$(docker ps -a --format "{{.Names}}" | grep -i traefik | head -1)
if [ -n "$TRAEFIK_CONTAINER" ]; then
    echo "✓ Found Traefik container: $TRAEFIK_CONTAINER"
    docker ps -a | grep $TRAEFIK_CONTAINER
    echo ""
    echo "Container found but not running. Status:"
    docker inspect $TRAEFIK_CONTAINER --format '{{.State.Status}}' 2>/dev/null
    exit 0
fi

# Method 3: Check systemd service
echo "Method 3: Checking systemd services..."
if systemctl list-units --type=service | grep -i traefik > /dev/null 2>&1; then
    echo "✓ Found Traefik systemd service"
    systemctl status traefik --no-pager | head -10
    echo ""
    echo "Traefik is managed by systemd"
    echo "Config file location:"
    systemctl show traefik -p ExecStart --no-pager | grep -oP 'configFile=\K[^\s]+' || echo "Check: /etc/traefik/traefik.yml"
    exit 0
fi

# Method 4: Check common config locations
echo "Method 4: Checking common config file locations..."
CONFIG_LOCATIONS=(
    "/etc/traefik/traefik.yml"
    "/etc/traefik/traefik.yaml"
    "/opt/traefik/traefik.yml"
    "/root/.traefik/traefik.yml"
    "/home/*/traefik/traefik.yml"
)

for config in "${CONFIG_LOCATIONS[@]}"; do
    if [ -f "$config" ] 2>/dev/null; then
        echo "✓ Found Traefik config: $config"
        echo "  Checking for certresolver..."
        if grep -q "certificatesResolvers" "$config"; then
            echo "  Certresolver section exists"
            grep -A 5 "certificatesResolvers" "$config" | head -10
        else
            echo "  No certresolver configured"
        fi
        exit 0
    fi
done

# Method 5: Check for Traefik binary
echo "Method 5: Checking for Traefik binary..."
TRAEFIK_BIN=$(which traefik 2>/dev/null || find /usr/local/bin /usr/bin /opt -name traefik 2>/dev/null | head -1)
if [ -n "$TRAEFIK_BIN" ]; then
    echo "✓ Found Traefik binary: $TRAEFIK_BIN"
    $TRAEFIK_BIN version 2>/dev/null || echo "  (Could not get version)"
    exit 0
fi

# Method 6: Check docker-compose files
echo "Method 6: Checking for Traefik docker-compose files..."
COMPOSE_FILES=$(find /opt /home /root -name "docker-compose.yml" -o -name "docker-compose.yaml" 2>/dev/null | head -5)
for compose in $COMPOSE_FILES; do
    if grep -q "traefik" "$compose" 2>/dev/null; then
        echo "✓ Found docker-compose with Traefik: $compose"
        echo "  Checking Traefik service..."
        grep -A 10 "traefik:" "$compose" | head -15
        echo ""
        echo "To configure, edit this file and add certresolver labels"
        exit 0
    fi
done

# Not found
echo ""
echo "✗ Traefik not found in any of the common locations"
echo ""
echo "Since your docker-compose.yml references Traefik labels,"
echo "Traefik must be running somewhere else. Possible locations:"
echo ""
echo "1. Check if Traefik is running on the host (not in Docker):"
echo "   ps aux | grep traefik"
echo ""
echo "2. Check for systemd service:"
echo "   systemctl list-units | grep traefik"
echo ""
echo "3. Check for Traefik config file:"
echo "   find /etc /opt -name '*traefik*' 2>/dev/null"
echo ""
echo "4. Check if Traefik is in a different docker-compose:"
echo "   find /opt /home -name docker-compose.yml -exec grep -l traefik {} \\;"
echo ""
echo "5. Check if Traefik is managed by another service (like Portainer, etc.)"
echo ""
echo "Once you find Traefik, you can:"
echo "  - If it's a systemd service: Edit /etc/traefik/traefik.yml"
echo "  - If it's in docker-compose: Edit that docker-compose.yml"
echo "  - If it's a process: Find its config file and edit it"
echo ""
echo "Then add the certresolver configuration (see TRAEFIK_CERTRESOLVER_FIX.md)"

