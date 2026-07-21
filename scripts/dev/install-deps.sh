#!/usr/bin/env bash
#
# Neuro OJ 前置依赖检测与安装脚本
#
# - zip / unzip(必需,build-packages 调用系统 zip)
# - Deno(noj-core / noj-ui 运行时)
# - Rust(noj-judge 编译)
# - Docker(基础设施 + noj-judge 沙箱)
#
# 使用: bash scripts/dev/install-deps.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 颜色输出
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

print_section() {
  printf "\n${GREEN}━━━ %s ━━━${RESET}\n" "$*"
}

# ── 检测系统 ─────────────────────────────────────────────────
detect_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="$ID"
  elif [[ "$(uname)" == "Darwin" ]]; then
    OS_ID="macos"
  else
    OS_ID="unknown"
  fi
}

# ── zip / unzip ──────────────────────────────────────────────
check_zip() {
  print_section "检查 zip / unzip"
  if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
    ok "zip $(zip -v 2>&1 | head -2 | tail -1 | awk '{print $2}')"
    ok "unzip $(unzip -v 2>&1 | head -1 | awk '{print $2}')"
    return 0
  fi
  warn "zip / unzip 未安装"
  if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
    warn "尝试自动安装(需要 sudo)..."
    sudo apt update && sudo apt install -y zip unzip
  elif [[ "$OS_ID" == "macos" ]]; then
    warn "请运行: brew install zip"
  else
    fail "请手动安装 zip / unzip"
    return 1
  fi
}

# ── Deno ─────────────────────────────────────────────────────
check_deno() {
  print_section "检查 Deno"
  if command -v deno >/dev/null 2>&1; then
    ok "deno $(deno --version | head -1 | awk '{print $2}')"
    return 0
  fi
  warn "Deno 未安装"
  warn "安装方法: curl -fsSL https://deno.land/install.sh | sh"
  warn "安装后需将 ~/.deno/bin 加入 PATH"
  return 1
}

# ── Rust ─────────────────────────────────────────────────────
check_rust() {
  print_section "检查 Rust"
  if command -v cargo >/dev/null 2>&1; then
    ok "cargo $(cargo --version | awk '{print $2}')"
    ok "rustc $(rustc --version | awk '{print $2}')"
    return 0
  fi
  warn "Rust 未安装"
  warn "安装方法: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  return 1
}

# ── Docker ───────────────────────────────────────────────────
check_docker() {
  print_section "检查 Docker"
  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker 未安装"
    warn "安装方法: https://docs.docker.com/engine/install/"
    return 1
  fi
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"

  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon 未运行"
    warn "请启动 Docker Desktop 或运行: sudo systemctl start docker"
    return 1
  fi
  ok "Docker daemon 运行中"

  if command -v docker compose >/dev/null 2>&1; then
    ok "docker compose 可用"
  elif command -v docker-compose >/dev/null 2>&1; then
    warn "检测到 docker-compose(v1),推荐升级到 v2 plugin"
  else
    fail "docker compose 不可用"
    return 1
  fi
}

# ── 主流程 ───────────────────────────────────────────────────
main() {
  detect_os
  echo "系统: $OS_ID"
  echo "仓库: $REPO_ROOT"

  local exit_code=0
  check_zip      || exit_code=1
  check_deno     || exit_code=1
  check_rust     || exit_code=1
  check_docker   || exit_code=1

  echo ""
  if [[ $exit_code -eq 0 ]]; then
    ok "所有依赖已就绪"
  else
    warn "部分依赖缺失,运行脚本顶部的提示进行安装后重新运行此脚本验证"
  fi
  return $exit_code
}

main "$@"