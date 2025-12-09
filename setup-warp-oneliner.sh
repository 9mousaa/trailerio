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
ACCOUNT_FILE="wgcf-account.toml"
if [ ! -f "$ACCOUNT_FILE" ]; then
    echo "Registering with Cloudflare Warp..."
    wgcf register || {
        echo "✗ Error: Failed to register with Cloudflare Warp"
        exit 1
    }
    echo "✓ Registration command completed"
    
    # Wait a moment and check if file was created
    sleep 1
    
    # Check current directory first
    if [ -f "$ACCOUNT_FILE" ]; then
        echo "✓ Account file found in current directory"
    else
        # Search for the file
        FOUND_ACCOUNT=$(find /tmp -name "wgcf-account.toml" 2>/dev/null | head -n 1)
        if [ -n "$FOUND_ACCOUNT" ] && [ -f "$FOUND_ACCOUNT" ]; then
            echo "✓ Account file found at: $FOUND_ACCOUNT"
            cp "$FOUND_ACCOUNT" "$ACCOUNT_FILE"
        else
            # Check home directory
            if [ -f "$HOME/wgcf-account.toml" ]; then
                echo "✓ Account file found in home directory, copying to /tmp"
                cp "$HOME/wgcf-account.toml" "$ACCOUNT_FILE"
            else
                echo "✗ Error: wgcf-account.toml not found after registration"
                echo "Current directory: $(pwd)"
                echo "Files in /tmp:"
                ls -la /tmp/wgcf* 2>/dev/null || echo "No wgcf files found"
                echo "Files in home:"
                ls -la "$HOME"/wgcf* 2>/dev/null || echo "No wgcf files in home"
                exit 1
            fi
        fi
    fi
else
    echo "✓ Already registered (wgcf-account.toml exists)"
    # Verify account file is valid
    if [ ! -s "$ACCOUNT_FILE" ]; then
        echo "⚠ Warning: wgcf-account.toml exists but is empty, re-registering..."
        rm -f "$ACCOUNT_FILE"
        wgcf register || {
            echo "✗ Error: Failed to re-register"
            exit 1
        }
        sleep 1
    fi
fi

# Verify account file exists and has content
if [ ! -f "$ACCOUNT_FILE" ] || [ ! -s "$ACCOUNT_FILE" ]; then
    echo "✗ Error: wgcf-account.toml is missing or empty"
    echo "Current directory: $(pwd)"
    ls -la "$ACCOUNT_FILE" 2>/dev/null || echo "File does not exist"
    exit 1
fi
echo "✓ Account file verified ($(wc -l < "$ACCOUNT_FILE") lines, $(wc -c < "$ACCOUNT_FILE") bytes)"

# Generate profile
echo "Generating WireGuard profile..."
PROFILE_FILE="wgcf-profile.conf"

# Check wgcf help to see available options
echo "Checking wgcf version and options..."
wgcf --version || true
echo ""

# Run wgcf generate - it should create wgcf-profile.conf in current directory
echo "Running: wgcf generate"
wgcf generate 2>&1 | tee /tmp/wgcf-output.log || {
    EXIT_CODE=$?
    echo "✗ wgcf generate failed with exit code: $EXIT_CODE"
    echo "Output:"
    cat /tmp/wgcf-output.log 2>/dev/null || echo "No output captured"
    # Try capturing stdout as file content (some versions output to stdout)
    echo "Attempting to capture as stdout..."
    wgcf generate > "$PROFILE_FILE" 2>/tmp/wgcf-stderr.log || true
    if [ -f "$PROFILE_FILE" ] && [ -s "$PROFILE_FILE" ]; then
        echo "✓ Captured profile from stdout"
    else
        echo "✗ Failed to generate profile"
        cat /tmp/wgcf-stderr.log 2>/dev/null || true
        exit 1
    fi
}

# Check for profile file in current directory first
if [ -f "$PROFILE_FILE" ]; then
    echo "✓ Profile found: $PROFILE_FILE ($(wc -l < "$PROFILE_FILE") lines)"
elif [ -f "/tmp/$PROFILE_FILE" ]; then
    echo "✓ Profile found in /tmp, copying to current directory"
    cp "/tmp/$PROFILE_FILE" "$PROFILE_FILE"
else
    # Try to find the file anywhere
    echo "Searching for profile file..."
    FOUND_FILE=$(find /tmp -name "wgcf-profile.conf" -o -name "*.conf" 2>/dev/null | head -n 1)
    if [ -n "$FOUND_FILE" ] && [ -f "$FOUND_FILE" ]; then
        echo "✓ Profile found at: $FOUND_FILE"
        cp "$FOUND_FILE" "$PROFILE_FILE"
    else
        echo "✗ Error: wgcf-profile.conf not found after generation"
        echo "Current directory: $(pwd)"
        echo "wgcf generate output:"
        cat /tmp/wgcf-output.log 2>/dev/null || echo "No output log found"
        echo ""
        echo "All files in /tmp:"
        ls -la /tmp/ | head -20
        echo ""
        echo "Files matching 'wgcf' or 'profile':"
        ls -la /tmp/ | grep -E "(wgcf|profile)" || echo "No matching files"
        echo ""
        echo "Checking if wgcf-account.toml exists:"
        [ -f "wgcf-account.toml" ] && echo "✓ wgcf-account.toml exists" || echo "✗ wgcf-account.toml not found"
        exit 1
    fi
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

