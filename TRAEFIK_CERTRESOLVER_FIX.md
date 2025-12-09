# Fix: Traefik Certificate Resolver Not Configured

## Problem
Traefik logs show:
```
ERR Router uses a non-existent certificate resolver certificateResolver=letsencrypt routerName=trailerio@docker
```

This means the `letsencrypt` certresolver is not configured in Traefik's static configuration.

## Solution Options

### Option 1: Configure Certresolver in Traefik (Recommended)

You need to add the `letsencrypt` certresolver to Traefik's static configuration.

**If Traefik is running in Docker:**

1. Find Traefik's configuration file or Docker labels
2. Add the certresolver configuration:

**For YAML config (`/etc/traefik/traefik.yml` or similar):**
```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com  # Required - replace with your email
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

**For Docker labels (on Traefik container):**
```yaml
labels:
  - "traefik.certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
  - "traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
  - "traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
```

3. Ensure the `/letsencrypt` volume is mounted and writable
4. Restart Traefik: `docker restart traefik`

### Option 2: Use Different Certresolver Name

If Traefik already has a certresolver configured with a different name (e.g., `le`, `acme`, `cert-manager`), update `docker-compose.yml`:

```yaml
- "traefik.http.routers.trailerio.tls.certresolver=le"  # or whatever name is configured
```

### Option 3: Remove Automatic SSL (Temporary)

If you can't configure the certresolver right now, you can remove the TLS requirement temporarily:

1. Comment out or remove these lines in `docker-compose.yml`:
   - `traefik.http.routers.trailerio.tls.certresolver=letsencrypt`
   - `traefik.http.routers.trailerio.tls=true`

2. The site will work over HTTP (not secure), but functional

3. You can manually configure SSL certificates later

### Option 4: Use Manual Certificates

If you have SSL certificates, you can configure them manually in Traefik without using a certresolver.

## Quick Check: What Certresolvers Are Available?

Check Traefik logs or configuration to see what certresolvers are configured:
```bash
docker logs traefik 2>&1 | grep -i "certresolver\|acme" | head -20
```

Or check Traefik's API (if enabled):
```bash
curl http://localhost:8080/api/http/certresolvers 2>/dev/null | jq .
```

## After Fixing

1. Restart Traefik: `docker restart traefik`
2. Wait 2-3 minutes for certificate issuance
3. Check logs: `docker logs traefik | grep -i "certificate\|acme"`
4. Test: `curl -I https://trailerio.plaio.cc`

## Current Status

- DNS is correctly pointing to: `143.110.166.25` ✓
- Traefik is running ✓
- Certresolver needs to be configured ✗

