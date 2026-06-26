# ============================================================
# WAUN — Multi-Account WhatsApp Gateway
# Dockerfile untuk Baileys (default) — tanpa Chrome.
# Image size: ~200 MB
#
# Untuk whatsapp-web.js (WA_LIBRARY=wwebjs):
# Tambahkan Chrome installation + npm install tanpa --no-optional
# ============================================================

# ============================================================
# Stage 1: Build — install npm dependencies
# ============================================================
FROM node:22-slim AS build

WORKDIR /app

# Copy package.json dan lockfile — optimalisasi Docker cache
COPY package.json package-lock.json ./

# Install dependencies, skip optional (whatsapp-web.js)
# Karena default library adalah Baileys (tanpa Chrome)
RUN npm ci --only=production --no-optional

# ============================================================
# Stage 2: Production — final image
# ============================================================
FROM node:22-slim AS production

ENV NODE_ENV=production

# Install runtime libraries — minimal, hanya yang dibutuhin Node
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules dari stage build
COPY --from=build /app/node_modules ./node_modules

# Copy source code
COPY src/ ./src/
COPY package.json ./

# Buat folder data, sessions, logs, dan storage (temp upload)
RUN mkdir -p /app/data /app/sessions /app/logs /app/storage/temp && \
    chown -R node:node /app/data /app/sessions /app/logs /app/storage

# Gunakan non-root user
USER node

# Volume mount point
VOLUME [ "/app/data", "/app/sessions", "/app/logs", "/app/storage" ]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3008/health || exit 1

EXPOSE 3008

CMD ["node", "src/index.js"]
