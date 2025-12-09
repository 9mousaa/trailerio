# Quick Cloudflare Warp Setup

## One Command Setup

Run this on your VPS to automatically configure everything:

```bash
cd /opt/trailerio && bash <(curl -fsSL https://raw.githubusercontent.com/9mousaa/trailerio/main/setup-warp-oneliner.sh) /opt/trailerio && docker compose up -d --build
```

This will:
1. ✅ Install wgcf
2. ✅ Register with Cloudflare Warp
3. ✅ Generate WireGuard keys
4. ✅ Update your .env file
5. ✅ Rebuild and restart services

## Verify It's Working

Check if gluetun is running and using Cloudflare IP:

```bash
docker compose logs gluetun | tail -20
docker compose exec gluetun wget -qO- https://ipinfo.io
```

You should see a Cloudflare IP address.

## Test yt-dlp

Check backend logs to see if yt-dlp is working:

```bash
docker compose logs backend -f
```

Look for `[yt-dlp]` in the logs when trailers are requested.

## Troubleshooting

**Gluetun won't start:**
- Check `.env` file has all WireGuard keys: `grep WIREGUARD /opt/trailerio/.env`
- Check gluetun logs: `docker compose logs gluetun`

**yt-dlp not using proxy:**
- Verify `GLUETUN_HTTP_PROXY` is set: `grep GLUETUN_HTTP_PROXY /opt/trailerio/.env`
- Check backend can reach gluetun: `docker compose exec backend wget -qO- http://gluetun:8000/v1/openvpn/status`

**Everything works without gluetun:**
- That's fine! yt-dlp will work without Cloudflare Warp, just may be more prone to blocking
- Gluetun is optional - backend works fine without it

