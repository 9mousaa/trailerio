# Traefik Setup Guide

Since you're using **Traefik** as your reverse proxy (not Nginx), here's the simplified setup:

## Quick One-Liner Setup

```bash
# Upload setup-traefik.sh to your VPS, then:
chmod +x setup-traefik.sh
sudo ./setup-traefik.sh https://github.com/YOUR_USERNAME/trailerio.git trailerio
```

Replace `YOUR_USERNAME` with your GitHub username.

## Manual Setup

### Step 1: Find Traefik Network

```bash
# Check Traefik's network
docker inspect traefik | grep -A 10 Networks

# Or list all networks
docker network ls
```

Common Traefik network names: `traefik`, `traefik_default`, `web`

### Step 2: Clone and Configure

```bash
cd /opt
git clone https://github.com/YOUR_USERNAME/trailerio.git trailerio
cd trailerio
```

### Step 3: Update docker-compose.yml

The file is already configured for Traefik, but you may need to adjust the network name:

```yaml
networks:
  traefik:  # Change this to match your Traefik network name
    external: true
```

### Step 4: Build and Start

```bash
docker compose up -d --build
```

### Step 5: Add DNS Record

Add DNS A record:
- **Subdomain**: `trailerio` (or your chosen subdomain)
- **Type**: A
- **Value**: Your VPS IP (`143.110.166.25`)

Traefik will automatically:
- ✅ Route traffic to your container
- ✅ Handle SSL/HTTPS via Let's Encrypt
- ✅ Renew certificates automatically

## Verify Setup

```bash
# Check container
docker ps | grep trailerio

# Check logs
cd /opt/trailerio && docker compose logs -f

# Check Traefik dashboard (if enabled)
# Usually at: http://your-vps-ip:8080
```

## Traefik Labels Explained

The docker-compose.yml includes these Traefik labels:

- `traefik.enable=true` - Enable Traefik for this service
- `traefik.http.routers.trailerio.rule=Host(...)` - Route based on hostname
- `traefik.http.routers.trailerio.entrypoints=web,websecure` - Use HTTP and HTTPS entrypoints
- `traefik.http.routers.trailerio.tls.certresolver=letsencrypt` - Auto SSL
- `traefik.http.services.trailerio.loadbalancer.server.port=80` - Container port

## Troubleshooting

### Container not accessible

1. **Check if container is running:**
   ```bash
   docker ps | grep trailerio
   ```

2. **Check Traefik network:**
   ```bash
   docker network inspect traefik
   # Make sure trailerio container is connected
   ```

3. **Check Traefik logs:**
   ```bash
   docker logs traefik
   ```

4. **Verify DNS:**
   ```bash
   nslookup trailerio.plaio.cc
   ```

### Network not found error

If you get "network not found", update docker-compose.yml with the correct network name:

```bash
# Find Traefik network
docker inspect traefik | grep -A 5 Networks

# Update docker-compose.yml
nano docker-compose.yml
# Change network name under 'networks:' section
```

### SSL not working

Traefik should auto-generate SSL. If not:

1. Check Traefik config for Let's Encrypt
2. Verify DNS is pointing correctly
3. Check Traefik logs: `docker logs traefik`

## Update Commands

```bash
cd /opt/trailerio
git pull
docker compose up -d --build
```

## Common Traefik Network Names

If the default `traefik` network doesn't work, try:

- `traefik_default`
- `web`
- `traefik_web`
- Check with: `docker network ls`

