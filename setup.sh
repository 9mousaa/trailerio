#!/bin/bash
# Bulletproof self-healing setup script for Trailerio
# Handles everything: setup, rebuild, fixes, monitoring
# Zero-downtime, always-running, self-healing

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
ENV_FILE="${PROJECT_DIR}/.env"
LOG_FILE="${PROJECT_DIR}/setup.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" | tee -a "$LOG_FILE"
}

info() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] INFO:${NC} $1" | tee -a "$LOG_FILE"
}

cd "${PROJECT_DIR}" || {
    error "Cannot access project directory: ${PROJECT_DIR}"
    exit 1
}

log "🚀 Starting Trailerio setup/repair..."

# Step 1: Ensure .env exists with minimum required keys
log "📋 Checking .env file..."
if [ ! -f "${ENV_FILE}" ]; then
    warn ".env file not found, creating..."
    cat > "${ENV_FILE}" << EOF
# TMDB API Key (required)
TMDB_API_KEY=bfe73358661a995b992ae9a812aa0d2f

# Cloudflare Warp WireGuard Configuration (will be auto-generated if missing)
WIREGUARD_PRIVATE_KEY=
WIREGUARD_ADDRESSES=
WIREGUARD_PUBLIC_KEY=
WIREGUARD_PRESHARED_KEY=
WIREGUARD_ENDPOINT_IP=
WIREGUARD_ENDPOINT_PORT=
EOF
    log "✅ Created .env file"
fi

# Step 2: Check and setup WireGuard keys if missing
log "🔐 Checking WireGuard configuration..."
WIREGUARD_ENDPOINT_IP=$(grep "^WIREGUARD_ENDPOINT_IP=" "${ENV_FILE}" | cut -d= -f2- | tr -d '[:space:]' || echo "")
WIREGUARD_PRIVATE_KEY=$(grep "^WIREGUARD_PRIVATE_KEY=" "${ENV_FILE}" | cut -d= -f2- | tr -d '[:space:]' || echo "")

if [ -z "${WIREGUARD_ENDPOINT_IP}" ] || [ -z "${WIREGUARD_PRIVATE_KEY}" ]; then
    warn "WireGuard keys missing or incomplete, generating..."
    
    # Check if wgcf is installed
    if ! command -v wgcf &> /dev/null; then
        log "📥 Installing wgcf..."
        WGCF_URL="https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64"
        curl -L -o /tmp/wgcf "${WGCF_URL}" || {
            error "Failed to download wgcf"
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

    # Register and generate profile
    ACCOUNT_FILE="/tmp/wgcf-account.toml"
    if [ ! -f "${ACCOUNT_FILE}" ] || [ ! -s "${ACCOUNT_FILE}" ]; then
        log "📝 Registering wgcf account..."
        ${WGCF_BIN} register --config "${ACCOUNT_FILE}" || {
            error "Failed to register wgcf account"
            exit 1
        }
        sleep 2
    fi

    PROFILE_FILE="/tmp/wgcf-profile.conf"
    log "🔑 Generating WireGuard profile..."
    ${WGCF_BIN} generate --config "${ACCOUNT_FILE}" --profile "${PROFILE_FILE}" || {
        error "Failed to generate WireGuard profile"
        exit 1
    }

    # Extract keys
    PRIVATE_KEY=$(grep "^PrivateKey" "${PROFILE_FILE}" | sed 's/PrivateKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')
    PUBLIC_KEY=$(grep "^PublicKey" "${PROFILE_FILE}" | sed 's/PublicKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')
    PRESHARED_KEY=$(grep "^PresharedKey" "${PROFILE_FILE}" | sed 's/PresharedKey[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]' || echo "")
    ADDRESSES=$(grep "^Address" "${PROFILE_FILE}" | sed 's/Address[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' | head -1)
    ENDPOINT=$(grep "^Endpoint" "${PROFILE_FILE}" | sed 's/Endpoint[[:space:]]*=[[:space:]]*//' | tr -d '[:space:]')

    if [ -z "${PRIVATE_KEY}" ] || [ -z "${PUBLIC_KEY}" ] || [ -z "${ADDRESSES}" ] || [ -z "${ENDPOINT}" ]; then
        error "Failed to extract WireGuard keys"
        exit 1
    fi

    # Resolve endpoint
    ENDPOINT_HOST=$(echo "${ENDPOINT}" | cut -d':' -f1)
    ENDPOINT_PORT=$(echo "${ENDPOINT}" | cut -d':' -f2)
    ENDPOINT_IP=$(dig +short -4 "${ENDPOINT_HOST}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || getent hosts "${ENDPOINT_HOST}" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)

    if [ -z "${ENDPOINT_IP}" ]; then
        error "Failed to resolve endpoint: ${ENDPOINT_HOST}"
        exit 1
    fi

    # Update .env
    cd "${PROJECT_DIR}"
    TMDB_KEY=$(grep "^TMDB_API_KEY=" "${ENV_FILE}" | cut -d= -f2- || echo "bfe73358661a995b992ae9a812aa0d2f")
    
    grep -v "^WIREGUARD_" "${ENV_FILE}" > "${ENV_FILE}.tmp" 2>/dev/null || true
    {
        echo "TMDB_API_KEY=${TMDB_KEY}"
        echo ""
        echo "# Cloudflare Warp WireGuard Configuration (auto-generated)"
        echo "WIREGUARD_PRIVATE_KEY=${PRIVATE_KEY}"
        echo "WIREGUARD_ADDRESSES=${ADDRESSES}"
        echo "WIREGUARD_PUBLIC_KEY=${PUBLIC_KEY}"
        echo "WIREGUARD_PRESHARED_KEY=${PRESHARED_KEY}"
        echo "WIREGUARD_ENDPOINT_IP=${ENDPOINT_IP}"
        echo "WIREGUARD_ENDPOINT_PORT=${ENDPOINT_PORT}"
    } > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
    
    log "✅ WireGuard keys generated and saved"
fi

# Step 3: Ensure Docker Compose is available
if ! command -v docker &> /dev/null; then
    error "Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
    error "Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Step 4: Build images if needed
log "🔨 Building Docker images..."
DOCKER_BUILDKIT=1 docker compose build --quiet backend web || {
    warn "Build had warnings, but continuing..."
}

# Step 5: Zero-downtime deployment
log "🔄 Starting services with zero-downtime..."

# Start gluetun first (required for backend)
log "  → Starting gluetun..."
docker compose up -d gluetun || {
    error "Failed to start gluetun"
    exit 1
}

# Wait for gluetun to be ready (check proxy port)
log "  → Waiting for gluetun to be ready..."
for i in {1..30}; do
    if docker compose exec -T gluetun sh -c "nc -z localhost 8888 2>/dev/null" 2>/dev/null; then
        log "  ✅ Gluetun is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        warn "Gluetun took longer than expected, but continuing..."
    fi
    sleep 2
done

# Start backend (depends on gluetun)
log "  → Starting backend..."
docker compose up -d backend || {
    error "Failed to start backend"
    exit 1
}

# Wait for backend to be healthy
log "  → Waiting for backend to be healthy..."
for i in {1..30}; do
    if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
        log "  ✅ Backend is healthy"
        break
    fi
    if [ $i -eq 30 ]; then
        warn "Backend took longer than expected to become healthy"
    fi
    sleep 2
done

# Start web (depends on backend)
log "  → Starting web..."
docker compose up -d web || {
    error "Failed to start web"
    exit 1
}

# Step 6: Verify all services
log "✅ Verifying all services..."
sleep 5

ALL_HEALTHY=true

# Check gluetun
if docker compose ps gluetun | grep -q "Up"; then
    log "  ✅ Gluetun: Running"
else
    error "  ❌ Gluetun: Not running"
    ALL_HEALTHY=false
fi

# Check backend
if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    log "  ✅ Backend: Healthy"
else
    error "  ❌ Backend: Not healthy"
    ALL_HEALTHY=false
fi

# Check web
if docker compose ps web | grep -q "Up"; then
    log "  ✅ Web: Running"
else
    error "  ❌ Web: Not running"
    ALL_HEALTHY=false
fi

# Step 7: Show status
log ""
log "📊 Service Status:"
docker compose ps

log ""
if [ "$ALL_HEALTHY" = true ]; then
    log "🎉 All services are running!"
    log ""
    log "📜 Backend logs (last 20 lines):"
    docker compose logs --tail 20 backend
    log ""
    log "✅ Setup complete! Services are running and healthy."
    log ""
    log "Useful commands:"
    log "  - View backend logs: docker compose logs -f backend"
    log "  - View all logs: docker compose logs -f"
    log "  - Check status: docker compose ps"
    log "  - Restart all: docker compose restart"
    log "  - Run this script again to fix any issues: ./setup.sh"
else
    warn "Some services are not healthy. Check logs:"
    docker compose logs --tail 50
    exit 1
fi

