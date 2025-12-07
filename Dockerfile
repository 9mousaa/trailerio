# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies with cache mount (faster rebuilds)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit

# Copy source code (excluding what's in .dockerignore)
COPY . .

# Build the application
RUN npm run build

# Verify build output
RUN ls -la /app/dist && test -f /app/dist/index.html || (echo "Build failed: index.html not found" && exit 1)

# Production stage
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

