# Quick Fix: Traefik SSL Certificate Resolver

## The Problem
Traefik logs show: `ERR Router uses a non-existent certificate resolver certificateResolver=letsencrypt`

This means Traefik doesn't have the `letsencrypt` certresolver configured.

## Quickest Fix (Choose One Method)

### Method 1: If Traefik is in Docker Compose (Easiest)

1. Find Traefik's docker-compose.yml file (usually in `/opt/traefik` or similar)
2. Edit the Traefik service and add these labels:

```yaml
services:
  traefik:
    # ... existing config ...
    labels:
      # Add these three lines:
      - "traefik.certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
      - "traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
```

3. Make sure `/letsencrypt` volume is mounted:
```yaml
    volumes:
      - ./letsencrypt:/letsencrypt  # Add this if not present
```

4. Restart:
```bash
cd /path/to/traefik
docker compose up -d traefik
```

### Method 2: If Traefik has a Config File

1. Find Traefik config (usually `/etc/traefik/traefik.yml` or mounted volume)
2. Add this section:

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

3. Restart Traefik:
```bash
docker restart traefik
```

### Method 3: Use the Helper Script

Run the automated script:
```bash
cd /opt/trailerio
git pull
bash fix-traefik-ssl-simple.sh your-email@example.com
```

## After Configuration

1. **Restart Traefik:**
   ```bash
   docker restart traefik
   ```

2. **Wait 2-3 minutes** for Let's Encrypt to issue the certificate

3. **Check logs:**
   ```bash
   docker logs traefik | grep -i acme
   ```
   Look for: "Certificate obtained" or "Certificate renewed"

4. **Test HTTPS:**
   ```bash
   curl -I https://trailerio.plaio.cc
   ```

5. **Verify in browser:**
   Visit `https://trailerio.plaio.cc` - should show secure lock icon

## Troubleshooting

### Still getting errors?
- Check Traefik logs: `docker logs traefik | tail -50`
- Verify DNS: `dig trailerio.plaio.cc` (should point to your server)
- Check ports: `netstat -tlnp | grep -E '80|443'`
- Verify `/letsencrypt` volume exists and is writable

### Certificate not issuing?
- Make sure port 80 is accessible (Let's Encrypt needs it for HTTP challenge)
- Check firewall allows ports 80 and 443
- Verify domain DNS is correct
- Check Traefik logs for ACME errors

### Need to change email?
Just update the email in the configuration and restart Traefik.

## What This Does

The certresolver tells Traefik to:
1. Use Let's Encrypt for free SSL certificates
2. Automatically obtain certificates for domains
3. Automatically renew certificates before expiry
4. Use HTTP challenge (requires port 80 to be accessible)

Once configured, Traefik will automatically get SSL certificates for `trailerio.plaio.cc` and the "Not Secure" warning will disappear!

