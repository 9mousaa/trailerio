#!/bin/bash
# Bulletproof Cloudflare Warp setup for gluetun
# This script generates WireGuard keys and configures gluetun properly

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
ENV_FILE="${PROJECT_DIR}/.env"

echo "🔧 Setting up Cloudflare Warp for gluetun..."
echo "📁 Project directory: ${PROJECT_DIR}"

# Ensure we're in the right directory
cd "${PROJECT_DIR}"

# Check if wgcf is installed
if ! command -v wgcf &> /dev/null; then
    echo "📥 Installing wgcf..."
    WGCF_URL="https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64"
    curl -L -o /tmp/wgcf "${WGCF_URL}" || {
        echo "❌ Failed to download wgcf"
        exit 1
    }
    chmod +x /tmp/wgcf
    if [ -w /usr/local/bin ]; then
        mv /tmp/wgcf /usr/local/bin/wgcf
        WGCF_BIN="/usr/local/bin/wgcf"
    else
        WGCF_BIN="/tmp/wgcf"
    fi
else
    WGCF_BIN="wgcf"
fi

cd /tmp

# Register wgcf account (if not already registered)
ACCOUNT_FILE="/tmp/wgcf-account.toml"
if [ ! -f "${ACCOUNT_FILE}" ] || [ ! -s "${ACCOUNT_FILE}" ]; then
    echo "📝 Registering wgcf account..."
    ${WGCF_BIN} register --config "${ACCOUNT_FILE}" || {
        echo "❌ Failed to register wgcf account"
        exit 1
    }
    sleep 2
fi

# Generate WireGuard profile
echo "🔑 Generating WireGuard profile..."
PROFILE_FILE="/tmp/wgcf-profile.conf"
${WGCF_BIN} generate --config "${ACCOUNT_FILE}" --profile "${PROFILE_FILE}" || {
    echo "❌ Failed to generate WireGuard profile"
    exit 1
}

if [ ! -f "${PROFILE_FILE}" ] || [ ! -s "${PROFILE_FILE}" ]; then
    echo "❌ Profile file not found or empty"
    exit 1
fi

# Parse WireGuard config - extract keys carefully
echo "📋 Parsing WireGuard configuration..."

# Extract keys with proper handling of base64 padding
PRIVATE_KEY=$(grep "^PrivateKey" "${PROFILE_FILE}" | sed 's/PrivateKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')
PUBLIC_KEY=$(grep "^PublicKey" "${PROFILE_FILE}" | sed 's/PublicKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')
PRESHARED_KEY=$(grep "^PresharedKey" "${PROFILE_FILE}" | sed 's/PresharedKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]' || echo "")
ADDRESSES=$(grep "^Address" "${PROFILE_FILE}" | sed 's/Address[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' | head -1)
ENDPOINT=$(grep "^Endpoint" "${PROFILE_FILE}" | sed 's/Endpoint[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')

# Validate keys
if [ -z "${PRIVATE_KEY}" ] || [ -z "${PUBLIC_KEY}" ] || [ -z "${ADDRESSES}" ] || [ -z "${ENDPOINT}" ]; then
    echo "❌ Failed to extract required keys from profile"
    echo "   PrivateKey: ${PRIVATE_KEY:+SET}${PRIVATE_KEY:-MISSING}"
    echo "   PublicKey: ${PUBLIC_KEY:+SET}${PUBLIC_KEY:-MISSING}"
    echo "   Addresses: ${ADDRESSES:+SET}${ADDRESSES:-MISSING}"
    echo "   Endpoint: ${ENDPOINT:+SET}${ENDPOINT:-MISSING}"
    exit 1
fi

# Validate base64 encoding
if ! echo "${PUBLIC_KEY}" | base64 -d > /dev/null 2>&1; then
    echo "❌ PublicKey is not valid base64: ${PUBLIC_KEY}"
    exit 1
fi

if ! echo "${PRIVATE_KEY}" | base64 -d > /dev/null 2>&1; then
    echo "❌ PrivateKey is not valid base64: ${PRIVATE_KEY}"
    exit 1
fi

echo "✅ Keys extracted and validated"

# Resolve endpoint hostname to IP
ENDPOINT_HOST=$(echo "${ENDPOINT}" | cut -d':' -f1)
ENDPOINT_PORT=$(echo "${ENDPOINT}" | cut -d':' -f2)

echo "🔍 Resolving ${ENDPOINT_HOST} to IP address..."
ENDPOINT_IP=""

# Try multiple methods to resolve hostname
if command -v getent &> /dev/null; then
    ENDPOINT_IP=$(getent hosts "${ENDPOINT_HOST}" | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
fi

if [ -z "${ENDPOINT_IP}" ] && command -v dig &> /dev/null; then
    ENDPOINT_IP=$(dig +short -4 "${ENDPOINT_HOST}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
fi

if [ -z "${ENDPOINT_IP}" ] && command -v nslookup &> /dev/null; then
    ENDPOINT_IP=$(nslookup "${ENDPOINT_HOST}" 2>/dev/null | grep -A1 "Name:" | grep "Address" | awk '{print $2}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
fi

if [ -z "${ENDPOINT_IP}" ]; then
    echo "❌ Failed to resolve ${ENDPOINT_HOST} to IP address"
    echo "   Please manually set WIREGUARD_ENDPOINT_IP in .env"
    exit 1
fi

echo "   ✓ Resolved to: ${ENDPOINT_IP} (${ENDPOINT_HOST})"

# Backup existing .env
if [ -f "${ENV_FILE}" ]; then
    cp "${ENV_FILE}" "${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    echo "💾 Backed up existing .env file"
fi

# Read existing TMDB key
TMDB_KEY=$(grep "^TMDB_API_KEY=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || echo "")

# Write WireGuard keys to .env
echo "✍️  Writing WireGuard keys to .env..."

# Remove old WireGuard keys
if [ -f "${ENV_FILE}" ]; then
    grep -v "^WIREGUARD_" "${ENV_FILE}" > "${ENV_FILE}.tmp" 2>/dev/null || true
    mv "${ENV_FILE}.tmp" "${ENV_FILE}" 2>/dev/null || true
fi

# Create/update .env file
{
    if [ -n "${TMDB_KEY}" ]; then
        echo "TMDB_API_KEY=${TMDB_KEY}"
    fi
    echo ""
    echo "# Cloudflare Warp WireGuard Configuration (generated by setup-warp.sh)"
    echo "WIREGUARD_PRIVATE_KEY=${PRIVATE_KEY}"
    echo "WIREGUARD_ADDRESSES=${ADDRESSES}"
    echo "WIREGUARD_PUBLIC_KEY=${PUBLIC_KEY}"
    echo "WIREGUARD_PRESHARED_KEY=${PRESHARED_KEY}"
    echo "WIREGUARD_ENDPOINT_IP=${ENDPOINT_IP}"
    echo "WIREGUARD_ENDPOINT_PORT=${ENDPOINT_PORT}"
} > "${ENV_FILE}"

echo "✅ WireGuard keys written to ${ENV_FILE}"
echo ""
echo "📊 Configuration summary:"
echo "   Endpoint: ${ENDPOINT_IP}:${ENDPOINT_PORT}"
echo "   Addresses: ${ADDRESSES}"
echo ""

# Recreate gluetun container to pick up new keys
echo "🔄 Recreating gluetun container..."
cd "${PROJECT_DIR}"
docker compose stop gluetun 2>/dev/null || true
docker compose rm -f gluetun 2>/dev/null || true
docker compose up -d gluetun || {
    echo "⚠️  Failed to start gluetun (may need to restart manually)"
    exit 1
}

# Wait for gluetun to start
echo "⏳ Waiting for gluetun to initialize..."
sleep 10

# Check gluetun status
echo ""
echo "📋 Checking gluetun status..."
if docker compose ps gluetun | grep -q "Up"; then
    echo "✅ Gluetun container is running"
    echo ""
    echo "📜 Recent logs:"
    docker compose logs gluetun --tail 20
    
    # Check for errors
    if docker compose logs gluetun --tail 50 | grep -q "ERROR"; then
        echo ""
        echo "⚠️  Warnings/Errors detected in gluetun logs. Check above."
    else
        echo ""
        echo "✅ Gluetun appears to be running successfully!"
    fi
else
    echo "❌ Gluetun container is not running. Check logs:"
    docker compose logs gluetun --tail 50
    exit 1
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To check gluetun status:"
echo "   docker compose logs gluetun -f"
echo ""
echo "To restart all services:"
echo "   docker compose restart"
