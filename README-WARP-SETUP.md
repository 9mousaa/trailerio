# Cloudflare Warp Multi-Instance Setup

This guide explains how to set up multiple Cloudflare Warp instances for IP rotation to avoid bot detection.

## Quick Start

```bash
# Run the automated setup script (creates 3 instances by default)
./setup-multiple-warp.sh

# Or specify number of instances
./setup-multiple-warp.sh 5
```

## What It Does

1. **Installs wgcf** (if not already installed) - tool to generate Cloudflare Warp WireGuard configs
2. **Registers multiple Warp accounts** - each instance gets its own account/IP
3. **Generates WireGuard keys** - extracts all required keys from Warp configs
4. **Updates .env file** - automatically adds all keys to your .env file
5. **Backs up existing .env** - creates backup before making changes

## Manual Setup (Alternative)

If the automated script doesn't work, you can set up manually:

### 1. Install wgcf

```bash
# Option 1: Using Go
go install github.com/ViRb3/wgcf@latest

# Option 2: Download binary
# Visit: https://github.com/ViRb3/wgcf/releases
# Download for your architecture (amd64 or arm64)
```

### 2. Generate Configs for Each Instance

For each instance (1, 2, 3, etc.):

```bash
# Create temp directory
mkdir -p /tmp/wgcf-instance-1
cd /tmp/wgcf-instance-1

# Register new Warp account
wgcf register --accept-tos -n "trailerio-instance-1"

# Generate WireGuard profile
wgcf generate

# Extract values from wgcf-profile.conf
cat wgcf-profile.conf
```

### 3. Extract Values

From `wgcf-profile.conf`, extract:
- `PrivateKey` → `WIREGUARD_PRIVATE_KEY_1`
- `Address` → `WIREGUARD_ADDRESSES_1`
- `PublicKey` → `WIREGUARD_PUBLIC_KEY_1`
- `PresharedKey` → `WIREGUARD_PRESHARED_KEY_1`
- `Endpoint` → Split into `WIREGUARD_ENDPOINT_IP_1` and `WIREGUARD_ENDPOINT_PORT_1`

### 4. Add to .env

Add to your `.env` file:

```bash
# Instance 1
WIREGUARD_PRIVATE_KEY_1=your_private_key_here
WIREGUARD_ADDRESSES_1=172.16.0.2/32
WIREGUARD_PUBLIC_KEY_1=your_public_key_here
WIREGUARD_PRESHARED_KEY_1=your_preshared_key_here
WIREGUARD_ENDPOINT_IP_1=engage.cloudflareclient.com
WIREGUARD_ENDPOINT_PORT_1=2408

# Instance 2 (repeat for each instance)
WIREGUARD_PRIVATE_KEY_2=...
WIREGUARD_ADDRESSES_2=...
# etc.
```

## Verification

After setup, verify the configuration:

```bash
# Check .env file has all keys
grep WIREGUARD .env

# Start services
docker compose up -d

# Check proxy health
docker compose ps

# Check logs
docker compose logs gluetun-1
docker compose logs gluetun-2
docker compose logs gluetun-3
```

## Troubleshooting

### Script fails to install wgcf
- Install manually: `go install github.com/ViRb3/wgcf@latest`
- Or download from: https://github.com/ViRb3/wgcf/releases

### Registration fails
- Cloudflare may rate limit registrations
- Wait a few minutes between attempts
- Try running script with fewer instances at a time

### Proxy not working
- Check gluetun logs: `docker compose logs gluetun-1`
- Verify keys in .env are correct
- Ensure gluetun container is running: `docker compose ps`

### Only one instance works
- Each instance needs separate Warp account
- Make sure you're using different keys for each instance
- Check that all instances are in .env with correct suffixes (_1, _2, _3)

## How It Works

1. **Multiple gluetun containers** - Each runs with different WireGuard keys
2. **Different IP addresses** - Each Warp account gets different IP
3. **Smart rotation** - Backend automatically rotates through available proxies
4. **Success tracking** - System learns which proxies work best and prioritizes them
5. **Automatic failover** - If one proxy is blocked, automatically tries next

## Benefits

- ✅ Different IP per request reduces bot detection
- ✅ Automatic rotation through available proxies  
- ✅ Resilient: if one proxy is blocked, others continue working
- ✅ Smart selection: prioritizes working proxies based on success rate

