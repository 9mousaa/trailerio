#!/bin/bash
# Fix WireGuard keys extraction using Python for reliability

set -e

cd /tmp

# Regenerate profile
echo "🔄 Regenerating WireGuard profile..."
wgcf generate --config /tmp/wgcf-account.toml --profile /tmp/wgcf-profile.conf

# Extract keys using Python (most reliable)
echo "📋 Extracting keys with Python..."
eval $(python3 << 'PYEOF'
import re
import base64
import sys

try:
    with open('/tmp/wgcf-profile.conf', 'r') as f:
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
        if len(decoded) == 32:  # WireGuard private key is 32 bytes
            print(f"export PRIVATE_KEY='{private_key}'")
        else:
            errors.append(f"PrivateKey wrong length: {len(decoded)} bytes (expected 32)")
    except Exception as e:
        errors.append(f"PrivateKey invalid base64: {e}")
else:
    errors.append("PrivateKey not found")

if public_match:
    public_key = public_match.group(1).strip()
    try:
        decoded = base64.b64decode(public_key, validate=True)
        if len(decoded) == 32:  # WireGuard public key is 32 bytes
            print(f"export PUBLIC_KEY='{public_key}'")
        else:
            errors.append(f"PublicKey wrong length: {len(decoded)} bytes (expected 32)")
    except Exception as e:
        errors.append(f"PublicKey invalid base64: {e}")
else:
    errors.append("PublicKey not found")

if preshared_match:
    preshared_key = preshared_match.group(1).strip()
    if preshared_key:
        try:
            decoded = base64.b64decode(preshared_key, validate=True)
            if len(decoded) == 32:  # Preshared key is 32 bytes
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
    echo "❌ Failed to extract keys"
    exit 1
fi

echo "✅ Keys extracted successfully"
echo "   Private: ${PRIVATE_KEY:0:20}... (${#PRIVATE_KEY} chars)"
echo "   Public: ${PUBLIC_KEY:0:20}... (${#PUBLIC_KEY} chars)"
echo "   Addresses: ${ADDRESSES}"
echo "   Endpoint: ${ENDPOINT}"

# Resolve endpoint to IPv4
ENDPOINT_HOST=$(echo "${ENDPOINT}" | cut -d':' -f1)
ENDPOINT_PORT=$(echo "${ENDPOINT}" | cut -d':' -f2)
ENDPOINT_IP=$(dig +short -4 "${ENDPOINT_HOST}" | head -1)

if [ -z "${ENDPOINT_IP}" ]; then
    echo "❌ Failed to resolve ${ENDPOINT_HOST} to IPv4"
    exit 1
fi

echo "   Endpoint IP: ${ENDPOINT_IP}:${ENDPOINT_PORT}"

# Update .env
cd /opt/trailerio
TMDB_KEY=$(grep "^TMDB_API_KEY=" .env 2>/dev/null | cut -d= -f2 || echo "")

# Backup
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)

# Verify addresses before writing
if [ -z "${ADDRESSES}" ] || [ "${ADDRESSES}" = "" ]; then
    echo "❌ ADDRESSES is empty, cannot proceed"
    exit 1
fi

# Check if addresses contain valid format
if ! echo "${ADDRESSES}" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+'; then
    echo "⚠️  Warning: ADDRESSES format might be invalid: ${ADDRESSES}"
    echo "   Expected format: IP/CIDR,IP/CIDR"
fi

# Write new .env (using printf to avoid shell expansion issues)
cat > .env <<ENVEOF
# TMDB API Key
TMDB_API_KEY=${TMDB_KEY:-bfe73358661a995b992ae9a812aa0d2f}

# Cloudflare Warp WireGuard Configuration (generated by fix-wireguard-keys.sh)
WIREGUARD_PRIVATE_KEY=${PRIVATE_KEY}
WIREGUARD_ADDRESSES=${ADDRESSES}
WIREGUARD_PUBLIC_KEY=${PUBLIC_KEY}
WIREGUARD_PRESHARED_KEY=${PRESHARED_KEY:-}
WIREGUARD_ENDPOINT_IP=${ENDPOINT_IP}
WIREGUARD_ENDPOINT_PORT=${ENDPOINT_PORT}

# Gluetun HTTP Proxy (for yt-dlp)
GLUETUN_HTTP_PROXY=http://gluetun:8000
ENVEOF

# Verify what was written
echo ""
echo "📋 Verifying .env file:"
echo "   WIREGUARD_ADDRESSES=$(grep '^WIREGUARD_ADDRESSES=' .env | cut -d= -f2-)"

echo ""
echo "✅ Updated .env with validated keys"
echo ""
echo "🔄 Restarting gluetun..."
docker compose up -d gluetun
sleep 5
echo ""
echo "📋 Gluetun logs:"
docker compose logs gluetun --tail=40 | grep -E "(INFO|ERROR|VPN|connection|UP|DOWN|Wireguard|successfully|established)" || \
docker compose logs gluetun --tail=30

