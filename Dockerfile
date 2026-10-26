# -------------------------------------------------------------
# Stage 1: Build the React Frontend
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend ./
RUN npm run build

# -------------------------------------------------------------
# Stage 2: Build the NestJS Backend
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm install

COPY backend ./
RUN npm run build

# -------------------------------------------------------------
# Stage 3: Production Runtime (Node + yt-dlp + ffmpeg)
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app/backend

# Install system dependencies: python3, ffmpeg, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install latest official yt-dlp executable
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# Verify binaries exist and are functional
RUN yt-dlp --version && ffmpeg -version

# Copy backend dependencies
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy compiled backend
COPY --from=backend-builder /app/backend/dist ./dist

# Copy built frontend so NestJS serves it directly as a unified service
COPY --from=frontend-builder /app/frontend/dist ./client

# Create storage directory for downloads
RUN mkdir -p ./downloads && chmod 777 ./downloads

# Default Render environment
ENV NODE_ENV=production
ENV PORT=10000
ENV DOWNLOAD_FORMAT=mp4
ENV DOWNLOAD_QUALITY=best
ENV DOWNLOAD_STORAGE_DIR=./downloads

EXPOSE 10000

CMD ["node", "dist/main.js"]
