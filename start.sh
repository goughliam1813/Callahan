#!/usr/bin/env bash
# Callahan CI — startup script
# Usage: ./start.sh [auto|docker|dev]

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; ORANGE='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${ORANGE}⚠${NC}  $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

# Always run from the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${ORANGE}🔥 Callahan CI${NC}"
echo "────────────────────────────────"
echo -e "  ${BLUE}Root:${NC} $SCRIPT_DIR"
echo ""

MODE="${1:-auto}"

# ── Detect tools ──────────────────────────────────────────────────────────────
HAS_DOCKER=false; HAS_GO=false; HAS_NODE=false

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  HAS_DOCKER=true; ok "Docker is running"
elif command -v docker &>/dev/null; then
  warn "Docker installed but not running → open Docker Desktop first"
fi
command -v go &>/dev/null && HAS_GO=true && ok "Go $(go version | awk '{print $3}')"
command -v node &>/dev/null && HAS_NODE=true && ok "Node.js $(node --version)"
echo ""

# ── Verify repo structure ─────────────────────────────────────────────────────
check_structure() {
  if [ ! -f "$SCRIPT_DIR/backend/go.mod" ]; then
    err "Cannot find backend/go.mod in $SCRIPT_DIR"
    echo "  Make sure you're running from the callahan/ project root."
    exit 1
  fi
}

# ── Docker mode ───────────────────────────────────────────────────────────────
run_docker() {
  check_structure
  [ ! -f .env ] && cp .env.example .env && warn "Created .env — add ANTHROPIC_API_KEY for AI features"
  log "Building image (first run ~2-3 min)..."
  docker compose build
  docker compose up -d
  log "Waiting for startup..."
  for i in {1..30}; do
    curl -sf http://localhost:8080/health &>/dev/null && break
    printf "."; sleep 2
  done
  echo ""
  ok "Running at http://localhost:8080"
  echo "  docker compose logs -f   # logs"
  echo "  docker compose down      # stop"
}

# ── Dev mode ──────────────────────────────────────────────────────────────────
run_dev() {
  check_structure
  $HAS_GO || { err "Go required for dev mode. https://go.dev/dl/"; exit 1; }

  [ -f .env ] && set -a && source .env && set +a

  export PORT="${PORT:-8080}"
  export DB_PATH="${DB_PATH:-$SCRIPT_DIR/callahan-dev.db}"
  export DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}"
  export DEV_MODE="true"
  mkdir -p "$DATA_DIR"

  log "Starting Go backend on :$PORT ..."
  cd "$SCRIPT_DIR/backend"
  go mod download -x 2>&1 | tail -1
  go run ./cmd/callahan &
  BACKEND_PID=$!
  cd "$SCRIPT_DIR"

  FRONTEND_PID=""
  if $HAS_NODE && [ -d frontend ]; then
    log "Starting Next.js on :3000 ..."
    cd frontend
    [ ! -d node_modules ] && npm install --silent
    NEXT_PUBLIC_API_URL="http://localhost:${PORT}/api/v1" npm run dev -- --port 3000 &
    FRONTEND_PID=$!
    cd "$SCRIPT_DIR"
  fi

  cleanup() { echo ""; log "Stopping..."; kill $BACKEND_PID 2>/dev/null; [ -n "$FRONTEND_PID" ] && kill $FRONTEND_PID 2>/dev/null; }
  trap cleanup EXIT INT TERM

  log "Waiting for backend..."
  for i in {1..25}; do curl -sf "http://localhost:${PORT}/health" &>/dev/null && break; sleep 1; done

  echo ""
  ok "Callahan CI is running!"
  $HAS_NODE && echo -e "  ${GREEN}UI:${NC}   http://localhost:3000"
  echo -e "  ${GREEN}API:${NC}  http://localhost:${PORT}/api/v1/stats"
  [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && warn "No LLM key set. Add ANTHROPIC_API_KEY to .env for AI features."
  echo ""
  echo "Ctrl+C to stop"
  wait $BACKEND_PID
}

# ── Route ─────────────────────────────────────────────────────────────────────
case "$MODE" in
  docker)
    $HAS_DOCKER || { err "Docker not running. Start Docker Desktop then retry."; exit 1; }
    run_docker ;;
  dev) run_dev ;;
  auto)
    if $HAS_DOCKER; then run_docker
    elif $HAS_GO; then warn "Docker unavailable, using dev mode"; run_dev
    else err "Need Docker Desktop or Go 1.22+. https://go.dev/dl/"; exit 1; fi ;;
  *) echo "Usage: ./start.sh [auto|docker|dev]"; exit 1 ;;
esac
