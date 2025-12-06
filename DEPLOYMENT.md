# Deployment Guide

This guide helps you deploy trailerio on your VPS.

## Quick Start

### Step 1: Check Your Current Setup

First, let's see what you have running:

```bash
# On your VPS
./check-vps-setup.sh
```

This will show you:
- Running Docker containers
- Nginx configuration
- Active ports
- Existing app directories

### Step 2: Choose Your Deployment Method

You have two options:

#### A) Subdomain (Recommended)
- URL: `trailerio.your-domain.com` (or any subdomain you prefer)
- Easier to manage
- Better for SEO
- Requires DNS A record pointing to your VPS

#### B) Path-based
- URL: `your-domain.com/trailerio`
- No DNS changes needed
- Requires code changes for base path

### Step 3: Deploy

#### Automated Setup (Easiest)

```bash
# On your VPS
sudo ./setup-vps.sh
```

Follow the prompts to:
1. Enter your git repository URL
2. Choose subdomain or path-based setup
3. Configure Nginx automatically

#### Manual Setup

```bash
# 1. Clone repository
cd /opt
git clone <your-repo-url> trailerio
cd trailerio

# 2. Create .env file with TMDB API key
echo "TMDB_API_KEY=your_tmdb_api_key" > .env

# 3. Build and start
docker compose up -d --build

# 4. Configure Nginx (see below)
```

## Nginx Configuration

### Subdomain Setup

1. **Copy the config:**
   ```bash
   cp nginx-subdomain.conf /etc/nginx/sites-available/trailerio
   ```

2. **Edit if needed:**
   ```bash
   nano /etc/nginx/sites-available/trailerio
   # Change server_name to your desired subdomain
   ```

3. **Enable:**
   ```bash
   ln -s /etc/nginx/sites-available/trailerio /etc/nginx/sites-enabled/
   nginx -t
   systemctl reload nginx
   ```

4. **Add DNS A record:**
   - Go to your DNS provider
   - Add: `trailerio` → `A` → `your-vps-ip`

5. **Enable SSL:**
   ```bash
   certbot --nginx -d trailerio.your-domain.com
   ```

### Path-based Setup

1. **Find your main nginx config:**
   ```bash
   ls -la /etc/nginx/sites-enabled/
   # Usually something like "your-domain.com" or "default"
   ```

2. **Edit it:**
   ```bash
   nano /etc/nginx/sites-enabled/your-domain.com  # or your main config
   ```

3. **Add this inside your `server` block:**
   ```nginx
   location /trailerio {
       rewrite ^/trailerio/?(.*)$ /$1 break;
       proxy_pass http://localhost:8081;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

4. **Reload:**
   ```bash
   nginx -t
   systemctl reload nginx
   ```

5. **Update code for base path** (see next section)

## Path-based Routing Code Changes

If using path-based routing, update these files:

### 1. Update `vite.config.ts`:

```typescript
export default defineConfig({
  base: '/trailerio/',  // Add this
  // ... rest of config
});
```

### 2. Update `src/App.tsx`:

```typescript
<BrowserRouter basename="/trailerio">
  <Routes>
    {/* ... */}
  </Routes>
</BrowserRouter>
```

### 3. Rebuild:

```bash
docker compose up -d --build
```

## Common Commands

```bash
# View logs
cd /opt/trailerio
docker compose logs -f

# Restart
docker compose restart

# Update
git pull
docker compose up -d --build

# Stop
docker compose down

# Check status
docker compose ps
```

## Troubleshooting

### Container won't start
```bash
docker compose logs
# Check for errors in the output
```

### Port 8081 already in use
Edit `docker-compose.yml` and change the port:
```yaml
ports:
  - "8082:80"  # Change 8081 to 8082
```

### Nginx 502 Bad Gateway
- Check if container is running: `docker compose ps`
- Check container logs: `docker compose logs`
- Verify proxy_pass port matches docker-compose port

### Can't access the app
1. Check firewall: `ufw status`
2. Verify container: `docker compose ps`
3. Test direct access: `curl http://localhost:8081`
4. Check nginx config: `nginx -t`

## Integration with Existing Apps

The app runs on port **8081** to avoid conflicts. Your existing nginx on port 80 will proxy to it.

If you have other apps:
- Each should use a different port (8082, 8083, etc.)
- Configure nginx to route to the correct port
- Use subdomains or different paths

## Environment Variables

Create a `.env` file in the project root:

```bash
TMDB_API_KEY=your_tmdb_api_key_here
```

Then update `docker-compose.yml` to include it:

```yaml
services:
  backend:
    # ... existing config ...
    env_file:
      - .env
```

**Note:** Get your free TMDB API key from https://www.themoviedb.org/settings/api
