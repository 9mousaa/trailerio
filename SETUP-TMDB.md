# Setting Up TMDB API Key

## Your TMDB API Key
```
bfe73358661a995b992ae9a812aa0d2f
```

## Setup on Your VPS

### Option 1: Using .env file (Recommended)

```bash
cd /opt/trailerio

# Create .env file with your TMDB API key
cat > .env <<EOF
TMDB_API_KEY=bfe73358661a995b992ae9a812aa0d2f
EOF

# Verify it was created
cat .env

# Rebuild and restart
docker compose up -d --build
```

### Option 2: Using Environment Variable

```bash
cd /opt/trailerio

# Set as environment variable
export TMDB_API_KEY=bfe73358661a995b992ae9a812aa0d2f

# Rebuild and restart
docker compose up -d --build
```

### Option 3: Edit docker-compose.yml directly

Edit `/opt/trailerio/docker-compose.yml` and update the backend service:

```yaml
backend:
  environment:
    - TMDB_API_KEY=bfe73358661a995b992ae9a812aa0d2f
```

Then:
```bash
docker compose up -d --build
```

## Verify It's Working

```bash
# Check backend logs
docker compose logs backend | grep -i tmdb

# Test the API
curl http://localhost:3001/health

# Test a stream request (should work now)
curl "http://localhost:3001/stream/movie/tt0111161.json"
```

## Security Note

⚠️ **Never commit your .env file to git!** It's already in .gitignore, so you're safe.

## Troubleshooting

If the backend shows "TMDB_API_KEY not set":
1. Check `.env` file exists: `cat /opt/trailerio/.env`
2. Check docker-compose is reading it: `docker compose config | grep TMDB`
3. Restart backend: `docker compose restart backend`

