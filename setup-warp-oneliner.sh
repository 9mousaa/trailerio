#!/bin/bash
# One-liner Cloudflare Warp setup for TrailerIO
# Run this on your VPS: bash <(curl -fsSL https://raw.githubusercontent.com/9mousaa/trailerio/main/setup-cloudflare-warp.sh) /opt/trailerio

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
fi

# Register and generate
cd /tmp
[ ! -f "wgcf-account.toml" ] && wgcf register
wgcf generate

# Extract keys
PRIVATE_KEY=$(grep "PrivateKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ADDRESS=$(grep "Address" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ' | head -n 1)
PUBLIC_KEY=$(grep "PublicKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT=$(grep "Endpoint" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT_IP=$(echo "$ENDPOINT" | cut -d ':' -f 1)
ENDPOINT_PORT=$(echo "$ENDPOINT" | cut -d ':' -f 2)
PRESHARED_KEY=$(grep "PresharedKey" wgcf-profile.conf | cut -d '=' -f 2 | tr -d ' ' 2>/dev/null || echo "")

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

