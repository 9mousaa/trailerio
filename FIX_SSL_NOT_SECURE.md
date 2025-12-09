# Fix "Not Secure" SSL/TLS Issue

## Common Causes

1. **Traefik certresolver not configured** - The `letsencrypt` certresolver must be configured in Traefik's static configuration
2. **Certificate not issued yet** - Let's Encrypt needs time to issue the certificate (can take a few minutes)
3. **Mixed content** - HTTP resources loaded on HTTPS page
4. **Missing security headers** - Browsers may show warnings without proper headers
5. **Domain DNS not pointing correctly** - Let's Encrypt needs to verify domain ownership

## Step-by-Step Fix

### 1. Check Traefik Configuration

Traefik needs to have the `letsencrypt` certresolver configured. Check your Traefik static configuration (usually in `/etc/traefik/traefik.yml` or Docker labels):

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com  # Required for Let's Encrypt
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

Or if using Docker labels on Traefik container:
```yaml
labels:
  - "traefik.certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
  - "traefik.certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
  - "traefik.certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
```

### 2. Verify Domain DNS

Ensure `trailerio.plaio.cc` points to your server's IP:
```bash
dig trailerio.plaio.cc
# or
nslookup trailerio.plaio.cc
```

### 3. Check Traefik Logs

```bash
docker logs traefik | grep -i "certificate\|acme\|letsencrypt\|error"
```

Look for:
- Certificate issuance success/failure
- ACME challenge errors
- Domain validation errors

### 4. Force Certificate Renewal

If certificate exists but isn't working:
```bash
# Restart Traefik to trigger certificate check
docker restart traefik

# Or delete the certificate to force re-issue (in Traefik's acme.json)
# This will automatically re-issue on next request
```

### 5. Check Certificate Status

Visit: `https://www.ssllabs.com/ssltest/analyze.html?d=trailerio.plaio.cc`

Or use command line:
```bash
openssl s_client -connect trailerio.plaio.cc:443 -servername trailerio.plaio.cc
```

### 6. Verify Browser Console

Open browser DevTools (F12) → Console tab, look for:
- Mixed content warnings (HTTP resources on HTTPS page)
- Certificate errors
- CORS errors

## Quick Diagnostic Commands

```bash
# Check if Traefik is running
docker ps | grep traefik

# Check Traefik logs for SSL errors
docker logs traefik 2>&1 | grep -i "ssl\|tls\|certificate\|acme" | tail -20

# Test HTTPS connection
curl -I https://trailerio.plaio.cc

# Check certificate details
echo | openssl s_client -connect trailerio.plaio.cc:443 -servername trailerio.plaio.cc 2>/dev/null | openssl x509 -noout -dates -subject
```

## What We Fixed in Code

1. **Added security headers** - HSTS, CSP, and other security headers
2. **Respect X-Forwarded-Proto** - Nginx now properly handles HTTPS from Traefik
3. **Added Strict-Transport-Security** - Forces browsers to use HTTPS

## If Still Not Working

1. **Wait 5-10 minutes** - Let's Encrypt certificates can take time to issue
2. **Check Traefik dashboard** - Visit `http://your-traefik-ip:8080` (if enabled) to see certificate status
3. **Verify entrypoints** - Ensure `web` (HTTP) and `websecure` (HTTPS) entrypoints are configured in Traefik
4. **Check firewall** - Ensure ports 80 and 443 are open

