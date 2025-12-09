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
ACCOUNT_FILE_PATH="/tmp/$ACCOUNT_FILE"

if [ ! -f "$ACCOUNT_FILE_PATH" ]; then
    echo "Registering with Cloudflare Warp..."
    echo "Running: wgcf register --config $ACCOUNT_FILE_PATH"
    
    # Try with explicit config path first
    if wgcf register --config "$ACCOUNT_FILE_PATH" 2>&1 | tee /tmp/wgcf-register.log; then
        REGISTER_EXIT=$?
        echo "✓ Registration command completed (exit code: $REGISTER_EXIT)"
    else
        # Try without --config flag (some versions don't support it)
        echo "Trying without --config flag..."
        if wgcf register 2>&1 | tee /tmp/wgcf-register.log; then
            REGISTER_EXIT=$?
            echo "✓ Registration command completed (exit code: $REGISTER_EXIT)"
        else
            REGISTER_EXIT=$?
            echo "✗ Registration command failed (exit code: $REGISTER_EXIT)"
            echo "Output:"
            cat /tmp/wgcf-register.log 2>/dev/null || echo "No output captured"
        fi
    fi
    
    # Wait a moment for file to be written
    sleep 2
    
    # Check if file was created at the specified path
    if [ -f "$ACCOUNT_FILE_PATH" ] && [ -s "$ACCOUNT_FILE_PATH" ]; then
        echo "✓ Account file found at specified path: $ACCOUNT_FILE_PATH"
    else
        # Check current directory
        if [ -f "$ACCOUNT_FILE" ] && [ -s "$ACCOUNT_FILE" ]; then
            echo "✓ Account file found in current directory"
            cp "$ACCOUNT_FILE" "$ACCOUNT_FILE_PATH"
        else
            # Search for the file in common locations
            FOUND_ACCOUNT=$(find /tmp /root /home -name "wgcf-account.toml" 2>/dev/null | head -n 1)
            if [ -n "$FOUND_ACCOUNT" ] && [ -f "$FOUND_ACCOUNT" ]; then
                echo "✓ Account file found at: $FOUND_ACCOUNT"
                cp "$FOUND_ACCOUNT" "$ACCOUNT_FILE_PATH"
            else
                # Check if wgcf outputs to a specific location
                if [ -f "$HOME/.wgcf/wgcf-account.toml" ]; then
                    echo "✓ Account file found in ~/.wgcf, copying to /tmp"
                    cp "$HOME/.wgcf/wgcf-account.toml" "$ACCOUNT_FILE_PATH"
                elif [ -f "/root/.wgcf/wgcf-account.toml" ]; then
                    echo "✓ Account file found in /root/.wgcf, copying to /tmp"
                    cp "/root/.wgcf/wgcf-account.toml" "$ACCOUNT_FILE_PATH"
                else
                    echo "✗ Error: wgcf-account.toml not found after registration"
                    echo "Current directory: $(pwd)"
                    echo "wgcf register output:"
                    cat /tmp/wgcf-register.log 2>/dev/null || echo "No output captured"
                    echo ""
                    echo "Searching for wgcf files:"
                    find /tmp /root /home -name "*wgcf*" -o -name "*account*" 2>/dev/null | head -10 || echo "No wgcf files found"
                    echo ""
                    echo "Trying to manually check wgcf behavior..."
                    wgcf status 2>&1 || true
                    exit 1
                fi
            fi
        fi
    fi
else
    echo "✓ Already registered (wgcf-account.toml exists)"
    # Verify account file is valid
    if [ ! -s "$ACCOUNT_FILE_PATH" ]; then
        echo "⚠ Warning: wgcf-account.toml exists but is empty, re-registering..."
        rm -f "$ACCOUNT_FILE_PATH"
        wgcf register --config "$ACCOUNT_FILE_PATH" 2>&1 || wgcf register 2>&1
        sleep 2
    fi
fi

# Verify account file exists and has content
if [ ! -f "$ACCOUNT_FILE_PATH" ] || [ ! -s "$ACCOUNT_FILE_PATH" ]; then
    echo "✗ Error: wgcf-account.toml is missing or empty"
    echo "Expected path: $ACCOUNT_FILE_PATH"
    echo "Current directory: $(pwd)"
    ls -la "$ACCOUNT_FILE_PATH" 2>/dev/null || echo "File does not exist at expected path"
    exit 1
fi
echo "✓ Account file verified at $ACCOUNT_FILE_PATH ($(wc -l < "$ACCOUNT_FILE_PATH") lines, $(wc -c < "$ACCOUNT_FILE_PATH") bytes)"

# Generate profile
echo "Generating WireGuard profile..."
PROFILE_FILE="wgcf-profile.conf"
PROFILE_FILE_PATH="/tmp/$PROFILE_FILE"

# Check wgcf help to see available options
echo "Checking wgcf version and options..."
wgcf --version || true
echo ""

# Run wgcf generate - specify config file explicitly
echo "Running: wgcf generate --config $ACCOUNT_FILE_PATH"
if wgcf generate --config "$ACCOUNT_FILE_PATH" 2>&1 | tee /tmp/wgcf-output.log; then
    echo "✓ wgcf generate completed with --config flag"
elif wgcf generate 2>&1 | tee /tmp/wgcf-output.log; then
    echo "✓ wgcf generate completed without --config flag"
else
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

# Check for profile file at expected path first
if [ -f "$PROFILE_FILE_PATH" ]; then
    echo "✓ Profile found: $PROFILE_FILE_PATH ($(wc -l < "$PROFILE_FILE_PATH") lines)"
elif [ -f "$PROFILE_FILE" ]; then
    echo "✓ Profile found in current directory, copying to /tmp"
    cp "$PROFILE_FILE" "$PROFILE_FILE_PATH"
else
    # Try to find the file anywhere
    echo "Searching for profile file..."
    FOUND_FILE=$(find /tmp -name "wgcf-profile.conf" -o -name "*.conf" 2>/dev/null | head -n 1)
    if [ -n "$FOUND_FILE" ] && [ -f "$FOUND_FILE" ]; then
        echo "✓ Profile found at: $FOUND_FILE"
        cp "$FOUND_FILE" "$PROFILE_FILE_PATH"
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

# Extract keys from profile file
PRIVATE_KEY=$(grep "PrivateKey" "$PROFILE_FILE_PATH" | cut -d '=' -f 2 | tr -d ' ')
ADDRESS=$(grep "Address" "$PROFILE_FILE_PATH" | cut -d '=' -f 2 | tr -d ' ' | head -n 1)
PUBLIC_KEY=$(grep "PublicKey" "$PROFILE_FILE_PATH" | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT=$(grep "Endpoint" "$PROFILE_FILE_PATH" | cut -d '=' -f 2 | tr -d ' ')
ENDPOINT_IP=$(echo "$ENDPOINT" | cut -d ':' -f 1)
ENDPOINT_PORT=$(echo "$ENDPOINT" | cut -d ':' -f 2)
PRESHARED_KEY=$(grep "PresharedKey" "$PROFILE_FILE_PATH" | cut -d '=' -f 2 | tr -d ' ' 2>/dev/null || echo "")

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

