# Fix Traefik SSL Certificate Resolver

The error shows: `Router uses a non-existent certificate resolver certificateResolver=letsencrypt`

This means Traefik doesn't have a certificate resolver named "letsencrypt". 

## Quick Fix Options

### Option 1: Check what certificate resolver Traefik uses

```bash
# Check Traefik configuration
docker inspect traefik | grep -i "certresolver\|acme" -A 5

# Or check Traefik compose file
docker inspect traefik | grep -i "compose\|config" -A 10
```

### Option 2: Remove TLS requirement temporarily (to get it working)

Update docker-compose.yml to remove TLS:

```bash
cd /opt/trailerio
sed -i '/tls.certresolver/d' docker-compose.yml
docker compose up -d
```

### Option 3: Use HTTP only (no SSL) for now

Update docker-compose.yml to only use `web` entrypoint:

```bash
cd /opt/trailerio
sed -i 's/websecure/web/g' docker-compose.yml
sed -i '/tls.certresolver/d' docker-compose.yml
sed -i '/trailerio-http/d' docker-compose.yml
docker compose up -d
```

### Option 4: Find and use correct certificate resolver name

Common names: `acme`, `le`, `letsencrypt`, `cert-manager`

Check your Traefik config to see what it's actually called.

