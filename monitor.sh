#!/bin/bash
# Self-healing monitor script - keeps services running
# Run this in background or as a systemd service

set -e

PROJECT_DIR="${1:-/opt/trailerio}"
LOG_FILE="${PROJECT_DIR}/monitor.log"
CHECK_INTERVAL=60  # Check every 60 seconds

cd "${PROJECT_DIR}" || exit 1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

check_and_restart() {
    local service=$1
    local health_url=$2
    
    # Check if service is running
    if ! docker compose ps "$service" | grep -q "Up"; then
        log "⚠️  $service is not running, restarting..."
        docker compose up -d "$service"
        sleep 10
        return
    fi
    
    # If health URL provided, check it
    if [ -n "$health_url" ]; then
        if ! curl -sf "$health_url" > /dev/null 2>&1; then
            log "⚠️  $service health check failed, restarting..."
            docker compose restart "$service"
            sleep 10
        fi
    fi
}

log "🔍 Starting self-healing monitor..."

while true; do
    # Check gluetun
    if ! docker compose exec -T gluetun sh -c "nc -z localhost 8888 2>/dev/null" 2>/dev/null; then
        log "⚠️  Gluetun proxy not responding, restarting..."
        docker compose restart gluetun
        sleep 15
    fi
    
    # Check backend
    check_and_restart "backend" "http://localhost:3001/health"
    
    # Check web
    check_and_restart "web" ""
    
    sleep "$CHECK_INTERVAL"
done

