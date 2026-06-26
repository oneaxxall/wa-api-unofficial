#!/usr/bin/env bash
# ============================================================
# WAUN — Docker Restart Script
# Usage:
#   ./docker-restart.sh          → Rebuild & restart
#   ./docker-restart.sh --quick  → Restart tanpa rebuild
#   ./docker-restart.sh --logs   → Restart + follow logs
#   ./docker-restart.sh --down   → Stop container
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-}" in
  --quick)
    echo "♻️  Restart container (tanpa rebuild)..."
    docker compose restart
    echo "✅ Done"
    ;;
  --logs)
    echo "🔨 Rebuild & restart + follow logs..."
    docker compose down
    docker compose up -d --build
    docker compose logs -f
    ;;
  --down)
    echo "⏹️  Stop container..."
    docker compose down
    echo "✅ Stopped"
    ;;
  *)
    echo "🔨 Rebuild & restart container..."
    docker compose down
    docker compose up -d --build
    echo "✅ Done"
    docker compose ps
    ;;
esac
