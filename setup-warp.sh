#!/bin/bash
# Setup Cloudflare Warp for gluetun
# This script generates WireGuard keys using wgcf and adds them to .env

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
ENV_FILE="${PROJECT_DIR}/.env"

echo "🔧 Setting up Cloudflare Warp for gluetun..."
echo "📁 Project directory: ${PROJECT_DIR}"

# Check if wgcf is installed
if ! command -v wgcf &> /dev/null; then
    echo "📥 Installing wgcf..."
    # Download wgcf for Linux
    WGCF_URL="https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64"
    curl -L -o /tmp/wgcf "${WGCF_URL}" || {
        echo "❌ Failed to download wgcf"
        exit 1
    }
    chmod +x /tmp/wgcf
    mv /tmp/wgcf /usr/local/bin/wgcf 2>/dev/null || {
        # If /usr/local/bin is not writable, use /tmp
        echo "⚠️  Cannot install to /usr/local/bin, using /tmp/wgcf"
        WGCF_BIN="/tmp/wgcf"
    }
    WGCF_BIN="${WGCF_BIN:-/usr/local/bin/wgcf}"
else
    WGCF_BIN="wgcf"
fi

# Verify wgcf works
if ! ${WGCF_BIN} --version &>/dev/null; then
    echo "⚠️  wgcf --version failed, but continuing..."
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

# Parse WireGuard config using Python for reliability
echo "📋 Parsing WireGuard configuration..."

# Extract keys using Python (most reliable method)
eval $(python3 << 'PYEOF'
import re
import base64
import sys

try:
    with open('${PROFILE_FILE}', 'r') as f:
        content = f.read()
except Exception as e:
    print(f"Error reading profile: {e}", file=sys.stderr)
    sys.exit(1)

# Extract keys using regex (strict base64 pattern)
private_match = re.search(r'^PrivateKey\s*=\s*([A-Za-z0-9+/=]{43,44})', content, re.MULTILINE)
public_match = re.search(r'^PublicKey\s*=\s*([A-Za-z0-9+/=]{43,44})', content, re.MULTILINE)
preshared_match = re.search(r'^PresharedKey\s*=\s*([A-Za-z0-9+/=]*)', content, re.MULTILINE)
address_match = re.search(r'^Address\s*=\s*([^\s]+)', content, re.MULTILINE)
endpoint_match = re.search(r'^Endpoint\s*=\s*([^\s]+)', content, re.MULTILINE)

errors = []

if private_match:
    private_key = private_match.group(1).strip()
    try:
        decoded = base64.b64decode(private_key, validate=True)
        if len(decoded) == 32:
            print(f"export PRIVATE_KEY='{private_key}'")
        else:
            errors.append(f"PrivateKey wrong length")
    except Exception as e:
        errors.append(f"PrivateKey invalid")
else:
    errors.append("PrivateKey not found")

if public_match:
    public_key = public_match.group(1).strip()
    try:
        decoded = base64.b64decode(public_key, validate=True)
        if len(decoded) == 32:
            print(f"export PUBLIC_KEY='{public_key}'")
        else:
            errors.append(f"PublicKey wrong length")
    except Exception as e:
        errors.append(f"PublicKey invalid")
else:
    errors.append("PublicKey not found")

if preshared_match:
    preshared_key = preshared_match.group(1).strip()
    if preshared_key:
        try:
            decoded = base64.b64decode(preshared_key, validate=True)
            if len(decoded) == 32:
                print(f"export PRESHARED_KEY='{preshared_key}'")
            else:
                print("export PRESHARED_KEY=''")
        except:
            print("export PRESHARED_KEY=''")
    else:
        print("export PRESHARED_KEY=''")
else:
    print("export PRESHARED_KEY=''")

# Address can appear on a single line with multiple addresses separated by commas
# Format: Address = 172.16.0.2/32, 2606:4700:.../128
address_lines = []
for line in content.split('\n'):
    line_stripped = line.strip()
    # Only match lines that start with "Address" (case insensitive)
    if line_stripped.lower().startswith('address'):
        # Extract everything after = and before any comment
        if '=' in line_stripped:
            parts = line_stripped.split('=', 1)
            if len(parts) == 2:
                addr_part = parts[1].split('#')[0].strip()
                # Split by comma to get individual addresses
                # Each address might have spaces around it
                individual_addresses = [a.strip() for a in addr_part.split(',')]
                # Add all addresses that contain a /
                for addr in individual_addresses:
                    if addr and '/' in addr:
                        address_lines.append(addr)

# Validate each address - must be a real IP address with CIDR
# Gluetun doesn't support IPv6, so only include IPv4 addresses
valid_addresses = []
for addr in address_lines:
    addr = addr.strip()
    if '/' in addr:
        parts = addr.split('/')
        if len(parts) == 2:
            ip_part, cidr_part = parts[0].strip(), parts[1].strip()
            # Both parts must be non-empty
            if ip_part and cidr_part:
                # CIDR must be a valid number (1-32 for IPv4, gluetun doesn't support IPv6)
                try:
                    cidr_num = int(cidr_part)
                    # Only accept IPv4 addresses (gluetun limitation)
                    if '.' in ip_part and ':' not in ip_part:
                        # IPv4: must be 4 octets, each 0-255
                        octets = ip_part.split('.')
                        if len(octets) == 4:
                            try:
                                if all(0 <= int(o) <= 255 for o in octets):
                                    # Reject 0.0.0.0/0 (not a valid WireGuard address)
                                    if ip_part != '0.0.0.0' and 1 <= cidr_num <= 32:
                                        valid_addresses.append(addr)
                            except ValueError:
                                pass
                except ValueError:
                    pass

if valid_addresses:
    # Join with comma, no trailing comma
    addresses = ','.join(valid_addresses)
    print(f"export ADDRESSES='{addresses}'")
else:
    errors.append("No valid addresses found in WireGuard profile")

if endpoint_match:
    endpoint = endpoint_match.group(1).strip()
    print(f"export ENDPOINT='{endpoint}'")
else:
    errors.append("Endpoint not found")

if errors:
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)
PYEOF
)

if [ $? -ne 0 ]; then
    echo "❌ Failed to extract keys from WireGuard profile"
    exit 1
fi

if [ -z "${ENDPOINT}" ]; then
    echo "❌ Failed to parse endpoint from profile"
    exit 1
fi

ENDPOINT_HOST=$(echo "${ENDPOINT}" | cut -d':' -f1)
ENDPOINT_PORT=$(echo "${ENDPOINT}" | cut -d':' -f2)

# Resolve hostname to IP address (gluetun requires IP, not hostname)
# Prefer IPv4 addresses as gluetun works better with them
echo "🔍 Resolving ${ENDPOINT_HOST} to IP address (preferring IPv4)..."
ENDPOINT_IP=""

# Try getent first (prefers IPv4)
if command -v getent &> /dev/null; then
    # Get IPv4 addresses first
    ENDPOINT_IP=$(getent hosts "${ENDPOINT_HOST}" | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    # If no IPv4, try IPv6
    if [ -z "${ENDPOINT_IP}" ]; then
        ENDPOINT_IP=$(getent hosts "${ENDPOINT_HOST}" | awk '{print $1}' | head -1)
    fi
fi

# Fallback: try using dig (prefer IPv4)
if [ -z "${ENDPOINT_IP}" ] && command -v dig &> /dev/null; then
    # Try IPv4 first
    ENDPOINT_IP=$(dig +short -4 "${ENDPOINT_HOST}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    # If no IPv4, try any
    if [ -z "${ENDPOINT_IP}" ]; then
        ENDPOINT_IP=$(dig +short "${ENDPOINT_HOST}" 2>/dev/null | head -1)
    fi
fi

# Last resort: nslookup
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
TMDB_KEY=$(grep "^TMDB_API_KEY=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2 || echo "")

# Write WireGuard keys to .env
echo "✍️  Writing WireGuard keys to .env..."

cat > "${ENV_FILE}" <<EOF
# TMDB API Key
TMDB_API_KEY=${TMDB_KEY:-bfe73358661a995b992ae9a812aa0d2f}

# Cloudflare Warp WireGuard Configuration (generated by setup-warp.sh)
WIREGUARD_PRIVATE_KEY=${PRIVATE_KEY}
WIREGUARD_ADDRESSES=${ADDRESSES}
WIREGUARD_PUBLIC_KEY=${PUBLIC_KEY}
WIREGUARD_PRESHARED_KEY=${PRESHARED_KEY}
WIREGUARD_ENDPOINT_IP=${ENDPOINT_IP}
WIREGUARD_ENDPOINT_PORT=${ENDPOINT_PORT}

# Gluetun HTTP Proxy (for yt-dlp)
GLUETUN_HTTP_PROXY=http://gluetun:8000
EOF

echo "✅ WireGuard keys written to ${ENV_FILE}"
echo ""
echo "📊 Configuration summary:"
echo "   Endpoint: ${ENDPOINT_IP}:${ENDPOINT_PORT}"
echo "   Addresses: ${ADDRESSES}"
echo ""
echo "🔄 Restarting gluetun container..."
cd "${PROJECT_DIR}"
docker compose up -d gluetun || echo "⚠️  Failed to start gluetun (may need to restart manually)"

echo ""
echo "✅ Setup complete! Check gluetun logs with:"
echo "   docker compose logs gluetun -f"

