# Trailerio - Bulletproof Self-Healing Setup

## One-Command Setup

```bash
cd /opt/trailerio
./setup.sh
```

That's it! The script will:
- ✅ Auto-generate WireGuard keys if missing
- ✅ Build Docker images
- ✅ Start all services with zero-downtime
- ✅ Verify everything is healthy
- ✅ Show backend logs

## Self-Healing (Optional but Recommended)

Run the monitor script to keep services running automatically:

```bash
# Run in background
nohup ./monitor.sh > /dev/null 2>&1 &

# Or as a systemd service (recommended)
sudo tee /etc/systemd/system/trailerio-monitor.service > /dev/null << EOF
[Unit]
Description=Trailerio Self-Healing Monitor
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/trailerio
ExecStart=/opt/trailerio/monitor.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable trailerio-monitor
sudo systemctl start trailerio-monitor
```

## Troubleshooting

If something breaks, just run the setup script again:

```bash
./setup.sh
```

It will automatically:
- Fix missing WireGuard keys
- Rebuild images if needed
- Restart services
- Verify everything is working

## View Logs

```bash
# Backend logs (most important)
docker compose logs -f backend

# All logs
docker compose logs -f

# Specific service
docker compose logs -f gluetun
```

## Manual Commands

```bash
# Check status
docker compose ps

# Restart all services
docker compose restart

# Restart specific service
docker compose restart backend

# Rebuild and restart
./setup.sh
```

## Features

- **Zero-downtime**: Services are started gracefully
- **Self-healing**: Monitor script keeps everything running
- **Auto-repair**: Setup script fixes common issues
- **Always running**: `restart: unless-stopped` ensures services restart on failure
- **Health checks**: All services have health checks
- **Dependencies**: Backend waits for gluetun, web waits for backend

## What Gets Set Up

1. **Gluetun** - Cloudflare Warp VPN (required for yt-dlp)
2. **Backend** - API server (depends on gluetun)
3. **Web** - Frontend (depends on backend)

All services are configured to:
- Restart automatically on failure
- Wait for dependencies
- Health check themselves
- Log everything

