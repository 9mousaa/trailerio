#!/bin/bash

# Robust script to set up multiple Cloudflare Warp instances
# This script generates WireGuard keys for multiple Warp accounts and configures .env

# Error handling - don't exit on error in functions, handle manually
set -u  # Exit on undefined variable
set -o pipefail  # Catch errors in pipes

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NUM_INSTANCES=${1:-3}  # Default to 3 instances, can be overridden
ENV_FILE=".env"
BACKUP_ENV_FILE=".env.backup.$(date +%Y%m%d_%H%M%S)"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if wgcf is installed
check_wgcf() {
    if ! command -v wgcf &> /dev/null; then
        log_error "wgcf is not installed!"
        log_info "Installing wgcf..."
        
        # Try to install wgcf
        if command -v go &> /dev/null; then
            log_info "Installing wgcf via go install..."
            go install github.com/ViRb3/wgcf@latest
            export PATH="$PATH:$(go env GOPATH)/bin"
        elif command -v curl &> /dev/null; then
            log_info "Installing wgcf via direct download..."
            WGCF_VERSION="2.2.20"
            ARCH=$(uname -m)
            case $ARCH in
                x86_64) ARCH="amd64" ;;
                aarch64|arm64) ARCH="arm64" ;;
                *) log_error "Unsupported architecture: $ARCH"; exit 1 ;;
            esac
            
            curl -fsSL "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_${ARCH}" -o /tmp/wgcf
            chmod +x /tmp/wgcf
            export PATH="$PATH:/tmp"
        else
            log_error "Cannot install wgcf. Please install it manually:"
            log_info "  go install github.com/ViRb3/wgcf@latest"
            log_info "  or download from: https://github.com/ViRb3/wgcf/releases"
            exit 1
        fi
        
        if ! command -v wgcf &> /dev/null; then
            log_error "Failed to install wgcf. Please install manually."
            exit 1
        fi
    fi
    
    log_success "wgcf is available"
}

# Generate WireGuard config for one instance
generate_warp_config() {
    local instance_num=$1
    local temp_dir="/tmp/wgcf-instance-${instance_num}"
    local original_dir=$(pwd)
    
    log_info "Generating Warp config for instance ${instance_num}..."
    
    # Create temp directory
    mkdir -p "$temp_dir" || return 1
    cd "$temp_dir" || return 1
    
    # Clean up any existing config
    rm -f wgcf-account.toml wgcf-profile.conf
    
    # Register new account (with timeout to avoid hanging)
    log_info "Registering new Cloudflare Warp account..."
    # Use timeout if available, otherwise run directly (with set -e, script will exit on error)
    if command -v timeout &> /dev/null; then
        if ! timeout 60 wgcf register --accept-tos -n "trailerio-instance-${instance_num}" 2>&1 | tee register.log; then
            log_error "Failed to register Warp account for instance ${instance_num}"
            cd - > /dev/null
            rm -rf "$temp_dir"
            return 1
        fi
    else
        # No timeout command - run directly (risky but better than failing)
        log_warning "timeout command not available, running without timeout (may hang)"
        if ! wgcf register --accept-tos -n "trailerio-instance-${instance_num}" 2>&1 | tee register.log; then
            log_error "Failed to register Warp account for instance ${instance_num}"
            cd - > /dev/null
            rm -rf "$temp_dir"
            return 1
        fi
    fi
    
    # Generate WireGuard profile
    log_info "Generating WireGuard profile..."
    if command -v timeout &> /dev/null; then
        if ! timeout 60 wgcf generate 2>&1 | tee generate.log; then
            log_error "Failed to generate WireGuard profile for instance ${instance_num}"
            cd - > /dev/null
            rm -rf "$temp_dir"
            return 1
        fi
    else
        if ! wgcf generate 2>&1 | tee generate.log; then
            log_error "Failed to generate WireGuard profile for instance ${instance_num}"
            cd - > /dev/null
            rm -rf "$temp_dir"
            return 1
        fi
    fi
    
    # Parse the config file
    if [ ! -f "wgcf-profile.conf" ]; then
        log_error "WireGuard profile not generated for instance ${instance_num}"
        cd - > /dev/null
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Extract values from config (more robust parsing)
    # Handle cases where there might be comments or extra whitespace
    # Use awk for more reliable extraction, and remove ALL whitespace including newlines
    local private_key=$(grep "^PrivateKey" wgcf-profile.conf | head -n1 | awk -F'=' '{print $2}' | sed 's/[[:space:]]*#.*$//' | tr -d ' \n\r\t')
    local address=$(grep "^Address" wgcf-profile.conf | head -n1 | awk -F'=' '{print $2}' | sed 's/[[:space:]]*#.*$//' | tr -d ' \n\r\t' | cut -d',' -f1)
    # NOTE: For gluetun custom WireGuard provider, we need the SERVER's public key, not the client's
    # Cloudflare Warp server's public key is a well-known constant
    # The client's public key from wgcf is NOT used by gluetun
    local server_public_key="bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
    local preshared_key=$(grep "^PresharedKey" wgcf-profile.conf | head -n1 | awk -F'=' '{print $2}' | sed 's/[[:space:]]*#.*$//' | tr -d ' \n\r\t' || echo "")
    local endpoint=$(grep "^Endpoint" wgcf-profile.conf | head -n1 | awk -F'=' '{print $2}' | sed 's/[[:space:]]*#.*$//' | tr -d ' \n\r\t')
    local endpoint_host=$(echo "$endpoint" | cut -d':' -f1)
    local endpoint_port=$(echo "$endpoint" | cut -d':' -f2)
    
    # Resolve hostname to IP (gluetun requires IP, not hostname)
    # Default Cloudflare endpoint is engage.cloudflareclient.com
    local endpoint_ip=""
    if [ -n "$endpoint_host" ]; then
        # Try to resolve to IP
        if command -v getent &> /dev/null; then
            endpoint_ip=$(getent hosts "$endpoint_host" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
        elif command -v dig &> /dev/null; then
            endpoint_ip=$(dig +short -4 "$endpoint_host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
        fi
        
        # If resolution failed, use common Cloudflare IPs as fallback
        if [ -z "$endpoint_ip" ]; then
            log_warning "Could not resolve ${endpoint_host}, using default Cloudflare IP"
            endpoint_ip="162.159.192.1"  # Common Cloudflare Warp endpoint IP
        fi
    fi
    
    # Default port if not found
    if [ -z "$endpoint_port" ]; then
        endpoint_port="2408"
    fi
    
    # Validate extracted values and format
    # WireGuard keys should be base64 encoded, 32 bytes = 44 characters (with padding)
    # Private keys: 44 chars, Public keys: 44 chars
    local key_length_ok=true
    
    # Remove any newlines or extra whitespace
    private_key=$(echo "$private_key" | tr -d '\n\r')
    server_public_key=$(echo "$server_public_key" | tr -d '\n\r')
    preshared_key=$(echo "$preshared_key" | tr -d '\n\r')
    
    if [ -z "$private_key" ] || [ ${#private_key} -lt 40 ] || [ ${#private_key} -gt 44 ]; then
        log_error "Invalid private key length for instance ${instance_num} (got ${#private_key} chars, expected 40-44)"
        key_length_ok=false
    fi
    
    # Server public key should be exactly 44 characters
    if [ -z "$server_public_key" ] || [ ${#server_public_key} -ne 44 ]; then
        log_error "Invalid server public key length for instance ${instance_num} (got ${#server_public_key} chars, expected 44)"
        key_length_ok=false
    fi
    
    # Validate base64 format (basic check - should only contain base64 chars)
    if [ -n "$private_key" ] && ! echo "$private_key" | grep -qE '^[A-Za-z0-9+/=]+$'; then
        log_error "Private key contains invalid characters for instance ${instance_num}"
        key_length_ok=false
    fi
    
    if [ -n "$server_public_key" ] && ! echo "$server_public_key" | grep -qE '^[A-Za-z0-9+/=]+$'; then
        log_error "Server public key contains invalid characters for instance ${instance_num}"
        key_length_ok=false
    fi
    
    if [ -z "$address" ] || [ -z "$endpoint_ip" ]; then
        log_error "Missing address or endpoint IP for instance ${instance_num}"
        key_length_ok=false
    fi
    
    if [ "$key_length_ok" = false ]; then
        log_error "Failed to extract valid values from config for instance ${instance_num}"
        log_info "Config file contents:"
        cat wgcf-profile.conf | head -20
        cd "$original_dir" 2>/dev/null || true
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Return to original directory (safe even if cd failed)
    cd "$original_dir" 2>/dev/null || true
    
    # Output the values to stdout (will be captured by caller)
    # Use printf to avoid issues with special characters
    # Ensure keys are exactly the right length (44 chars for base64 32-byte keys)
    # Remove any trailing newlines or extra characters (but preserve = padding)
    private_key=$(echo -n "$private_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    server_public_key=$(echo -n "$server_public_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    preshared_key=$(echo -n "$preshared_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    
    # CRITICAL: Ensure private key is exactly 44 characters (base64 padding)
    # WireGuard private keys are 32 bytes = 43 base64 chars (without padding) = 44 with = padding
    # Base64 encoding: 32 bytes = 256 bits = 42.67 base64 chars, rounded to 43, padded to 44
    # Handle all cases: 40-43 chars need padding to 44
    local key_len=${#private_key}
    if [ $key_len -lt 40 ] || [ $key_len -gt 44 ]; then
        log_error "Private key for instance ${instance_num} has invalid length: ${key_len} chars (expected 40-44)"
        return 1
    fi
    
    # Pad to exactly 44 characters with = (base64 padding)
    while [ ${#private_key} -lt 44 ]; do
        private_key="${private_key}="
    done
    
    # Remove any extra padding (shouldn't happen, but safety check)
    if [ ${#private_key} -gt 44 ]; then
        private_key="${private_key:0:44}"
    fi
    
    # Validate final key length is exactly 44
    if [ ${#private_key} -ne 44 ]; then
        log_error "Private key for instance ${instance_num} is ${#private_key} chars after padding (expected 44)"
        return 1
    fi
    
    # Validate base64 format (should end with = and contain only base64 chars)
    if ! echo "$private_key" | grep -qE '^[A-Za-z0-9+/]+=+$'; then
        log_error "Private key for instance ${instance_num} has invalid base64 format"
        return 1
    fi
    
    log_info "Private key for instance ${instance_num} validated: ${key_len} -> 44 chars"
    
    printf "PRIVATE_KEY=%s\n" "$private_key"
    printf "ADDRESS=%s\n" "$address"
    printf "PUBLIC_KEY=%s\n" "$server_public_key"
    printf "PRESHARED_KEY=%s\n" "$preshared_key"
    printf "ENDPOINT_IP=%s\n" "$endpoint_ip"
    printf "ENDPOINT_PORT=%s\n" "$endpoint_port"
    
    # Clean up
    rm -rf "$temp_dir"
    
    log_success "Generated config for instance ${instance_num}" >&2
    return 0
}

# Backup existing .env file
backup_env() {
    if [ -f "$ENV_FILE" ]; then
        log_info "Backing up existing .env to ${BACKUP_ENV_FILE}..."
        cp "$ENV_FILE" "$BACKUP_ENV_FILE"
        log_success "Backup created"
    fi
}

# Update .env file with new values
update_env_file() {
    local instance_num=$1
    local private_key=$2
    local address=$3
    local public_key=$4
    local preshared_key=$5
    local endpoint_ip=$6
    local endpoint_port=$7
    
    # Create .env if it doesn't exist
    if [ ! -f "$ENV_FILE" ]; then
        touch "$ENV_FILE"
    fi
    
    # Remove old values for this instance
    sed -i.bak "/^WIREGUARD_PRIVATE_KEY_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    sed -i.bak "/^WIREGUARD_ADDRESSES_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    sed -i.bak "/^WIREGUARD_PUBLIC_KEY_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    sed -i.bak "/^WIREGUARD_PRESHARED_KEY_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    sed -i.bak "/^WIREGUARD_ENDPOINT_IP_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    sed -i.bak "/^WIREGUARD_ENDPOINT_PORT_${instance_num}=/d" "$ENV_FILE" 2>/dev/null || true
    rm -f "${ENV_FILE}.bak"
    
    # Append new values (ensure no trailing newlines in values)
    # Clean all values one more time before writing (preserve = padding)
    private_key=$(echo -n "$private_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    public_key=$(echo -n "$public_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    preshared_key=$(echo -n "$preshared_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
    address=$(echo -n "$address" | tr -d '\n\r\t ')
    endpoint_ip=$(echo -n "$endpoint_ip" | tr -d '\n\r\t ')
    endpoint_port=$(echo -n "$endpoint_port" | tr -d '\n\r\t ')
    
    # CRITICAL: Ensure private key is exactly 44 characters (base64 padding)
    # WireGuard private keys are 32 bytes = 43 base64 chars (without padding) = 44 with = padding
    local original_key_len=${#private_key}
    if [ $original_key_len -lt 40 ] || [ $original_key_len -gt 44 ]; then
        log_error "Private key for instance ${instance_num} has invalid length: ${original_key_len} chars (expected 40-44) - SKIPPING"
        return 1
    fi
    
    # Pad to exactly 44 characters with = (base64 padding)
    while [ ${#private_key} -lt 44 ]; do
        private_key="${private_key}="
    done
    
    # Remove any extra padding (shouldn't happen, but safety check)
    if [ ${#private_key} -gt 44 ]; then
        private_key="${private_key:0:44}"
    fi
    
    # Validate final key length is exactly 44
    if [ ${#private_key} -ne 44 ]; then
        log_error "Private key for instance ${instance_num} is ${#private_key} chars after padding (expected 44) - SKIPPING"
        return 1
    fi
    
    # Validate base64 format
    if ! echo "$private_key" | grep -qE '^[A-Za-z0-9+/]+=+$'; then
        log_error "Private key for instance ${instance_num} has invalid base64 format - SKIPPING"
        return 1
    fi
    
    if [ $original_key_len -ne 44 ]; then
        log_info "Padded private key for instance ${instance_num}: ${original_key_len} -> 44 chars"
    fi
    
    # Final validation before writing
    if [ ${#private_key} -ne 44 ]; then
        log_error "FINAL CHECK FAILED: Private key for instance ${instance_num} is ${#private_key} chars (expected 44) - NOT WRITING"
        return 1
    fi
    
    echo "" >> "$ENV_FILE"
    echo "# Cloudflare Warp Instance ${instance_num}" >> "$ENV_FILE"
    
    # CRITICAL: Write the private key with explicit formatting to preserve = padding
    # Write variable name, then =, then value, then newline separately
    printf 'WIREGUARD_PRIVATE_KEY_%s=' "${instance_num}" >> "$ENV_FILE"
    printf '%s' "${private_key}" >> "$ENV_FILE"
    printf '\n' >> "$ENV_FILE"
    
    # Write other variables normally
    printf 'WIREGUARD_ADDRESSES_%s=%s\n' "${instance_num}" "${address}" >> "$ENV_FILE"
    printf 'WIREGUARD_PUBLIC_KEY_%s=%s\n' "${instance_num}" "${public_key}" >> "$ENV_FILE"
    printf 'WIREGUARD_PRESHARED_KEY_%s=%s\n' "${instance_num}" "${preshared_key}" >> "$ENV_FILE"
    printf 'WIREGUARD_ENDPOINT_IP_%s=%s\n' "${instance_num}" "${endpoint_ip}" >> "$ENV_FILE"
    printf 'WIREGUARD_ENDPOINT_PORT_%s=%s\n' "${instance_num}" "${endpoint_port}" >> "$ENV_FILE"
    
    # Verify what was written (read back and check)
    # Use tail -1 to get the most recent line (in case there are duplicates from previous runs)
    local written_key=$(grep "^WIREGUARD_PRIVATE_KEY_${instance_num}=" "$ENV_FILE" | tail -1 | cut -d'=' -f2- | tr -d '\n\r')
    local written_len=${#written_key}
    
    if [ $written_len -ne 44 ]; then
        log_error "VERIFICATION FAILED: Written key for instance ${instance_num} is ${written_len} chars (expected 44)"
        log_error "  Original key length before write: ${#private_key} chars"
        log_error "  Written key preview: '${written_key:0:20}...${written_key: -5}'"
        log_error "  Last char: '${written_key: -1}' (expected '=')"
        return 1
    fi
    
    # Double-check: verify the last character is =
    if [ "${written_key: -1}" != "=" ]; then
        log_error "VERIFICATION FAILED: Written key for instance ${instance_num} does not end with ="
        log_error "  Last character: '${written_key: -1}' (ASCII: $(printf '%d' "'${written_key: -1}"))"
        return 1
    fi
    
    log_success "Instance ${instance_num} key written and verified: 44 chars (ends with =)"
}

# Verify all keys in .env file are correct length
verify_env_keys() {
    log_info "Verifying all WireGuard keys in .env file..."
    local all_valid=true
    local key_count=0
    local invalid_count=0
    
    # Use grep to find all WIREGUARD_PRIVATE_KEY lines, then parse with cut
    # This is more reliable than IFS='=' read when values contain = signs
    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        [[ ! "$line" =~ ^WIREGUARD_PRIVATE_KEY ]] && continue
        
        # Extract key name and value using cut (handles = in values correctly)
        local key=$(echo "$line" | cut -d'=' -f1 | tr -d '\n\r\t ')
        local value=$(echo "$line" | cut -d'=' -f2- | tr -d '\n\r\t ')
        
        # Skip if key or value is empty
        [[ -z "$key" ]] && continue
        [[ -z "$value" ]] && continue
        
        key_count=$((key_count + 1))
        local key_len=${#value}
        
        if [ $key_len -ne 44 ]; then
            log_error "  ✗ ${key}: ${key_len} chars (expected 44)"
            # Debug: show first and last few chars
            log_info "    Debug: value starts with '${value:0:10}...' ends with '...${value: -5}'"
            invalid_count=$((invalid_count + 1))
            all_valid=false
        else
            log_success "  ✓ ${key}: ${key_len} chars (correct)"
        fi
    done < "$ENV_FILE"
    
    if [ $invalid_count -gt 0 ]; then
        log_error "Found ${invalid_count}/${key_count} invalid private keys in .env file"
        return 1
    elif [ $key_count -eq 0 ]; then
        log_warning "No WIREGUARD_PRIVATE_KEY variables found in .env file"
        return 1
    else
        log_success "All ${key_count} private keys are valid (44 chars each)"
        return 0
    fi
}

# Main execution
main() {
    log_info "=== Cloudflare Warp Multi-Instance Setup ==="
    log_info "Setting up ${NUM_INSTANCES} Warp instances..."
    echo ""
    
    # Check prerequisites
    check_wgcf
    
    # Backup .env
    backup_env
    
    # Generate configs for each instance
    local success_count=0
    for i in $(seq 1 $NUM_INSTANCES); do
        echo ""
        log_info "=== Processing Instance ${i}/${NUM_INSTANCES} ==="
        
        # Generate config with retry logic
        local retries=3
        local config_success=false
        
        while [ $retries -gt 0 ] && [ "$config_success" = false ]; do
            set +e  # Temporarily disable exit on error for this function call
            # Capture stdout (variable assignments) separately from stderr (logs)
            local config_output=""
            config_output=$(generate_warp_config $i 2>/dev/null)
            local generate_exit=$?
            set -e  # Re-enable exit on error
            
            if [ $generate_exit -eq 0 ] && [ -n "$config_output" ]; then
                # Parse the output line by line to avoid eval issues
                local parsed_private_key=""
                local parsed_address=""
                local parsed_public_key=""
                local parsed_preshared_key=""
                local parsed_endpoint_ip=""
                local parsed_endpoint_port=""
                
                while IFS= read -r line; do
                    if [[ "$line" =~ ^PRIVATE_KEY=(.+)$ ]]; then
                        # Extract and clean the key (preserve = padding)
                        parsed_private_key="${BASH_REMATCH[1]}"
                        parsed_private_key=$(echo -n "$parsed_private_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
                    elif [[ "$line" =~ ^ADDRESS=(.+)$ ]]; then
                        parsed_address="${BASH_REMATCH[1]}"
                        parsed_address=$(echo -n "$parsed_address" | tr -d '\n\r\t ')
                    elif [[ "$line" =~ ^PUBLIC_KEY=(.+)$ ]]; then
                        parsed_public_key="${BASH_REMATCH[1]}"
                        parsed_public_key=$(echo -n "$parsed_public_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
                    elif [[ "$line" =~ ^PRESHARED_KEY=(.+)$ ]]; then
                        parsed_preshared_key="${BASH_REMATCH[1]}"
                        parsed_preshared_key=$(echo -n "$parsed_preshared_key" | tr -d '\n\r\t ' | sed 's/[[:space:]]*$//')
                    elif [[ "$line" =~ ^ENDPOINT_IP=(.+)$ ]]; then
                        parsed_endpoint_ip="${BASH_REMATCH[1]}"
                        parsed_endpoint_ip=$(echo -n "$parsed_endpoint_ip" | tr -d '\n\r\t ')
                    elif [[ "$line" =~ ^ENDPOINT_PORT=(.+)$ ]]; then
                        parsed_endpoint_port="${BASH_REMATCH[1]}"
                        parsed_endpoint_port=$(echo -n "$parsed_endpoint_port" | tr -d '\n\r\t ')
                    fi
                done <<< "$config_output"
                
                # CRITICAL: Ensure private key is exactly 44 characters after parsing
                if [ -n "$parsed_private_key" ]; then
                    local key_len=${#parsed_private_key}
                    if [ $key_len -lt 40 ] || [ $key_len -gt 44 ]; then
                        log_error "Parsed private key has invalid length: ${key_len} chars (expected 40-44)"
                        parsed_private_key=""
                    else
                        # Pad to exactly 44 characters
                        while [ ${#parsed_private_key} -lt 44 ]; do
                            parsed_private_key="${parsed_private_key}="
                        done
                        # Safety: truncate if somehow longer
                        if [ ${#parsed_private_key} -gt 44 ]; then
                            parsed_private_key="${parsed_private_key:0:44}"
                        fi
                        # Final validation
                        if [ ${#parsed_private_key} -ne 44 ]; then
                            log_error "Private key padding failed: ${#parsed_private_key} chars (expected 44)"
                            parsed_private_key=""
                        fi
                    fi
                fi
                
                # Validate parsed values
                if [ -n "$parsed_private_key" ] && [ ${#parsed_private_key} -eq 44 ] && [ -n "$parsed_address" ] && [ -n "$parsed_public_key" ] && [ -n "$parsed_endpoint_ip" ]; then
                    # Update .env file
                    update_env_file "$i" "$parsed_private_key" "$parsed_address" "$parsed_public_key" "${parsed_preshared_key:-}" "$parsed_endpoint_ip" "${parsed_endpoint_port:-2408}"
                    
                    log_success "Instance ${i} configured successfully"
                    success_count=$((success_count + 1))
                    config_success=true
                    break
                else
                    log_warning "Config generated but parsing failed for instance ${i}"
                    log_info "Debug: private_key=${parsed_private_key:0:20}..., address=${parsed_address}, public_key=${parsed_public_key:0:20}..., endpoint_ip=${parsed_endpoint_ip}"
                fi
            fi
            
            retries=$((retries - 1))
            if [ $retries -gt 0 ]; then
                log_warning "Failed to generate config for instance ${i}, retrying... (${retries} attempts left)"
                sleep 5  # Longer delay between retries
            else
                log_error "Failed to generate config for instance ${i} after 3 attempts"
                log_info "You can manually configure this instance later"
            fi
        done
        
        # Small delay between instances to avoid rate limiting
        if [ $i -lt $NUM_INSTANCES ]; then
            log_info "Waiting 5 seconds before next instance (to avoid rate limiting)..."
            sleep 5
        fi
    done
    
    echo ""
    log_info "=== Setup Complete ==="
    log_success "Successfully configured ${success_count}/${NUM_INSTANCES} instances"
    
    if [ $success_count -lt $NUM_INSTANCES ]; then
        log_warning "Some instances failed to configure. Check the logs above."
        log_info "You can run this script again to retry failed instances."
    fi
    
    echo ""
    # CRITICAL: Verify all keys are correct length before finishing
    if ! verify_env_keys; then
        log_error "KEY VERIFICATION FAILED - Some keys are invalid. Please review and fix."
        return 1
    fi
    
    echo ""
    log_info "Next steps:"
    log_info "1. Review the generated .env file"
    log_info "2. Start the services: docker compose up -d"
    log_info "3. Check proxy health: docker compose ps"
    echo ""
    
    if [ -f "$BACKUP_ENV_FILE" ]; then
        log_info "Original .env backed up to: ${BACKUP_ENV_FILE}"
    fi
}

# Run main function
main "$@"

