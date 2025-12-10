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
    
    # Extract values from config
    local private_key=$(grep "PrivateKey" wgcf-profile.conf | cut -d'=' -f2 | tr -d ' ')
    local address=$(grep "Address" wgcf-profile.conf | cut -d'=' -f2 | tr -d ' ' | head -n1)
    local public_key=$(grep "PublicKey" wgcf-profile.conf | cut -d'=' -f2 | tr -d ' ')
    local preshared_key=$(grep "PresharedKey" wgcf-profile.conf | cut -d'=' -f2 | tr -d ' ')
    local endpoint=$(grep "Endpoint" wgcf-profile.conf | cut -d'=' -f2 | tr -d ' ')
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
    
    # Validate extracted values
    if [ -z "$private_key" ] || [ -z "$address" ] || [ -z "$public_key" ] || [ -z "$endpoint_ip" ]; then
        log_error "Failed to extract all required values from config for instance ${instance_num}"
        log_info "Config file contents:"
        cat wgcf-profile.conf
        cd - > /dev/null
        rm -rf "$temp_dir"
        return 1
    fi
    
    # Return to original directory (safe even if cd failed)
    cd "$original_dir" 2>/dev/null || true
    
    # Output the values (will be captured by caller)
    echo "PRIVATE_KEY=${private_key}"
    echo "ADDRESS=${address}"
    echo "PUBLIC_KEY=${public_key}"
    echo "PRESHARED_KEY=${preshared_key}"
    echo "ENDPOINT_IP=${endpoint_ip}"
    echo "ENDPOINT_PORT=${endpoint_port}"
    
    # Clean up
    rm -rf "$temp_dir"
    
    log_success "Generated config for instance ${instance_num}"
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
    
    # Append new values
    echo "" >> "$ENV_FILE"
    echo "# Cloudflare Warp Instance ${instance_num}" >> "$ENV_FILE"
    echo "WIREGUARD_PRIVATE_KEY_${instance_num}=${private_key}" >> "$ENV_FILE"
    echo "WIREGUARD_ADDRESSES_${instance_num}=${address}" >> "$ENV_FILE"
    echo "WIREGUARD_PUBLIC_KEY_${instance_num}=${public_key}" >> "$ENV_FILE"
    echo "WIREGUARD_PRESHARED_KEY_${instance_num}=${preshared_key}" >> "$ENV_FILE"
    echo "WIREGUARD_ENDPOINT_IP_${instance_num}=${endpoint_ip}" >> "$ENV_FILE"
    echo "WIREGUARD_ENDPOINT_PORT_${instance_num}=${endpoint_port}" >> "$ENV_FILE"
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
            local config_output=""
            config_output=$(generate_warp_config $i 2>&1)
            local generate_exit=$?
            set -e  # Re-enable exit on error
            
            if [ $generate_exit -eq 0 ] && [ -n "$config_output" ]; then
                # Parse the output safely
                set +e  # Disable exit on error for eval
                eval "$config_output" 2>/dev/null
                local eval_exit=$?
                set -e
                
                if [ $eval_exit -eq 0 ] && [ -n "${PRIVATE_KEY:-}" ] && [ -n "${ADDRESS:-}" ] && [ -n "${PUBLIC_KEY:-}" ] && [ -n "${ENDPOINT_IP:-}" ]; then
                    # Update .env file
                    update_env_file "$i" "$PRIVATE_KEY" "$ADDRESS" "$PUBLIC_KEY" "${PRESHARED_KEY:-}" "$ENDPOINT_IP" "${ENDPOINT_PORT:-2408}"
                    
                    log_success "Instance ${i} configured successfully"
                    success_count=$((success_count + 1))
                    config_success=true
                    break
                else
                    log_warning "Config generated but parsing failed for instance ${i}"
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

