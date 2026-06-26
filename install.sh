#!/usr/bin/env bash
set -euo pipefail

echo "=== PDS WA Unofficial — Install ==="

# Copy env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it before running"
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Create directories
mkdir -p sessions logs storage

echo ""
echo "=== Done ==="
echo ""
echo "Quick start:"
echo "  1. Edit .env with your settings"
echo "  2. Run: node src/qr-cli.js    (scan QR to authenticate)"
echo "  3. Run: node src/index.js     (start server)"
echo ""
echo "Or with PM2:"
echo "  npm run pm2"
