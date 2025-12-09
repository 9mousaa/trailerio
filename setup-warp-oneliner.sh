#!/bin/bash
# One-liner Cloudflare Warp setup for TrailerIO
# Run this on your VPS: bash setup-warp-oneliner.sh /opt/trailerio

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
cd "$PROJECT_DIR" || exit 1

echo "Setting up Cloudflare Warp for TrailerIO..."

# Install wgcf if not exists or if it's empty
if ! command -v wgcf &> /dev/null || [ ! -s "$(which wgcf 2>/dev/null)" ]; then
    echo "Installing wgcf..."
    ARCH=$(uname -m)
    [ "$ARCH" = "x86_64" ] && ARCH="amd64" || ARCH="arm64"
    
    # Try to get latest version from GitHub API
    LATEST_VERSION=$(curl -s https://api.github.com/repos/ViRb3/wgcf/releases/latest | grep "tag_name" | cut -d '"' -f 4 | sed 's/v//')
    if [ -z "$LATEST_VERSION" ]; then
        LATEST_VERSION="2.2.21"
    fi
    
    echo "Downloading wgcf version ${LATEST_VERSION} for ${ARCH}..."
    
    # Try multiple download URLs
    DOWNLOADED=false
    for URL in \
        "https://github.com/ViRb3/wgcf/releases/download/v${LATEST_VERSION}/wgcf_${LATEST_VERSION}_linux_${ARCH}" \
        "https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_${LATEST_VERSION}_linux_${ARCH}" \
        "https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_${ARCH}"; do
        echo "Trying: $URL"
        if wget -q --timeout=10 "$URL" -O /tmp/wgcf && [ -s /tmp/wgcf ]; then
            DOWNLOADED=true
            echo "✓ Downloaded successfully ($(wc -c < /tmp/wgcf) bytes)"
            break
        fi
    done
    
    if [ "$DOWNLOADED" = false ] || [ ! -s /tmp/wgcf ]; then
        echo "✗ Error: Failed to download wgcf"
        echo "Please download manually from: https://github.com/ViRb3/wgcf/releases"
        exit 1
    fi
    
    chmod +x /tmp/wgcf
    sudo mv /tmp/wgcf /usr/local/bin/wgcf 2>/dev/null || mv /tmp/wgcf /usr/local/bin/wgcf
    
    # Verify installation
    if [ ! -s /usr/local/bin/wgcf ]; then
        echo "✗ Error: wgcf binary is empty after installation"
        exit 1
    fi
    
    echo "✓ wgcf installed ($(wc -c < /usr/local/bin/wgcf) bytes)"
fi

# Verify wgcf works
echo "Verifying wgcf installation..."
echo "Binary info:"
file /usr/local/bin/wgcf 2>&1
ls -lh /usr/local/bin/wgcf 2>&1

# Try with timeout to prevent hanging
echo "Testing wgcf --version (with 5s timeout)..."
if timeout 5 wgcf --version > /tmp/wgcf-version.log 2>&1; then
    VERSION_OUTPUT=$(cat /tmp/wgcf-version.log)
    echo "✓ wgcf verified: $VERSION_OUTPUT"
elif [ -s /tmp/wgcf-version.log ]; then
    VERSION_OUTPUT=$(cat /tmp/wgcf-version.log)
    echo "⚠ wgcf --version output: $VERSION_OUTPUT"
    echo "Continuing anyway..."
else
    echo "⚠ wgcf --version timed out or produced no output"
    echo "Checking if binary is executable..."
    if [ -x /usr/local/bin/wgcf ]; then
        echo "Binary is executable, continuing anyway..."
    else
        echo "✗ Binary is not executable, fixing permissions..."
        chmod +x /usr/local/bin/wgcf
    fi
fi

# Register and generate
cd /tmp || exit 1

# Register if not already registered
ACCOUNT_FILE="wgcf-account.toml"
ACCOUNT_FILE_PATH="/tmp/$ACCOUNT_FILE"

# First, check if account file exists anywhere
echo "Checking for existing account file..."
EXISTING_ACCOUNT=$(find /tmp /root /home -name "wgcf-account.toml" 2>/dev/null | head -n 1)
if [ -n "$EXISTING_ACCOUNT" ] && [ -f "$EXISTING_ACCOUNT" ]; then
    echo "✓ Found existing account file at: $EXISTING_ACCOUNT"
    # Normalize paths to compare properly
    EXISTING_NORM=$(readlink -f "$EXISTING_ACCOUNT" 2>/dev/null || echo "$EXISTING_ACCOUNT")
    TARGET_NORM=$(readlink -f "$ACCOUNT_FILE_PATH" 2>/dev/null || echo "$ACCOUNT_FILE_PATH")
    if [ "$EXISTING_NORM" != "$TARGET_NORM" ]; then
        cp "$EXISTING_ACCOUNT" "$ACCOUNT_FILE_PATH" || true
        echo "✓ Copied to $ACCOUNT_FILE_PATH"
    else
        echo "✓ Account file already at target location"
    fi
elif [ -f "$ACCOUNT_FILE_PATH" ]; then
    echo "✓ Account file already exists at: $ACCOUNT_FILE_PATH"
else
    echo "No existing account file found, registering..."
    
    # Check wgcf status first
    echo "Checking wgcf status..."
    cd /tmp || exit 1
    wgcf status 2>&1 || echo "wgcf status failed or not registered"
    echo ""
    
    # Try registration - wgcf typically creates file in current directory
    echo "Running: wgcf register (in /tmp directory)"
    
    # Try with accept-tos flag if available, or just register
    if wgcf register --accept-tos > /tmp/wgcf-register-stdout.log 2> /tmp/wgcf-register-stderr.log 2>&1; then
        REGISTER_EXIT=$?
        echo "✓ Registration command completed (exit code: $REGISTER_EXIT)"
    else
        # Try without accept-tos
        echo "Trying without --accept-tos flag..."
        if wgcf register > /tmp/wgcf-register-stdout.log 2> /tmp/wgcf-register-stderr.log 2>&1; then
            REGISTER_EXIT=$?
            echo "✓ Registration command completed (exit code: $REGISTER_EXIT)"
        else
            REGISTER_EXIT=$?
            echo "⚠ Registration command returned exit code: $REGISTER_EXIT"
        fi
    fi
    
    echo "Stdout:"
    cat /tmp/wgcf-register-stdout.log || echo "(empty)"
    echo "Stderr:"
    cat /tmp/wgcf-register-stderr.log || echo "(empty)"
    
    # Wait a moment for file to be written
    sleep 3
    
    # Check if stdout contains the account file content (some versions output to stdout)
    if [ -s /tmp/wgcf-register-stdout.log ]; then
        if grep -q "license_key\|access_token\|device_id" /tmp/wgcf-register-stdout.log 2>/dev/null; then
            echo "✓ Found account data in stdout, saving to file..."
            cat /tmp/wgcf-register-stdout.log > "$ACCOUNT_FILE_PATH"
        fi
    fi
    
    # Check if file was created in current directory (wgcf creates it in pwd)
    if [ -f "$ACCOUNT_FILE" ] && [ -s "$ACCOUNT_FILE" ]; then
        echo "✓ Account file found in current directory: $(pwd)/$ACCOUNT_FILE"
        if [ "$ACCOUNT_FILE" != "$ACCOUNT_FILE_PATH" ]; then
            cp "$ACCOUNT_FILE" "$ACCOUNT_FILE_PATH"
        else
            echo "✓ Account file already at target location"
        fi
    elif [ -f "$ACCOUNT_FILE_PATH" ] && [ -s "$ACCOUNT_FILE_PATH" ]; then
        echo "✓ Account file found at specified path: $ACCOUNT_FILE_PATH"
    else
        # Search for the file in common locations
        echo "Searching for account file..."
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
                echo "All files in /tmp:"
                ls -la /tmp/ | grep -E "(wgcf|account)" || echo "No matching files"
                echo ""
                echo "Trying to generate profile anyway (might work if already registered)..."
                # Don't exit - try to continue with generation
            fi
        fi
    fi
fi

# Verify account file exists and has content
if [ ! -f "$ACCOUNT_FILE_PATH" ] || [ ! -s "$ACCOUNT_FILE_PATH" ]; then
    echo "⚠ Warning: wgcf-account.toml not found after registration"
    echo "Trying wgcf update to refresh account..."
    cd /tmp || exit 1
    if wgcf update > /tmp/wgcf-update.log 2>&1; then
        echo "wgcf update completed, output:"
        cat /tmp/wgcf-update.log
        # Check if update created the account file
        if [ -f "$ACCOUNT_FILE" ] && [ -s "$ACCOUNT_FILE" ]; then
            echo "✓ Account file created by wgcf update"
            cp "$ACCOUNT_FILE" "$ACCOUNT_FILE_PATH"
        fi
    fi
    
    # Final check
    if [ ! -f "$ACCOUNT_FILE_PATH" ] || [ ! -s "$ACCOUNT_FILE_PATH" ]; then
        echo "⚠ Still no account file, but continuing with generation..."
    fi
else
    echo "✓ Account file verified at $ACCOUNT_FILE_PATH ($(wc -l < "$ACCOUNT_FILE_PATH") lines, $(wc -c < "$ACCOUNT_FILE_PATH") bytes)"
fi

# Generate profile
echo "Generating WireGuard profile..."
PROFILE_FILE="wgcf-profile.conf"
PROFILE_FILE_PATH="/tmp/$PROFILE_FILE"

# Check wgcf help to see available options
echo "Checking wgcf version and options..."
wgcf --version || true
echo ""

# Run wgcf generate - it reads from current directory by default
echo "Running: wgcf generate (account file should be in current directory)"
# Ensure we're in /tmp and account file is there
cd /tmp || exit 1
if [ -f "$ACCOUNT_FILE_PATH" ] && [ ! -f "$ACCOUNT_FILE" ]; then
    cp "$ACCOUNT_FILE_PATH" "$ACCOUNT_FILE"
    echo "✓ Copied account file to current directory"
fi

# Try generate - it might work even without explicit account file if already registered
echo "Attempting wgcf generate..."
# Capture stdout directly to profile file (wgcf might output to stdout)
if wgcf generate > "$PROFILE_FILE_PATH" 2> /tmp/wgcf-generate-stderr.log; then
    GENERATE_EXIT=$?
    echo "✓ wgcf generate completed (exit code: $GENERATE_EXIT)"
    echo "Stderr output:"
    cat /tmp/wgcf-generate-stderr.log || echo "(empty)"
    
    # Check if file was created and has content
    if [ -f "$PROFILE_FILE_PATH" ] && [ -s "$PROFILE_FILE_PATH" ]; then
        echo "✓ Profile file created: $PROFILE_FILE_PATH ($(wc -l < "$PROFILE_FILE_PATH") lines)"
    else
        echo "⚠ Profile file is empty or missing, trying alternative method..."
        # Try with tee to capture both file and log
        wgcf generate 2>&1 | tee "$PROFILE_FILE_PATH" > /tmp/wgcf-output.log
        if [ -s "$PROFILE_FILE_PATH" ]; then
            echo "✓ Profile captured via tee"
        else
            echo "✗ Failed to generate profile - no output captured"
            cat /tmp/wgcf-generate-stderr.log 2>/dev/null || true
            exit 1
        fi
    fi
else
    EXIT_CODE=$?
    echo "✗ wgcf generate failed with exit code: $EXIT_CODE"
    echo "Stderr:"
    cat /tmp/wgcf-generate-stderr.log 2>/dev/null || echo "No stderr captured"
    echo "Checking if profile was created anyway..."
    if [ -f "$PROFILE_FILE_PATH" ] && [ -s "$PROFILE_FILE_PATH" ]; then
        echo "✓ Profile file exists despite error code"
    else
        exit 1
    fi
fi

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

