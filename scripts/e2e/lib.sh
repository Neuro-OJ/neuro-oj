#!/usr/bin/env bash
# Shared library for e2e test scripts.
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────
export RED='\033[0;31m'
export GREEN='\033[0;32m'
export YELLOW='\033[1;33m'
export BLUE='\033[0;34m'
export CYAN='\033[0;36m'
export BOLD='\033[1m'
export NC='\033[0m' # No Color

# ── ROOT_DIR (project root, 3 levels up from scripts/e2e/) ─────────
export ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Helper functions ────────────────────────────────────────────────
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

step() {
  echo ""
  echo -e "${BOLD}${BLUE}━━━ $1 ━━━${NC}"
}

header() {
  echo ""
  echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"
  echo ""
}
