# Quick Deployment Commands

## Step 1: Check Your Current VPS Setup

Run these commands on your VPS to understand your setup:

```bash
# Upload vps-diagnostics.sh to your VPS first, then:
chmod +x vps-diagnostics.sh
./vps-diagnostics.sh
```

Or run these commands directly:

```bash
# Check Docker
docker ps -a
docker compose version

# Check Nginx
nginx -v
ls -la /etc/nginx/sites-enabled/
cat /etc/nginx/sites-enabled/* | grep server_name

# Check ports
ss -tulpn | grep LISTEN

# Check existing apps
ls -la /opt/
ls -la /var/www/

# Check Docker Compose files
find /opt /var/www -name "docker-compose.yml" 2>/dev/null
```

## Step 2: One-Liner Setup

### Option A: With Git Repository URL

```bash
# Upload one-liner-setup.sh to your VPS, then:
chmod +x one-liner-setup.sh
sudo ./one-liner-setup.sh https://github.com/yourusername/trailerio.git trailerio
```

Replace:
- `https://github.com/yourusername/trailerio.git` with your actual repo URL
- `trailerio` with your desired subdomain (optional, defaults to "trailerio")

### Option B: Direct from GitHub (if public repo)

```bash
curl -fsSL https://raw.githubusercontent.com/yourusername/trailerio/main/one-liner-setup.sh | sudo bash -s -- https://github.com/yourusername/trailerio.git trailerio
```

### Option C: Manual One-Liner (copy-paste ready)

```bash
sudo bash -c 'cd /opt && git clone https://github.com/yourusername/trailerio.git trailerio && cd trailerio && sed -i "s/\"80:80\"/\"8081:80\"/g" docker-compose.yml 2>/dev/null || true && docker compose up -d --build && echo "server { listen 80; server_name trailerio.plaio.cc; location / { proxy_pass http://localhost:8081; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; } }" > /etc/nginx/sites-available/trailerio && ln -sf /etc/nginx/sites-available/trailerio /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx'
```

**Replace `https://github.com/yourusername/trailerio.git` with your actual repo URL!**

## Step 3: Setup DNS (if using subdomain)

```bash
# Add DNS A record pointing to your VPS IP
# Subdomain: trailerio
# Type: A
# Value: your-vps-ip-address
```

## Step 4: Enable SSL (optional but recommended)

```bash
sudo certbot --nginx -d trailerio.plaio.cc
```

## Quick Commands Reference

```bash
# View logs
cd /opt/trailerio && docker compose logs -f

# Restart app
cd /opt/trailerio && docker compose restart

# Update app
cd /opt/trailerio && git pull && docker compose up -d --build

# Stop app
cd /opt/trailerio && docker compose down

# Check status
cd /opt/trailerio && docker compose ps

# Check if port is accessible
curl http://localhost:8081
```

## Troubleshooting

### Container won't start
```bash
cd /opt/trailerio
docker compose logs
docker compose ps
```

### Port conflict
```bash
# Check what's using port 8081
ss -tulpn | grep 8081

# Change port in docker-compose.yml
nano docker-compose.yml  # Change "8081:80" to "8082:80"
docker compose up -d --build
```

### Nginx 502 error
```bash
# Check if container is running
docker ps | grep trailerio

# Check nginx config
nginx -t

# Check logs
docker compose logs
tail -f /var/log/nginx/error.log
```

### Can't access subdomain
```bash
# Check DNS
nslookup trailerio.plaio.cc

# Check nginx config
cat /etc/nginx/sites-enabled/trailerio

# Test nginx
curl -H "Host: trailerio.plaio.cc" http://localhost
```

