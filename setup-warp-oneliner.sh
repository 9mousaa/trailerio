#!/bin/bash
# One-liner Cloudflare Warp setup for TrailerIO
# Run this on your VPS: bash setup-warp-oneliner.sh /opt/trailerio

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
cd "$PROJECT_DIR" || exit 1

echo "Setting up Cloudflare Warp for TrailerIO..."

# Install wgcf if not exists
if ! command -v wgcf &> /dev/null; then
    echo "Installing wgcf..."
    ARCH=$(uname -m)
    [ "$ARCH" = "x86_64" ] && ARCH="amd64" || ARCH="arm64"
    wget -q "https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_2.2.21_linux_${ARCH}" -O /tmp/wgcf || \
    wget -q "https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_${ARCH}" -O /tmp/wgcf
    chmod +x /tmp/wgcf && sudo mv /tmp/wgcf /usr/local/bin/wgcf 2>/dev/null || mv /tmp/wgcf /usr/local/bin/wgcf
    echo "✓ wgcf installed"
fi

# Verify wgcf works
if ! wgcf --version &>/dev/null; then
    echo "✗ Error: wgcf is not working properly"
    exit 1
fi

# Register and generate
cd /tmp || exit 1

# Register if not already registered
if [ ! -f "wgcf-account.toml" ]; then
    echo "Registering with Cloudflare Warp..."
    wgcf register
    echo "✓ Registered"
else
    echo "✓ Already registered"
fi

# Generate profile
echo "Generating WireGuard profile..."
if [ ! -f "wgcf-profile.conf" ]; then
    wgcf generate
    echo "✓ Profile generated"
else
    echo "Regenerating profile..."
    wgcf generate
    echo "✓ Profile regenerated"
fi

# Verify profile exists
if [ ! -f "wgcf-profile.conf" ]; then
    echo "✗ Error: wgcf-profile.conf not found after generation"
    echo "Current directory: $(pwd)"
    echo "Files in /tmp:"
    ls -la /tmp/wgcf* 2>/dev/null || echo "No wgcf files found"
    exit 1
fi

# Extract keys
PRIVATE_KEY=$(grep "PrivateKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ADDRESS=$(grep "Address" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ' | head -n 1)
PUBLIC_KEY=$(grep "PublicKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT=$(grep "Endpoint" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT_IP=$(echo "$ENDPOINT" | cut -d ':' -f 1)
ENDPOINT_PORT=$(echo "$ENDPOINT" | cut -d ':' -f 2)
PRESHARED_KEY=$(grep "PresharedKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ' 2>/dev/null || echo "")

# Validate keys were extracted
if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$ENDPOINT_IP" ]; then
    echo "✗ Error: Failed to extract keys from wgcf-profile.conf"
    exit 1
fi

# Update .env
ENV_FILE="$PROJECT_DIR/.env"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d_%H%M%S)"
sed -i '/^WIREGUARD_/d' "$ENV_FILE" 2>/dev/null || sed -i.bak '/^WIREGUARD_/d' "$ENV_FILE"
sed -i '/^GLUETUN_HTTP_PROXY=/d' "$ENV_FILE" 2>/dev/null || sed -i.bak '/^GLUETUN_HTTP_PROXY=/d' "$ENV_FILE"
cat >> "$ENV_FILE" << EOF

# Cloudflare Warp Configuration
WIREGUARD_PRIVATE_KEY=$PRIVATE_KEY
WIREGUARD_ADDRESSES=$ADDRESS
WIREGUARD_PUBLIC_KEY=$PUBLIC_KEY
WIREGUARD_ENDPOINT_IP=$ENDPOINT_IP
WIREGUARD_ENDPOINT_PORT=$ENDPOINT_PORT
GLUETUN_HTTP_PROXY=http://gluetun:8000
EOF
[ -n "$PRESHARED_KEY" ] && echo "WIREGUARD_PRESHARED_KEY=$PRESHARED_KEY" >> "$ENV_FILE"

echo "✓ Cloudflare Warp configured! Restart services with: cd $PROJECT_DIR && docker compose up -d"

