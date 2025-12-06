# One-Liner Setup for Traefik

Since you're using **Traefik**, here are the commands:

## Step 1: Check Traefik Network (Optional)

```bash
docker inspect traefik | grep -A 10 Networks
```

This shows which network Traefik is using (usually `traefik`).

## Step 2: One-Liner Setup

### Option A: Using the Script (Recommended)

```bash
# Upload setup-traefik.sh to your VPS, then:
chmod +x setup-traefik.sh && sudo ./setup-traefik.sh https://github.com/YOUR_USERNAME/trailerio.git trailerio
```

### Option B: Pure One-Liner (Copy-Paste)

**Replace `YOUR_USERNAME` with your GitHub username!**

```bash
sudo bash -c 'REPO="https://github.com/YOUR_USERNAME/trailerio.git" && SUBDOMAIN="trailerio" && DIR="/opt/trailerio" && command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh) && docker compose version >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y docker-compose-plugin) && TRAEFIK_NET=$(docker inspect traefik 2>/dev/null | grep -oE "NetworkMode\": \"[^\"]+\"" | cut -d"\"" -f3 || docker network ls | grep traefik | head -1 | awk "{print \$2}" || echo "traefik") && [ "$TRAEFIK_NET" = "default" ] && TRAEFIK_NET="traefik" || true && mkdir -p /opt && (cd /opt && ([ -d trailerio ] && (cd trailerio && git pull)) || git clone "$REPO" trailerio) && cd "$DIR" && cat > docker-compose.yml <<EOFMARKER
version: '\''3.8'\''
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      - NODE_ENV=production
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.trailerio.rule=Host(\`$SUBDOMAIN.plaio.cc\`)"
      - "traefik.http.routers.trailerio.entrypoints=web"
      - "traefik.http.routers.trailerio.entrypoints=websecure"
      - "traefik.http.routers.trailerio.tls.certresolver=letsencrypt"
      - "traefik.http.services.trailerio.loadbalancer.server.port=80"
    networks:
      - $TRAEFIK_NET
networks:
  $TRAEFIK_NET:
    external: true
EOFMARKER
docker compose down 2>/dev/null; docker compose up -d --build && sleep 3 && echo "✅ Done! Add DNS: $SUBDOMAIN -> $(hostname -I | awk '\''{print $1}'\'')"'
```

### Option C: Simpler Step-by-Step

```bash
# 1. Install Docker (if needed)
curl -fsSL https://get.docker.com | sudo sh

# 2. Install Docker Compose (if needed)
sudo apt-get update && sudo apt-get install -y docker-compose-plugin

# 3. Find Traefik network
TRAEFIK_NET=$(docker inspect traefik | grep -A 5 Networks | grep -oE '"[^"]+"' | head -1 | tr -d '"' || echo "traefik")
echo "Using network: $TRAEFIK_NET"

# 4. Clone repo
sudo mkdir -p /opt && cd /opt && sudo git clone https://github.com/YOUR_USERNAME/trailerio.git trailerio

# 5. Update docker-compose.yml network (if needed)
cd /opt/trailerio
# Edit docker-compose.yml and change 'traefik' to $TRAEFIK_NET if different

# 6. Build and start
cd /opt/trailerio && sudo docker compose up -d --build
```

## Step 3: Add DNS Record

Add DNS A record:
- **Subdomain**: `trailerio`
- **Type**: A  
- **Value**: `143.110.166.25` (your VPS IP)

## Step 4: Verify

```bash
# Check container
docker ps | grep trailerio

# Check logs
cd /opt/trailerio && docker compose logs -f

# Test (after DNS propagates)
curl -I https://trailerio.plaio.cc
```

## Troubleshooting

### If network name is different

```bash
# Find actual network name
docker network ls
docker inspect traefik | grep -A 10 Networks

# Update docker-compose.yml
nano /opt/trailerio/docker-compose.yml
# Change 'traefik' under networks: to the correct name
```

### If container won't start

```bash
cd /opt/trailerio
docker compose logs
docker compose ps
```

### Check Traefik is routing

```bash
docker logs traefik | grep trailerio
```

## Update Commands

```bash
cd /opt/trailerio
git pull
docker compose up -d --build
```

