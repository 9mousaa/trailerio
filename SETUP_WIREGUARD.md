# Cloudflare Warp WireGuard Setup (REQUIRED)

Gluetun requires Cloudflare Warp WireGuard keys to function. Without these keys, gluetun will fail to start and the backend will not start (as it depends on gluetun being healthy).

## Quick Setup

Run the setup script on your server:

```bash
cd /opt/trailerio
bash setup-warp.sh
```

This script will:
1. Install `wgcf` (Cloudflare Warp client) if needed
2. Register with Cloudflare Warp
3. Generate WireGuard keys
4. Write the keys to your `.env` file
5. Restart the gluetun container

## Manual Setup (Alternative)

If the script doesn't work, you can manually generate keys:

1. **Install wgcf:**
   ```bash
   curl -L -o /tmp/wgcf https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64
   chmod +x /tmp/wgcf
   mv /tmp/wgcf /usr/local/bin/wgcf
   ```

2. **Register and generate profile:**
   ```bash
   cd /tmp
   wgcf register
   wgcf generate
   ```

3. **Extract keys from `wgcf-profile.conf`:**
   - `PrivateKey` → `WIREGUARD_PRIVATE_KEY`
   - `PublicKey` → `WIREGUARD_PUBLIC_KEY`
   - `PresharedKey` → `WIREGUARD_PRESHARED_KEY` (may be empty)
   - `Address` → `WIREGUARD_ADDRESSES` (IPv4 only, e.g., `172.16.0.2/32`)
   - `Endpoint` → Split into:
     - Hostname/IP → `WIREGUARD_ENDPOINT_IP` (must be IP, not hostname)
     - Port → `WIREGUARD_ENDPOINT_PORT`

4. **Add to `.env` file:**
   ```bash
   cat >> /opt/trailerio/.env << EOF
   WIREGUARD_PRIVATE_KEY=your_private_key_here
   WIREGUARD_ADDRESSES=172.16.0.2/32
   WIREGUARD_PUBLIC_KEY=your_public_key_here
   WIREGUARD_PRESHARED_KEY=your_preshared_key_here
   WIREGUARD_ENDPOINT_IP=162.159.192.1
   WIREGUARD_ENDPOINT_PORT=2408
   EOF
   ```

5. **Resolve endpoint hostname to IP:**
   ```bash
   # If endpoint is a hostname, resolve it to IP
   dig +short engage.cloudflareclient.com
   # Use the IPv4 address for WIREGUARD_ENDPOINT_IP
   ```

## Verify Setup

After setting up the keys:

1. **Check gluetun logs:**
   ```bash
   docker compose logs gluetun -f
   ```

2. **Verify gluetun is healthy:**
   ```bash
   docker compose ps gluetun
   # Should show "Up" and "healthy"
   ```

3. **Test the proxy:**
   ```bash
   docker exec trailerio-backend-1 curl -x http://gluetun:8888 http://httpbin.org/ip
   ```

## Troubleshooting

### Error: "endpoint IP is not set"
- Make sure `WIREGUARD_ENDPOINT_IP` is set in `.env`
- The endpoint must be an IP address, not a hostname
- Resolve the hostname: `dig +short engage.cloudflareclient.com`

### Error: "Wireguard server selection settings: endpoint IP is not set"
- Check that all WireGuard keys are set in `.env`
- Restart gluetun: `docker compose restart gluetun`

### Gluetun keeps restarting
- Check logs: `docker compose logs gluetun --tail 100`
- Verify all keys are correct
- Ensure the endpoint IP is reachable

### Backend won't start
- Backend depends on gluetun being healthy
- Fix gluetun first, then backend will start automatically

## Important Notes

- **yt-dlp will NEVER run without the proxy** - if gluetun is not available, yt-dlp extraction will be aborted
- **Backend requires gluetun** - the backend service will not start until gluetun is healthy
- **Keys are required** - gluetun cannot function without valid WireGuard keys

