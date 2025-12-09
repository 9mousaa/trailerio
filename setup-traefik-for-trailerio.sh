#!/bin/bash
# Setup Traefik for TrailerIO if it doesn't exist
set -e

EMAIL="${1:-mousa@hey.com}"
DOMAIN="trailerio.plaio.cc"

echo "=== Setting Up Traefik for TrailerIO ==="
echo "Email: $EMAIL"
echo "Domain: $DOMAIN"
echo ""

# Check if anything is listening on 80/443
echo "Checking what's listening on ports 80 and 443..."
if command -v ss >/dev/null 2>&1; then
    LISTENING=$(ss -tlnp | grep -E ':80 |:443 ' || echo "")
else
    LISTENING=$(netstat -tlnp 2>/dev/null | grep -E ':80 |:443 ' || echo "")
fi

if [ -n "$LISTENING" ]; then
    echo "Found services on ports 80/443:"
    echo "$LISTENING"
    echo ""
    read -p "Continue setting up Traefik? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Check if Traefik container exists
if docker ps -a | grep -qi traefik; then
    echo "⚠ Traefik container exists but may not be running"
    docker ps -a | grep -i traefik
    echo ""
    read -p "Recreate Traefik container? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        docker stop traefik 2>/dev/null || true
        docker rm traefik 2>/dev/null || true
    else
        echo "Starting existing Traefik container..."
        docker start traefik
        sleep 2
        if docker ps | grep -q traefik; then
            echo "✓ Traefik is now running"
            echo "Now configure certresolver - see TRAEFIK_CERTRESOLVER_FIX.md"
            exit 0
        fi
    fi
fi

# Create directories
echo "Creating directories..."
mkdir -p /opt/traefik/letsencrypt
chmod 755 /opt/traefik/letsencrypt
touch /opt/traefik/letsencrypt/acme.json
chmod 600 /opt/traefik/letsencrypt/acme.json

# Create Traefik config
echo "Creating Traefik configuration..."
cat > /opt/traefik/traefik.yml <<EOF
api:
  dashboard: true
  insecure: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: plaio_default
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: $EMAIL
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web

log:
  level: INFO
EOF

# Create dynamic config
cat > /opt/traefik/dynamic.yml <<EOF
http:
  middlewares:
    default-headers:
      headers:
        sslRedirect: true
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        stsPreload: true
        forceSTSHeader: true
        frameDeny: true
        contentTypeNosniff: true
        browserXssFilter: true
EOF

echo "✓ Configuration files created"

# Create docker-compose for Traefik
echo "Creating Traefik docker-compose.yml..."
cat > /opt/traefik/docker-compose.yml <<EOF
version: '3.8'

services:
  traefik:
    image: traefik:v2.10
    container_name: traefik
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - /opt/traefik/dynamic.yml:/etc/traefik/dynamic.yml:ro
      - /opt/traefik/letsencrypt:/letsencrypt
    networks:
      - plaio_default
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.rule=Host(\`traefik.plaio.cc\`)"
      - "traefik.http.routers.traefik.entrypoints=websecure"
      - "traefik.http.routers.traefik.tls.certresolver=letsencrypt"
      - "traefik.http.routers.traefik.service=api@internal"
      - "traefik.http.routers.traefik.middlewares=auth"
      - "traefik.http.middlewares.auth.basicauth.users=admin:\$\$apr1\$\$... (set password with: htpasswd -nb admin password)"

networks:
  plaio_default:
    external: true
EOF

echo "✓ Docker Compose file created at /opt/traefik/docker-compose.yml"
echo ""

# Check if plaio_default network exists
if ! docker network ls | grep -q plaio_default; then
    echo "⚠ plaio_default network doesn't exist"
    echo "Creating it..."
    docker network create plaio_default
fi

# Start Traefik
echo "Starting Traefik..."
cd /opt/traefik
docker compose up -d

sleep 3

# Verify it's running
if docker ps | grep -q traefik; then
    echo ""
    echo "=== Success! ==="
    echo "✓ Traefik is now running"
    echo ""
    echo "Check status:"
    echo "  docker ps | grep traefik"
    echo ""
    echo "Check logs:"
    echo "  docker logs traefik"
    echo ""
    echo "Wait 2-3 minutes for SSL certificate to be issued"
    echo "Then test: curl -I https://$DOMAIN"
    echo ""
    echo "Traefik dashboard (if configured):"
    echo "  https://traefik.plaio.cc (if you set up basic auth)"
else
    echo ""
    echo "✗ Traefik failed to start"
    echo "Check logs: docker logs traefik"
    exit 1
fi

