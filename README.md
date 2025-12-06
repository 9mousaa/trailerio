# Trailer Preview - Stremio Add-on

A Stremio add-on for watching trailers and previews. Automatically finds matching trailers using TMDB metadata and extracts video URLs via Piped/Invidious.

## Technologies

- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **React** - UI framework
- **Express** - Backend API server (standalone)
- **Docker** - Containerization

## Local Development

### Prerequisites

- Node.js 20+ and npm

### Setup

```sh
# Install dependencies
npm install
cd server && npm install && cd ..

# Start backend (in one terminal)
cd server && npm start

# Start frontend (in another terminal)
npm run dev
```

The frontend will be available at `http://localhost:8080` and backend at `http://localhost:3001`

## Deployment

### Prerequisites

- Docker and Docker Compose
- Git
- Traefik (or Nginx) for reverse proxy

### Environment Variables

Create a `.env` file in the project root:

```bash
TMDB_API_KEY=your_tmdb_api_key_here

# Optional: Proxy configuration for yt-dlp to avoid YouTube blocking
# Single proxy:
# YT_DLP_PROXIES=http://proxy.example.com:8080

# Multiple proxies (rotated automatically):
# YT_DLP_PROXIES=http://proxy1.com:8080,http://proxy2.com:8080,socks5://proxy3.com:1080

# Supported formats:
# - HTTP: http://proxy:port
# - HTTPS: https://proxy:port
# - SOCKS5: socks5://proxy:port
# - With auth: http://user:pass@proxy:port
```

### Quick Deploy

1. **Clone repository:**
   ```bash
   cd /opt
   git clone https://github.com/your-username/trailerio.git
   cd trailerio
   ```

2. **Create `.env` file:**
   ```bash
   echo "TMDB_API_KEY=your_tmdb_api_key_here" > .env
   # Optional: Add proxy configuration
   # echo "YT_DLP_PROXIES=http://proxy1.com:8080,http://proxy2.com:8080" >> .env
   ```

3. **Update `docker-compose.yml`:**
   - Update the domain in Traefik labels
   - Update the network name to match your Traefik setup

4. **Deploy:**
   ```bash
   docker compose up -d --build
   ```

### Update

```bash
cd /opt/trailerio
git pull
docker compose up -d --build
```

## Environment Variables

Create a `.env` file in the project root:

```bash
TMDB_API_KEY=your_tmdb_api_key_here

# Optional: Proxy configuration for yt-dlp to avoid YouTube blocking
# Single proxy:
# YT_DLP_PROXIES=http://proxy.example.com:8080

# Multiple proxies (rotated automatically):
# YT_DLP_PROXIES=http://proxy1.com:8080,http://proxy2.com:8080,socks5://proxy3.com:1080

# Supported formats:
# - HTTP: http://proxy:port
# - HTTPS: https://proxy:port
# - SOCKS5: socks5://proxy:port
# - With auth: http://user:pass@proxy:port
```

## Project Structure

```
trailerio/
├── src/              # Frontend React app
├── server/           # Express backend API
├── Dockerfile        # Frontend Docker build
├── Dockerfile.backend # Backend Docker build
├── docker-compose.yml # Docker Compose config
└── nginx.conf        # Nginx config for frontend
```

## How It Works

1. User provides IMDB ID (e.g., `tt0111161`)
2. Backend fetches metadata from TMDB
3. Searches iTunes for previews (multi-country search)
4. Falls back to YouTube trailer extraction if no iTunes match
5. Returns video URL for Stremio playback
