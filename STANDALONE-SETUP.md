# Standalone Setup (No Supabase or Lovable)

This project has been updated to work completely standalone on your VPS without any external dependencies except:

- **TMDB API** (free, for movie metadata)
- **Piped/Invidious** (public instances, for YouTube extraction)

## What Changed

✅ **Removed Supabase** - Replaced with standalone Express backend
✅ **Removed Lovable** - All references removed
✅ **Standalone Backend** - Express server with in-memory caching
✅ **No External Services** - Works entirely on your VPS

## Architecture

```
┌─────────────┐
│   Traefik   │ (Reverse Proxy)
└──────┬──────┘
       │
       ├───► Frontend (Nginx + React)
       │     └──► Proxies /api to backend
       │
       └───► Backend (Express API)
             └──► TMDB API
             └──► Piped/Invidious
```

## Setup

### 1. Get TMDB API Key (Free)

1. Go to: https://www.themoviedb.org/settings/api
2. Create an account (free)
3. Request an API key
4. Copy your API key

### 2. Deploy

```bash
cd /opt/trailerio
git pull

# Set TMDB API key
export TMDB_API_KEY=your_api_key_here

# Or create .env file
echo "TMDB_API_KEY=your_api_key_here" > .env

# Update docker-compose.yml to use .env
# Add to backend service:
#   env_file:
#     - .env

# Build and start
docker compose up -d --build
```

### 3. Update docker-compose.yml for Environment Variable

Edit `docker-compose.yml` and add to the backend service:

```yaml
backend:
  # ... existing config ...
  env_file:
    - .env
```

Or set it directly:

```yaml
backend:
  # ... existing config ...
  environment:
    - TMDB_API_KEY=${TMDB_API_KEY}
```

## Environment Variables

Create a `.env` file in the project root:

```bash
TMDB_API_KEY=your_tmdb_api_key_here
```

## How It Works

1. **Frontend** (React app) - Serves the UI
2. **Backend** (Express) - Handles API requests:
   - `/api/manifest.json` - Stremio manifest
   - `/api/stream/:type/:id.json` - Get trailer stream
   - `/api/stats` - Cache statistics
3. **Caching** - In-memory cache (no database needed)
4. **TMDB** - Fetches movie metadata and trailer info
5. **Piped/Invidious** - Extracts YouTube video URLs

## API Endpoints

- `GET /api/manifest.json` - Stremio addon manifest
- `GET /api/stream/:type/:id.json` - Get stream for movie/series
- `GET /api/stats` - Cache statistics
- `GET /api/health` - Health check

## Troubleshooting

### Backend not starting

```bash
# Check logs
docker compose logs backend

# Verify TMDB_API_KEY is set
docker compose exec backend env | grep TMDB
```

### API requests failing

```bash
# Check if backend is running
docker compose ps

# Test backend directly
curl http://localhost:3001/health

# Check nginx proxy
docker compose logs web | grep api
```

### TMDB API errors

- Verify your API key is correct
- Check TMDB API status: https://status.themoviedb.org/
- Free tier has rate limits (40 requests per 10 seconds)

## Update Process

```bash
cd /opt/trailerio
git pull
docker compose up -d --build
```

## No External Dependencies

✅ No Supabase account needed
✅ No Lovable platform needed
✅ No database needed (in-memory cache)
✅ No external services (except free TMDB API)

Everything runs on your VPS!

