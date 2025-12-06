# Trailer Preview - Stremio Add-on

A React application for watching trailers and previews directly in Stremio. Automatically finds matching trailers using TMDB metadata.

## Technologies

- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **React** - UI framework
- **shadcn-ui** - UI components
- **Tailwind CSS** - Styling
- **Supabase** - Backend services

## Local Development

### Prerequisites

- Node.js 20+ and npm (or use [nvm](https://github.com/nvm-sh/nvm#installing-and-updating))

### Setup

```sh
# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:8080`

## Deployment to DigitalOcean VPS

### Quick Setup (Recommended)

If you have an existing VPS with multiple apps (like plaio.cc), use the automated setup script:

1. **SSH into your VPS:**
   ```bash
   ssh root@your-vps-ip
   ```

2. **Check your current setup (optional):**
   ```bash
   # Upload check-vps-setup.sh to your VPS first, then:
   chmod +x check-vps-setup.sh
   ./check-vps-setup.sh
   ```

3. **Run the automated setup:**
   ```bash
   # Upload setup-vps.sh to your VPS, then:
   chmod +x setup-vps.sh
   sudo ./setup-vps.sh
   ```

   The script will:
   - Install Docker if needed
   - Clone/update the repository
   - Build and start the container
   - Help configure Nginx (subdomain or path-based)

### Manual Deployment

#### Prerequisites on VPS

- Docker and Docker Compose installed
- Git installed
- Nginx (if you want reverse proxy)

#### Deployment Steps

1. **SSH into your VPS:**
   ```bash
   ssh root@your-vps-ip
   ```

2. **Install Docker (if not already installed):**
   ```bash
   # For Ubuntu/Debian
   curl -fsSL https://get.docker.com -o get-docker.sh
   sh get-docker.sh
   
   # Install Docker Compose
   apt-get install docker-compose-plugin -y
   ```

3. **Clone your repository:**
   ```bash
   cd /opt
   git clone <your-repo-url> trailerio
   cd trailerio
   ```

4. **Build and run with Docker Compose:**
   ```bash
   docker compose up -d --build
   ```

   The app will run on port **8081** (to avoid conflicts with existing nginx on port 80).

5. **Verify the deployment:**
   ```bash
   # Check if container is running
   docker ps
   
   # Check logs
   docker compose logs -f
   ```

### Nginx Configuration Options

Since you have multiple apps on plaio.cc, choose one of these options:

#### Option 1: Subdomain Setup (trailerio.plaio.cc)

1. **Create Nginx config:**
   ```bash
   cp nginx-subdomain.conf /etc/nginx/sites-available/trailerio
   # Edit the file to change server_name if needed
   nano /etc/nginx/sites-available/trailerio
   ```

2. **Enable the site:**
   ```bash
   ln -s /etc/nginx/sites-available/trailerio /etc/nginx/sites-enabled/
   nginx -t
   systemctl reload nginx
   ```

3. **Set up SSL:**
   ```bash
   certbot --nginx -d trailerio.plaio.cc
   ```

#### Option 2: Path-based Setup (plaio.cc/trailerio)

1. **Edit your existing plaio.cc nginx config:**
   ```bash
   nano /etc/nginx/sites-available/plaio.cc  # or your main config
   ```

2. **Add the location block from `nginx-path.conf`** to your existing server block

3. **Reload Nginx:**
   ```bash
   nginx -t
   systemctl reload nginx
   ```

**Note:** For path-based routing, you may need to configure Vite's base path. See "Path-based Routing" section below.

### Path-based Routing (if using /trailerio path)

If you're using path-based routing (plaio.cc/trailerio), you need to configure Vite's base path:

1. **Update `vite.config.ts`:**
   ```typescript
   export default defineConfig({
     base: '/trailerio/',  // Add this line
     // ... rest of config
   });
   ```

2. **Update `src/App.tsx` to use HashRouter or configure BrowserRouter with basename:**
   ```typescript
   <BrowserRouter basename="/trailerio">
     {/* ... */}
   </BrowserRouter>
   ```

3. **Rebuild:**
   ```bash
   docker compose up -d --build
   ```

### Updating the Application

```bash
cd /opt/trailerio  # or wherever you installed it
git pull
docker compose up -d --build
```

### Environment Variables

If you need to set environment variables, create a `.env` file in the project root and update `docker-compose.yml` to include it:

```yaml
services:
  web:
    # ... existing config ...
    env_file:
      - .env
```

### Troubleshooting

- **Check container logs:** `docker compose logs -f`
- **Restart container:** `docker compose restart`
- **Rebuild container:** `docker compose up -d --build`
- **Check if port 80 is available:** `netstat -tulpn | grep :80`

## Project Structure

```
trailerio/
├── src/              # Source code
├── public/           # Static assets
├── supabase/         # Supabase functions and migrations
├── Dockerfile        # Docker build configuration
├── docker-compose.yml # Docker Compose configuration
└── nginx.conf        # Nginx configuration for production
```

## Build Commands

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint
