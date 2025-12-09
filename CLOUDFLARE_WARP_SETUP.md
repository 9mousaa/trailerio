# Cloudflare Warp Setup Guide

This guide explains how to set up Cloudflare Warp with gluetun for yt-dlp extraction.

## Quick Setup (Automated) - RECOMMENDED

**Option 1: One-liner (easiest)**

Run this single command on your VPS:

```bash
cd /opt/trailerio && bash <(curl -fsSL https://raw.githubusercontent.com/9mousaa/trailerio/main/setup-warp-oneliner.sh) /opt/trailerio
```

**Option 2: Using setup script**

If you have the repo cloned:

```bash
cd /opt/trailerio && bash setup-cloudflare-warp.sh /opt/trailerio
```

**What it does automatically:**
1. ✅ Installs wgcf
2. ✅ Registers with Cloudflare Warp (one-time)
3. ✅ Generates WireGuard configuration
4. ✅ Extracts all keys
5. ✅ Updates your .env file
6. ✅ Backs up existing .env

**Then restart services:**

```bash
cd /opt/trailerio && docker compose up -d
```

---

## Manual Setup (Alternative)

If you prefer to set it up manually:

```bash
# Download wgcf (replace with latest version)
wget https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64 -O wgcf
chmod +x wgcf
sudo mv wgcf /usr/local/bin/
```

## Step 2: Generate WireGuard Configuration

```bash
# Register with Cloudflare (one-time)
wgcf register

# Generate profile
wgcf generate
```

This creates two files:
- `wgcf-account.toml` - Your account info (keep private)
- `wgcf-profile.conf` - WireGuard configuration

## Step 3: Extract Keys from wgcf-profile.conf

Open `wgcf-profile.conf` and extract these values:

```ini
[Interface]
PrivateKey = <WIREGUARD_PRIVATE_KEY>
Address = <WIREGUARD_ADDRESSES>  # e.g., 172.16.0.2/32

[Peer]
PublicKey = <WIREGUARD_PUBLIC_KEY>
Endpoint = <WIREGUARD_ENDPOINT_IP>:<WIREGUARD_ENDPOINT_PORT>  # e.g., 162.159.192.1:2408
PresharedKey = <WIREGUARD_PRESHARED_KEY>  # Optional, may not exist
```

## Step 4: Add to .env file

Add these variables to your `.env` file:

```bash
WIREGUARD_PRIVATE_KEY=your_private_key_here
WIREGUARD_ADDRESSES=172.16.0.2/32
WIREGUARD_PUBLIC_KEY=your_public_key_here
WIREGUARD_ENDPOINT_IP=162.159.192.1
WIREGUARD_ENDPOINT_PORT=2408
WIREGUARD_PRESHARED_KEY=your_preshared_key_here  # Optional
```

## Step 5: Restart Services

```bash
docker compose down
docker compose up -d
```

## Optional: Test gluetun

Check if gluetun is working:

```bash
docker compose exec gluetun wget -qO- https://ipinfo.io
```

You should see a Cloudflare IP address.

## Troubleshooting

- **gluetun won't start**: Check that all WireGuard keys are set in `.env`
- **yt-dlp not using proxy**: Check `GLUETUN_HTTP_PROXY` environment variable
- **Connection issues**: Verify gluetun health: `docker compose ps gluetun`

## Notes

- gluetun is optional - if WireGuard keys aren't set, the backend will still work with other sources
- yt-dlp will work without gluetun, but may be more prone to blocking
- Cloudflare Warp provides better IP reputation and reduces blocking risk

