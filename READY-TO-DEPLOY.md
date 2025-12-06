# Ready to Deploy! 🚀

Your setup is configured for:
- **Network**: `plaio_default` (detected from your Traefik)
- **Repo**: `https://github.com/9mousaa/trailerio`
- **Domain**: `plaio.cc`

## Quick Deploy (Recommended)

### Option 1: Using the Script

```bash
# Upload DEPLOY-NOW.sh to your VPS, then:
chmod +x DEPLOY-NOW.sh
sudo ./DEPLOY-NOW.sh trailerio
```

The `trailerio` parameter is optional (defaults to "trailerio" subdomain).

### Option 2: One-Liner (Copy-Paste Ready)

```bash
sudo bash -c 'REPO="https://github.com/9mousaa/trailerio" && SUBDOMAIN="trailerio" && DIR="/opt/trailerio" && NETWORK="plaio_default" && command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh) && docker compose version >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y docker-compose-plugin) && mkdir -p /opt && (cd /opt && ([ -d trailerio ] && (cd trailerio && git pull)) || git clone "$REPO" trailerio) && cd "$DIR" && cat > docker-compose.yml <<EOF
version: '\''3.8'\''
services:
  web:
    build: { context: ., dockerfile: Dockerfile }
    restart: unless-stopped
    environment: [NODE_ENV=production]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.trailerio.rule=Host(\`$SUBDOMAIN.plaio.cc\`)"
      - "traefik.http.routers.trailerio.entrypoints=web"
      - "traefik.http.routers.trailerio.entrypoints=websecure"
      - "traefik.http.routers.trailerio.tls.certresolver=letsencrypt"
      - "traefik.http.services.trailerio.loadbalancer.server.port=80"
    networks: [$NETWORK]
networks:
  $NETWORK: { external: true }
EOF
docker compose down 2>/dev/null; docker compose up -d --build && sleep 3 && echo "✅ Done! Add DNS: $SUBDOMAIN -> $(hostname -I | awk '\''{print $1}'\'')"'
```

### Option 3: Step-by-Step

```bash
# 1. Clone repo
cd /opt && git clone https://github.com/9mousaa/trailerio.git trailerio

# 2. Build and start (docker-compose.yml is already configured)
cd /opt/trailerio && docker compose up -d --build

# 3. Check status
docker compose ps
docker compose logs -f
```

## After Deployment

1. **Add DNS A Record:**
   - Subdomain: `trailerio`
   - Type: A
   - Value: `143.110.166.25`

2. **Traefik will automatically:**
   - ✅ Route traffic to your container
   - ✅ Handle SSL/HTTPS via Let's Encrypt
   - ✅ Renew certificates automatically

3. **Access your app:**
   - After DNS propagates: `https://trailerio.plaio.cc`

## Verify Deployment

```bash
# Check container
docker ps | grep trailerio

# Check logs
cd /opt/trailerio && docker compose logs -f

# Check Traefik routing
docker logs traefik | grep trailerio

# Test direct access (before DNS)
curl -H "Host: trailerio.plaio.cc" http://localhost
```

## Update Commands

```bash
cd /opt/trailerio
git pull
docker compose up -d --build
```

## Troubleshooting

### Container won't start
```bash
cd /opt/trailerio
docker compose logs
docker compose ps
```

### Network error
If you get "network plaio_default not found":
```bash
# Verify network exists
docker network ls | grep plaio_default

# If it doesn't exist, check Traefik network
docker inspect traefik | grep -A 10 Networks
```

### Can't access after DNS
1. Wait 5-10 minutes for DNS propagation
2. Check DNS: `nslookup trailerio.plaio.cc`
3. Check Traefik logs: `docker logs traefik | tail -50`
4. Verify container: `docker ps | grep trailerio`

## Configuration Details

- **Network**: `plaio_default` (your Traefik network)
- **Port**: Container uses port 80 internally (Traefik handles external routing)
- **SSL**: Automatic via Let's Encrypt (Traefik handles this)
- **Subdomain**: `trailerio.plaio.cc` (change in docker-compose.yml if needed)

Everything is ready! Just run the deployment command above. 🎉

