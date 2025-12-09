#!/bin/bash
# Simple check for actual Traefik process
echo "=== Checking for Traefik Process ==="
echo ""

# Check for traefik binary in process list (excluding this script)
ps aux | grep -i traefik | grep -v grep | grep -v "find-traefik" | grep -v "check-traefik" | grep -v "bash.*traefik" | while read line; do
    if [[ "$line" =~ traefik ]]; then
        echo "✓ Found Traefik process:"
        echo "$line"
        PID=$(echo "$line" | awk '{print $2}')
        echo ""
        echo "Process details:"
        ps -p $PID -f 2>/dev/null || echo "  (Process may have exited)"
        echo ""
        echo "Checking for config file..."
        # Try to find config file from process
        CMD=$(ps -p $PID -o cmd= 2>/dev/null)
        if [[ "$CMD" =~ --configfile= ]]; then
            CONFIG=$(echo "$CMD" | grep -oP '--configfile=\K[^\s]+')
            echo "  Config: $CONFIG"
        elif [[ "$CMD" =~ -c\s+ ]]; then
            CONFIG=$(echo "$CMD" | grep -oP '-c\s+\K[^\s]+')
            echo "  Config: $CONFIG"
        else
            echo "  Check: /etc/traefik/traefik.yml"
        fi
        exit 0
    fi
done

echo "No Traefik process found"
echo ""
echo "Checking if Traefik might be in a different network namespace or container..."
echo ""

# Check for Traefik listening on ports 80/443
echo "Checking for services listening on ports 80 and 443:"
netstat -tlnp 2>/dev/null | grep -E ':80 |:443 ' | head -5
echo ""

# Check systemd
echo "Checking systemd services:"
systemctl list-units --type=service --all | grep -i traefik || echo "  No Traefik systemd service found"
echo ""

# Check for Traefik config files
echo "Checking for Traefik config files:"
find /etc /opt /root -name "*traefik*.yml" -o -name "*traefik*.yaml" -o -name "*traefik*.toml" 2>/dev/null | head -5
echo ""

echo "If Traefik is running but not found, it might be:"
echo "  - In a different network namespace"
echo "  - Running in a container we can't see"
echo "  - Managed by a different user"
echo ""
echo "Since your docker-compose.yml has Traefik labels, Traefik must be"
echo "running somewhere and watching Docker containers. Check:"
echo "  - docker network ls (to see networks)"
echo "  - Check if Traefik is on the 'plaio_default' network"

