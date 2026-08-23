#!/usr/bin/env bash
#
# devtool.sh — Neuro OJ 本地开发编排工具（Linux + macOS）
#
# 整合原 scripts/dev/ 下 12 个独立脚本（install-deps / start-{all,infra,core,ui,judge} /
# stop-{all,infra,core,ui,judge} / status）为单入口，通过子命令分发。
#
# 用法：
#   bash scripts/dev/devtool.sh install-deps [--check-only]
#   bash scripts/dev/devtool.sh init-env     [--merge | --force]
#   bash scripts/dev/devtool.sh start        [TARGET] [--build]
#   bash scripts/dev/devtool.sh stop         [TARGET]
#   bash scripts/dev/devtool.sh status       [--json] [--watch SECS]
#   bash scripts/dev/devtool.sh help
#
# TARGET 取值：infra | core | ui | judge | all（默认 all）
#
# 设计：
#   - 单文件 800 行 bash，避免新工具栈；macOS bash 3.2 兼容（不用 ;& ;;& ** 等）
#   - PID 文件 scripts/dev/logs/<target>.pid（沿用旧脚本约定，向后兼容）
#   - 日志文件 scripts/dev/logs/<target>.log
#   - 同工具防双开：scripts/dev/locks/<target>.lock（mkdir 原子创建）
#   - judge 智能跳过 cargo build（mtime 比较）
#   - init-env 三态：默认拒绝 / --merge 追加缺失 / --force 覆盖
#
# 平台：Linux 原生 + macOS 原生；Windows 用户请使用 WSL2

set -eo pipefail

# ── 版本下限（与各模块 lock 文件 / rust-toolchain.toml 保持一致） ─
# Deno: 2.x 起有 jsr 协议 + byonm，本项目依赖
DENO_MIN_VERSION="2.0.0"
# Rust: 1.80 起是 msrv baseline，noj-judge 用 edition 2021 + 依赖项要求
RUST_MIN_VERSION="1.80.0"

# version_at_least ACTUAL MIN  → 0 满足 / 1 不满足（semver 三段比较）
version_at_least() {
  local actual="$1" min="$2"
  local a_major a_minor a_patch m_major m_minor m_patch
  IFS='.' read -r a_major a_minor a_patch <<<"${actual%%-*}"
  IFS='.' read -r m_major m_minor m_patch <<<"${min%%-*}"
  : "${a_patch:=0}"; : "${m_patch:=0}"
  if ((a_major > m_major)); then return 0; fi
  if ((a_major < m_major)); then return 1; fi
  if ((a_minor > m_minor)); then return 0; fi
  if ((a_minor < m_minor)); then return 1; fi
  if ((a_patch >= m_patch)); then return 0; fi
  return 1
}

# ── 路径常量 ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOCK_DIR="$SCRIPT_DIR/locks"
ENV_TEMPLATE="$SCRIPT_DIR/env.example"
ENV_TARGET="$REPO_ROOT/noj-core/.env"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
NOJ_CORE_DIR="$REPO_ROOT/noj-core"
NOJ_UI_DIR="$REPO_ROOT/noj-ui"
NOJ_JUDGE_DIR="$REPO_ROOT/noj-judge"

mkdir -p "$LOG_DIR" "$LOCK_DIR"

# ── 颜色（仅 TTY） ──────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
  DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; DIM=''; BOLD=''; RESET=''
fi

# ── 输出工具 ────────────────────────────────────────────────────
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
down()  { printf "${RED}●${RESET} %s\n" "$*"; }
section() { printf "\n${GREEN}━━━ %s ━━━${RESET}\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }

# ── 端口（与 docker-compose / nuxt.config 保持一致） ──────────────
PORT_CORE=8000
PORT_UI=3000

# ── OS 检测 ─────────────────────────────────────────────────────
detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "$ID" in
      ubuntu|debian) OS_ID="debian" ;;
      fedora|rhel|centos|rocky|almalinux) OS_ID="fedora" ;;
      arch|manjaro) OS_ID="arch" ;;
      *) OS_ID="$ID" ;;
    esac
  elif [[ "$(uname)" == "Darwin" ]]; then
    OS_ID="macos"
  else
    OS_ID="unknown"
  fi
}

# ── 进程与端口工具 ──────────────────────────────────────────────
# is_pid_alive PID  → 0 存活 / 1 不存在
is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# read_pid TARGET  →  echo 存活 PID 或空
read_pid() {
  local pid_file="$LOG_DIR/$1.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null)"
    if is_pid_alive "$pid"; then
      echo "$pid"
      return 0
    fi
  fi
  echo ""
}

# wait_http URL SECS  → 0 就绪 / 1 超时（curl）
wait_http() {
  local url="$1" secs="$2" i
  for ((i=1; i<=secs; i++)); do
    # --max-time：目标端口半开（LISTEN 但不响应 HTTP）时避免无限卡死（issue #188）
    if curl -fsS --max-time 3 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# wait_port PORT SECS  → 0 端口监听 / 1 超时（nc 或 curl）
wait_port() {
  local port="$1" secs="$2" i
  for ((i=1; i<=secs; i++)); do
    # --max-time / -w：端口已 LISTEN 但 HTTP 不响应（半开状态）时，
    # 每个探测尝试限时 3s，由外层轮询计数真正控制总超时（issue #188）
    if curl -fsS --max-time 3 -o /dev/null "http://localhost:$port/" 2>/dev/null \
       || (command -v nc >/dev/null 2>&1 && nc -z -w 3 localhost "$port" 2>/dev/null); then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ── Lock 管理（同工具防双开） ────────────────────────────────────
# 用 mkdir 原子性实现 advisory lock：mkdir 失败说明已锁定
acquire_lock() {
  local target="$1"
  if ! mkdir "$LOCK_DIR/$target.lock" 2>/dev/null; then
    if [[ -d "$LOCK_DIR/$target.lock" ]]; then
      # 陈旧锁回收（issue #188）：devtool 被强杀（SIGKILL）时 trap 不执行，
      # 遗留的 lock 目录会让后续启动永远报"占用"；持有者 PID 已退出则回收。
      local holder
      holder="$(cat "$LOCK_DIR/$target.lock/pid" 2>/dev/null)"
      if [[ -n "$holder" ]] && is_pid_alive "$holder"; then
        fail "$target 正在被另一个 devtool.sh 操作占用（lock: $LOCK_DIR/$target.lock）"
      fi
      echo "  清理陈旧锁: $LOCK_DIR/$target.lock（持有者 PID ${holder:-未知} 已退出）"
      rm -rf "$LOCK_DIR/$target.lock" 2>/dev/null || true
      if ! mkdir "$LOCK_DIR/$target.lock" 2>/dev/null; then
        fail "无法创建 lock: $LOCK_DIR/$target.lock"
      fi
    else
      fail "无法创建 lock: $LOCK_DIR/$target.lock"
    fi
  fi
  # lock 持有者 PID 写入，便于排查
  echo "$$" >"$LOCK_DIR/$target.lock/pid"
}

release_lock() {
  local target="$1"
  rm -rf "$LOCK_DIR/$target.lock" 2>/dev/null || true
}

# trap 异常时自动释放所有锁
ALL_LOCKS=()
on_exit() {
  local lock
  for lock in "${ALL_LOCKS[@]:-}"; do
    rm -rf "$LOCK_DIR/$lock.lock" 2>/dev/null || true
  done
}
trap on_exit EXIT INT TERM

# ── TARGET 解析（展开 all → 列表） ──────────────────────────────
TARGETS_ALL=("infra" "core" "ui" "judge")
START_ORDER=("${TARGETS_ALL[@]}")
STOP_ORDER=("judge" "ui" "core" "infra")

# validate_target TARGET  → 0 合法 / 1 非法
validate_target() {
  local t="$1"
  case "$t" in
    infra|core|ui|judge|all) return 0 ;;
    *) return 1 ;;
  esac
}

# expand_target TARGET_OR_ALL  → echo 空格分隔的目标列表
expand_target() {
  local t="$1"
  if [[ "$t" == "all" ]]; then
    echo "${TARGETS_ALL[*]}"
  else
    echo "$t"
  fi
}

# ══════════════════════════════════════════════════════════════════
#  install-deps — 检测 + 安装前置依赖
# ══════════════════════════════════════════════════════════════════
check_zip() {
  local check_only="${1:-no}"
  section "检查 zip / unzip"
  if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
    ok "zip $(zip -v 2>&1 | head -2 | tail -1 | awk '{print $2}')"
    ok "unzip $(unzip -v 2>&1 | head -1 | awk '{print $2}')"
    return 0
  fi
  if [[ "$check_only" == "yes" ]]; then
    warn "zip / unzip 未安装（--check-only 模式跳过自动安装）"
    return 1
  fi
  warn "zip / unzip 未安装，尝试自动安装..."
  case "$OS_ID" in
    debian)
      sudo apt update && sudo apt install -y zip unzip || return 1
      ;;
    fedora)
      sudo dnf install -y zip unzip || return 1
      ;;
    arch)
      sudo pacman -S --noconfirm zip unzip || return 1
      ;;
    macos)
      if command -v brew >/dev/null 2>&1; then
        brew install zip || return 1
      else
        warn "请运行: brew install zip"
        return 1
      fi
      ;;
    *)
      warn "请手动安装 zip / unzip"
      return 1
      ;;
  esac
  ok "zip / unzip 已安装"
}

check_deno() {
  section "检查 Deno"
  if command -v deno >/dev/null 2>&1; then
    local v
    v="$(deno --version | head -1 | awk '{print $2}')"
    ok "deno $v"
    # Deno 2.x 起才有 JSR 协议、unstable-byonm 等本项目依赖特性
    if ! version_at_least "$v" "$DENO_MIN_VERSION"; then
      warn "Deno 版本 $v 低于最低要求 $DENO_MIN_VERSION（jsr 协议 + byonm 要求 2.x）"
      return 1
    fi
    return 0
  fi
  warn "Deno 未安装（noj-core / noj-ui 运行时）"
  warn "安装: curl -fsSL https://deno.land/install.sh | sh"
  warn "安装后需将 ~/.deno/bin 加入 PATH"
  return 1
}

check_rust() {
  section "检查 Rust"
  if command -v cargo >/dev/null 2>&1; then
    local v
    v="$(cargo --version | awk '{print $2}')"
    ok "cargo $v"
    ok "rustc $(rustc --version | awk '{print $2}')"
    # Rust 1.80 起是本项目依赖的 msrv baseline
    if ! version_at_least "$v" "$RUST_MIN_VERSION"; then
      warn "Rust $v 低于最低要求 $RUST_MIN_VERSION"
      return 1
    fi
    return 0
  fi
  warn "Rust 未安装（noj-judge 编译工具链）"
  warn "安装: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  warn "  然后在 noj-judge/ 下跑一次 cargo build 让 rust-toolchain.toml 自动拉取指定版本"
  return 1
}

check_docker() {
  section "检查 Docker"
  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker 未安装（基础设施 + noj-judge 沙箱均依赖）"
  fi
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"

  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon 未运行"
  fi
  ok "Docker daemon 运行中"

  if command -v docker compose >/dev/null 2>&1; then
    ok "docker compose 可用"
  elif command -v docker-compose >/dev/null 2>&1; then
    warn "检测到 docker-compose v1，推荐升级到 v2 plugin"
  else
    fail "docker compose 不可用"
  fi
}

cmd_install_deps() {
  local check_only="no"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check-only) check_only="yes"; shift ;;
      *) fail "未知参数: $1" ;;
    esac
  done

  detect_os
  echo "系统: $OS_ID"
  echo "仓库: $REPO_ROOT"
  [[ "$check_only" == "yes" ]] && echo "模式: --check-only（只检测不安装）"

  local exit_code=0
  check_zip    "$check_only" || exit_code=1
  check_deno                    || exit_code=1
  check_rust                    || exit_code=1
  check_docker                  || exit_code=1

  echo ""
  if [[ $exit_code -eq 0 ]]; then
    ok "所有依赖已就绪"
  else
    warn "部分依赖缺失，按上方提示安装后重新运行 devtool.sh install-deps 验证"
  fi
  return $exit_code
}

# ══════════════════════════════════════════════════════════════════
#  bootstrap — 创建/引导管理员（开发环境默认不强制首次改密）
# ══════════════════════════════════════════════════════════════════
# devtool 托管的开发流程默认 NOJ_FORCE_PASSWORD_CHANGE=false：
# 管理员首次登录即可使用完整功能，无需强制改密（issue #75 守卫仅在生产保留）。
cmd_bootstrap_admin() {
  local email="" password=""
  # 兼容 `devtool.sh bootstrap admin [--email ...]` 写法
  if [[ "$1" == "admin" ]]; then
    shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email) email="$2"; shift 2 ;;
      --password) password="$2"; shift 2 ;;
      *) fail "未知参数: $1（用法: devtool.sh bootstrap admin [--email X --password Y]）" ;;
    esac
  done

  if [[ ! -f "$ENV_TARGET" ]]; then
    fail "$ENV_TARGET 不存在，请先运行: devtool.sh init-env"
  fi

  echo ">>> 创建/引导管理员（开发模式：NOJ_FORCE_PASSWORD_CHANGE=false）..."
  local args=("task" "bootstrap:admin")
  [[ -n "$email" ]] && args+=(--email "$email")
  [[ -n "$password" ]] && args+=(--password "$password")
  (cd "$NOJ_CORE_DIR" && NOJ_FORCE_PASSWORD_CHANGE=false deno "${args[@]}")
}

# ══════════════════════════════════════════════════════════════════
#  init-env — 初始化 / 合并 noj-core/.env
# ══════════════════════════════════════════════════════════════════
# 解析 env 文件为 KEY=VALUE 对（忽略注释 / 空行），输出到 stdout
parse_env_keys() {
  local file="$1"
  [[ ! -f "$file" ]] && return 0
  # 提取 KEY= 开头的行（去掉 export 前缀与值）
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*export[[:space:]]+/ { sub(/^[[:space:]]*export[[:space:]]+/, "") }
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/ {
      sub(/^[[:space:]]*/, "")
      split($0, kv, "=")
      print kv[1]
    }
  ' "$file"
}

cmd_init_env() {
  local mode="refuse"  # refuse | merge | force
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --merge) mode="merge"; shift ;;
      --force) mode="force"; shift ;;
      *) fail "未知参数: $1（可用 --merge / --force）" ;;
    esac
  done

  if [[ ! -f "$ENV_TEMPLATE" ]]; then
    fail "模板文件不存在: $ENV_TEMPLATE"
  fi

  if [[ ! -f "$ENV_TARGET" ]]; then
    # .env 不存在 → 直接复制模板
    cp "$ENV_TEMPLATE" "$ENV_TARGET"
    ok "已复制模板 → $ENV_TARGET"
    warn "请编辑 $ENV_TARGET，至少设置 DATABASE_URL 与 JWT_SECRET（≥32 字符）"
    return 0
  fi

  # .env 已存在，按 mode 处理
  case "$mode" in
    refuse)
      warn "$ENV_TARGET 已存在，未做改动"
      echo ""
      echo "  默认策略：拒绝覆盖（避免误删自定义配置）"
      echo ""
      echo "  如需升级模板并保留自定义配置:"
      echo "    bash scripts/dev/devtool.sh init-env --merge"
      echo ""
      echo "  如需彻底覆盖（请先备份）:"
      echo "    cp $ENV_TARGET ${ENV_TARGET}.bak"
      echo "    bash scripts/dev/devtool.sh init-env --force"
      return 1
      ;;
    force)
      cp "$ENV_TEMPLATE" "$ENV_TARGET"
      ok "已覆盖 $ENV_TARGET（--force）"
      warn "请重新填写必填项：DATABASE_URL 与 JWT_SECRET（≥32 字符）"
      return 0
      ;;
    merge)
      # 收集模板 keys 与现有 keys
      local template_keys existing_keys missing
      template_keys="$(parse_env_keys "$ENV_TEMPLATE" | sort -u)"
      existing_keys="$(parse_env_keys "$ENV_TARGET" | sort -u)"
      missing="$(comm -23 <(echo "$template_keys") <(echo "$existing_keys"))"

      if [[ -z "$missing" ]]; then
        ok "$ENV_TARGET 已包含模板所有键，无需合并"
        return 0
      fi

      # 构造追加内容：仅含 missing 键的模板行
      local append=""
      local key
      while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        # 从模板提取该键的整行（取第一处出现的）
        local line
        line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_TEMPLATE" | head -1)"
        append+="${line}"$'\n'
      done <<< "$missing"

      # 追加到 .env 末尾（前面留空行 + 注释标记）
      {
        echo ""
        echo "# ── 以下键由 devtool.sh init-env --merge 于 $(date -u +%Y-%m-%dT%H:%M:%SZ) 追加 ──"
        printf "%s" "$append"
      } >> "$ENV_TARGET"

      ok "已追加缺失键到 $ENV_TARGET："
      while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        echo "  + $key"
      done <<< "$missing"
      return 0
      ;;
  esac
}

# ══════════════════════════════════════════════════════════════════
#  start — 启动模块
# ══════════════════════════════════════════════════════════════════

# 通用：后台启动一个进程（日志重定向、写 PID）
# 用法：spawn_target TARGET CMD [ARGS...]
spawn_target() {
  local target="$1"; shift
  local pid_file="$LOG_DIR/$target.pid"
  local log_file="$LOG_DIR/$target.log"

  rm -f "$pid_file"

  # setsid 启动新进程组（部分内核支持，便于后续杀整组）
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >>"$log_file" 2>&1 </dev/null &
  elif command -v nohup >/dev/null 2>&1; then
    # macOS 默认没有 setsid，使用 POSIX nohup 脱离终端会话。
    nohup "$@" >>"$log_file" 2>&1 </dev/null &
  else
    fail "未找到 setsid 或 nohup，无法将 $target 脱离终端启动"
  fi
  local pid=$!
  echo "$pid" >"$pid_file"
  echo "$pid"
}

start_infra() {
  section "启动基础设施（PostgreSQL + Redis）"
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    fail "找不到 $COMPOSE_FILE"
  fi

  # 已运行则跳过
  if docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -E 'postgres|redis' >/dev/null 2>&1; then
    ok "基础设施已在运行"
    return 0
  fi

  (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" up -d) || fail "docker compose up 失败"

  echo ">>> 等待服务就绪..."

  # PostgreSQL
  local i
  for ((i=1; i<=30; i++)); do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U noj >/dev/null 2>&1; then
      ok "PostgreSQL 已就绪"
      break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then fail "PostgreSQL 启动超时"; fi
  done

  # Redis
  for ((i=1; i<=15; i++)); do
    if docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping >/dev/null 2>&1; then
      ok "Redis 已就绪"
      break
    fi
    sleep 1
    if [[ $i -eq 15 ]]; then fail "Redis 启动超时"; fi
  done

  echo ""
  echo "PostgreSQL: localhost:5432 (noj / noj / 数据库 noj)"
  echo "Redis:      localhost:6379（无认证）"
}

start_core() {
  section "启动 noj-core（端口 ${PORT_CORE}）"

  # 守护检查
  local existing
  existing="$(read_pid core)"
  if [[ -n "$existing" ]]; then
    ok "noj-core 已在运行（PID $existing）"
    echo "  查看日志: tail -f $LOG_DIR/core.log"
    return 0
  fi

  # .env 检查
  if [[ ! -f "$ENV_TARGET" ]]; then
    fail "$ENV_TARGET 不存在，请先运行: devtool.sh init-env"
  fi

  # 确保开发环境拥有可登录管理员；引导失败时不启动后端进程。
  cmd_bootstrap_admin

  # infra 提示
  if ! command -v docker >/dev/null 2>&1; then
    fail "未检测到 docker"
  fi
  if ! docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -E 'postgres|redis' >/dev/null 2>&1; then
    warn "基础设施未运行，建议先运行: devtool.sh start infra"
  fi

  echo ">>> 启动 noj-core（日志: $LOG_DIR/core.log）..."
  (cd "$NOJ_CORE_DIR" && spawn_target core deno task dev) >/dev/null

  echo ">>> 等待 /health 就绪..."
  if wait_http "http://localhost:${PORT_CORE}/health" 30; then
    local pid
    pid="$(read_pid core)"
    echo ""
    ok "noj-core 已启动"
    echo "  PID:      $pid"
    echo "  端口:     ${PORT_CORE}"
    echo "  健康检查: curl http://localhost:${PORT_CORE}/health"
    echo "  日志:     tail -f $LOG_DIR/core.log"
    echo "  停止:     bash scripts/dev/devtool.sh stop core"
  else
    echo ""
    fail "noj-core 启动超时，请查看日志: $LOG_DIR/core.log"
  fi
}

start_ui() {
  section "启动 noj-ui（端口 ${PORT_UI}）"

  local existing
  existing="$(read_pid ui)"
  if [[ -n "$existing" ]]; then
    ok "noj-ui 已在运行（PID $existing）"
    echo "  查看日志: tail -f $LOG_DIR/ui.log"
    return 0
  fi

  echo ">>> 启动 noj-ui（首次启动需 10-30s 准备依赖）..."
  (cd "$NOJ_UI_DIR" && spawn_target ui deno task dev) >/dev/null

  echo ">>> 等待端口 ${PORT_UI}..."
  if wait_port ${PORT_UI} 60; then
    local pid
    pid="$(read_pid ui)"
    echo ""
    ok "noj-ui 已启动"
    echo "  PID:  $pid"
    echo "  端口: ${PORT_UI}"
    echo "  访问: http://localhost:${PORT_UI}"
    echo "  日志: tail -f $LOG_DIR/ui.log"
    echo "  停止: bash scripts/dev/devtool.sh stop ui"
  else
    fail "noj-ui 启动超时，请查看日志: $LOG_DIR/ui.log"
  fi
}

start_judge() {
  local force_build="${1:-no}"
  section "启动 noj-judge（评测 Worker）"

  local existing
  existing="$(read_pid judge)"
  if [[ -n "$existing" ]]; then
    ok "noj-judge 已在运行（PID $existing）"
    echo "  查看日志: tail -f $LOG_DIR/judge.log"
    return 0
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    fail "未检测到 cargo，请先安装 Rust 工具链"
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon 未运行，noj-judge 需要 Docker 沙箱"
  fi

  local judge_bin="$NOJ_JUDGE_DIR/target/debug/noj-judge"
  local judge_src="$NOJ_JUDGE_DIR/src/main.rs"

  # 智能增量：mtime 比较（除非 --build 强制）
  if [[ "$force_build" == "yes" ]] || [[ ! -x "$judge_bin" ]] || [[ "$judge_src" -nt "$judge_bin" ]]; then
    if [[ -d "$NOJ_JUDGE_DIR/target" ]] && [[ "$force_build" != "yes" ]]; then
      echo ">>> 源码变更，重新编译 noj-judge..."
    else
      echo ">>> 编译 noj-judge（首次约 1-3 分钟，--build 强制重编译）..."
    fi
    (cd "$NOJ_JUDGE_DIR" && cargo build) || fail "cargo build 失败"
  else
    echo ">>> 二进制最新（mtime 命中），跳过 cargo build"
  fi

  echo ">>> 启动 noj-judge（日志: $LOG_DIR/judge.log）..."
  (cd "$NOJ_JUDGE_DIR" && spawn_target judge ./target/debug/noj-judge) >/dev/null

  echo ">>> 等待 Redis 队列就绪..."
  local i pid
  pid="$(read_pid judge)"
  for ((i=1; i<=30; i++)); do
    if grep -q "Connected to Redis\|listening\|等待\|Waiting\|ready\|pool_init\|initialized" "$LOG_DIR/judge.log" 2>/dev/null; then
      echo ""
      ok "noj-judge 已启动"
      echo "  PID:  $pid"
      echo "  队列: noj:judge:queue（默认）"
      echo "  日志: tail -f $LOG_DIR/judge.log"
      echo "  停止: bash scripts/dev/devtool.sh stop judge"
      return 0
    fi
    # 进程已退出 → 启动失败
    if ! is_pid_alive "$pid"; then
      echo ""
      fail "noj-judge 启动失败，请查看日志: $LOG_DIR/judge.log"
    fi
    sleep 1
  done

  # 超时但进程仍在 → 标记为已启动（可能还在预热容器）
  echo ""
  ok "noj-judge 进程已运行（PID $pid），请通过日志确认队列监听状态"
  echo "  日志: tail -f $LOG_DIR/judge.log"
}

cmd_start() {
  local target="all" force_build="no"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      infra|core|ui|judge|all) target="$1"; shift ;;
      --build) force_build="yes"; shift ;;
      -h|--help)
        cat <<'EOF'
start [TARGET] [--build]

TARGET 取值:
  infra    启动 PostgreSQL + Redis（docker compose up）
  core     启动 noj-core 后端（deno task dev）
  ui       启动 noj-ui 前端（deno task dev）
  judge    启动 noj-judge 评测 Worker（智能 cargo build）
  all      按依赖顺序启动全部（默认）

--build  仅对 judge 生效：强制重新编译
EOF
        return 0
        ;;
      *) fail "未知参数: $1（运行 devtool.sh help 查看用法）" ;;
    esac
  done

  validate_target "$target" || fail "未知 TARGET: $target（合法值: infra|core|ui|judge|all）"

  # 按 START_ORDER 顺序启动（all 时严格按依赖）
  local t order_arr
  if [[ "$target" == "all" ]]; then
    order_arr=("${START_ORDER[@]}")
  else
    order_arr=("$target")
  fi

  for t in "${order_arr[@]}"; do
    acquire_lock "$t"
    ALL_LOCKS+=("$t")
    case "$t" in
      infra) start_infra ;;
      core)  start_core ;;
      ui)    start_ui ;;
      judge) start_judge "$force_build" ;;
    esac
  done

  echo ""
  if [[ "$target" == "all" ]]; then
    echo "=========================================="
    echo " ✓ 全部模块已启动"
    echo "=========================================="
    echo ""
    echo "访问入口:"
    echo "  前端:     http://localhost:${PORT_UI}"
    echo "  后端 API: http://localhost:${PORT_CORE}"
    echo "  健康检查: curl http://localhost:${PORT_CORE}/health"
    echo ""
    echo "查看状态: bash scripts/dev/devtool.sh status"
    echo "停止全部: bash scripts/dev/devtool.sh stop"
  fi
}

# ══════════════════════════════════════════════════════════════════
#  stop — 停止模块
# ══════════════════════════════════════════════════════════════════

# 通用：优雅停止（SIGTERM → 等 → SIGKILL）
stop_pid() {
  local target="$1" pid_file="$LOG_DIR/$target.pid"
  local initial_signal="${2:-TERM}" grace_secs="${3:-10}"

  if [[ ! -f "$pid_file" ]]; then
    echo "$target 未在运行（无 PID 文件）"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null)"
  if ! is_pid_alive "$pid"; then
    echo "PID $pid 已不存在，清理 PID 文件"
    rm -f "$pid_file"
    return 0
  fi

  echo ">>> 停止 $target（PID $pid）..."
  if [[ "$initial_signal" == "INT" ]]; then
    kill -INT "$pid"
  else
    kill -TERM "$pid"
  fi

  local i
  for ((i=1; i<=grace_secs; i++)); do
    if ! is_pid_alive "$pid"; then
      rm -f "$pid_file"
      ok "$target 已停止"
      return 0
    fi
    sleep 1
  done

  # SIGINT 优雅关闭失败时，先降级 SIGTERM，最后 SIGKILL（对应 judge 的渐进停止）
  if [[ "$initial_signal" == "INT" ]]; then
    echo "未响应 SIGINT，发送 SIGTERM"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
  fi

  if is_pid_alive "$pid"; then
    echo "仍未退出，发送 SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  ok "$target 已强制停止"
}

stop_infra() {
  section "停止基础设施（保留数据卷）"
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker 命令不可用，跳过 infra 停止"
    return 0
  fi
  if ! docker compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -E 'postgres|redis' >/dev/null 2>&1; then
    echo "基础设施未运行"
    return 0
  fi

  (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" down) || warn "docker compose down 失败"

  echo ""
  echo "数据卷未删除，PostgreSQL / Redis 数据保留"
  echo "重启:   bash scripts/dev/devtool.sh start infra"
  echo "彻底清理: docker compose -f $COMPOSE_FILE down -v"
}

stop_core() { stop_pid core TERM 10; }
stop_ui()   { stop_pid ui   TERM 10; }

stop_judge() {
  # judge 特殊：用 SIGINT 触发 ctrl_c() 优雅关闭（渐进序列见 stop_pid INT 模式）
  stop_pid judge INT 10
}

cmd_stop() {
  local target="all"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      infra|core|ui|judge|all) target="$1"; shift ;;
      -h|--help)
        cat <<'EOF'
stop [TARGET]

TARGET 取值:
  infra    停止 PostgreSQL + Redis（docker compose down，保数据卷）
  core     停止 noj-core（SIGTERM）
  ui       停止 noj-ui（SIGTERM）
  judge    停止 noj-judge（SIGINT → SIGTERM → SIGKILL 渐进）
  all      按反向依赖顺序停止全部（默认）
EOF
        return 0
        ;;
      *) fail "未知参数: $1" ;;
    esac
  done

  validate_target "$target" || fail "未知 TARGET: $target"

  local t order_arr
  if [[ "$target" == "all" ]]; then
    order_arr=("${STOP_ORDER[@]}")
  else
    order_arr=("$target")
  fi

  for t in "${order_arr[@]}"; do
    acquire_lock "$t"
    ALL_LOCKS+=("$t")
    case "$t" in
      infra) stop_infra ;;
      core)  stop_core ;;
      ui)    stop_ui ;;
      judge) stop_judge ;;
    esac
  done

  echo ""
  if [[ "$target" == "all" ]]; then
    echo "=========================================="
    echo " ✓ 全部模块已停止"
    echo "=========================================="
    echo ""
    echo "数据卷未删除，数据库与 Redis 数据保留"
    echo "重启: bash scripts/dev/devtool.sh start"
  fi
}

# ══════════════════════════════════════════════════════════════════
#  status — 查看运行状态
# ══════════════════════════════════════════════════════════════════

# status 一行（人类可读）
status_human_line() {
  local target="$1" pid running health_color health_text log_path
  pid="$(read_pid "$target")"
  log_path="$LOG_DIR/$target.log"

  if [[ -z "$pid" ]]; then
    printf "${RED}●${RESET} %-8s ${DIM}未运行${RESET}\n" "$target"
    return 0
  fi

  case "$target" in
    core)
      if curl -fsS http://localhost:${PORT_CORE}/health >/dev/null 2>&1; then
        health_color="$GREEN"; health_text="health OK"
      else
        health_color="$YELLOW"; health_text="health 不可达"
      fi
      ;;
    ui)
      if curl -fsS -o /dev/null http://localhost:${PORT_UI}/ 2>/dev/null; then
        health_color="$GREEN"; health_text="HTTP OK"
      else
        health_color="$YELLOW"; health_text="端口不可达"
      fi
      ;;
    judge)
      health_color="$DIM"; health_text="(无 HTTP 端点)"
      ;;
  esac

  printf "${GREEN}●${RESET} %-8s PID %-6s  ${health_color}%s${RESET}  ${DIM}日志: %s${RESET}\n" \
    "$target" "$pid" "$health_text" "$log_path"
}

status_human() {
  echo "━━━ 基础设施 ━━━"
  if command -v docker >/dev/null 2>&1; then
    if docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -E 'postgres|redis' >/dev/null 2>&1; then
      (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null) \
        | grep -E 'postgres|redis|NAME' || true
    else
      down "未运行（运行: devtool.sh start infra）"
    fi
  else
    warn "docker 命令不可用"
  fi
  echo ""

  for t in core ui judge; do
    echo "━━━ $t ━━━"
    status_human_line "$t"
    echo ""
  done

  echo "━━━ 日志 ${DIM}($LOG_DIR)${RESET} ━━━"
  if [[ -d "$LOG_DIR" ]]; then
    ls -lh "$LOG_DIR"/*.log 2>/dev/null | awk '{printf "  %-15s  %s\n", $NF, $5}' || echo "  无日志文件"
  fi
}

# status 一行（JSON）— 单 module
status_json_module() {
  local target="$1" pid running health port
  pid="$(read_pid "$target")"

  running="false"
  health="n/a"
  port=""

  case "$target" in
    core)
      port="${PORT_CORE}"
      if [[ -n "$pid" ]]; then running="true"; fi
      if curl -fsS http://localhost:${PORT_CORE}/health >/dev/null 2>&1; then health="ok"; else health="unreachable"; fi
      ;;
    ui)
      port="${PORT_UI}"
      if [[ -n "$pid" ]]; then running="true"; fi
      if curl -fsS -o /dev/null http://localhost:${PORT_UI}/ 2>/dev/null; then health="ok"; else health="unreachable"; fi
      ;;
    judge)
      if [[ -n "$pid" ]]; then running="true"; fi
      ;;
  esac

  # 手工 JSON 构造（避免依赖 jq）
  printf '{"target":"%s","running":%s,"pid":%s,"port":"%s","health":"%s","log":"%s"}\n' \
    "$target" "$running" "${pid:-null}" "$port" "$health" "$LOG_DIR/$target.log"
}

status_json() {
  local infra_running="false"
  if command -v docker >/dev/null 2>&1 \
     && docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -E 'postgres|redis' >/dev/null 2>&1; then
    infra_running="true"
  fi

  printf '{\n'
  printf '  "infra": {"running": %s},\n' "$infra_running"
  printf '  "modules": [\n'
  local first="1" t line
  for t in core ui judge; do
    line="$(status_json_module "$t" | tr -d '\n')"
    if [[ -z "$first" ]]; then printf '    ,\n'; fi
    printf '    %s\n' "$line"
    first=""
  done
  printf '  ]\n'
  printf '}\n'
}

cmd_status() {
  local json_mode="no" watch_secs=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json_mode="yes"; shift ;;
      --watch)
        watch_secs="$2"
        shift 2
        [[ -z "$watch_secs" ]] && fail "--watch 需要参数 SECS"
        ;;
      -h|--help)
        cat <<'EOF'
status [--json] [--watch SECS]

默认输出人类可读的模块状态；--json 输出结构化 JSON；--watch N 每 N 秒刷新。
EOF
        return 0
        ;;
      *) fail "未知参数: $1" ;;
    esac
  done

  if [[ -n "$watch_secs" ]]; then
    while true; do
      clear
      if [[ "$json_mode" == "yes" ]]; then
        status_json
      else
        status_human
      fi
      sleep "$watch_secs"
    done
  fi

  if [[ "$json_mode" == "yes" ]]; then
    status_json
  else
    status_human
  fi
}

# ══════════════════════════════════════════════════════════════════
#  help
# ══════════════════════════════════════════════════════════════════
cmd_help() {
  cat <<'EOF'
devtool.sh — Neuro OJ 本地开发编排工具（Linux + macOS）

用法:
  bash scripts/dev/devtool.sh <子命令> [参数]

子命令:
  install-deps [--check-only]   检测 / 安装前置依赖（zip / Deno / Rust / Docker）
  init-env     [--merge|--force] 初始化 noj-core/.env（默认拒绝覆盖）
  bootstrap admin [--email X] [--password Y] 创建/引导管理员（开发模式不强制首次改密）
  start        [TARGET] [--build] 启动 TARGET（infra|core|ui|judge|all，默认 all）
  stop         [TARGET]          停止 TARGET（同上，按反向依赖顺序）
  status       [--json] [--watch SECS] 查看运行状态
  help                            显示本帮助

示例:
  devtool.sh install-deps            # 首次：检测 + 安装依赖
  devtool.sh init-env                # 首次：复制 env.example → noj-core/.env
  devtool.sh bootstrap admin --email admin@noj.local --password 'Admin-2026-Xy9!'
                                     # 创建管理员（默认不强制首次改密）
  devtool.sh start                   # 启动全部（infra → core → ui → judge）
  devtool.sh start ui                # 只启动前端（纯前端开发）
  devtool.sh start judge --build     # 启动 judge 并强制重新编译
  devtool.sh status                  # 查看所有模块状态
  devtool.sh status --json           # JSON 输出（CI / 脚本消费）
  devtool.sh stop                    # 停止全部（judge → ui → core → infra）
  devtool.sh stop core               # 只停 core

文件位置:
  PID:    scripts/dev/logs/<target>.pid
  日志:   scripts/dev/logs/<target>.log
  模板:   scripts/dev/env.example
  .env:   noj-core/.env

平台: Linux 原生 + macOS 原生；Windows 用户请使用 WSL2
EOF
}

# ══════════════════════════════════════════════════════════════════
#  分发
# ══════════════════════════════════════════════════════════════════
cmd="${1:-help}"
shift || true

case "$cmd" in
  install-deps) cmd_install_deps "$@" ;;
  init-env)     cmd_init_env     "$@" ;;
  bootstrap)    cmd_bootstrap_admin "$@" ;;
  start)        cmd_start        "$@" ;;
  stop)         cmd_stop         "$@" ;;
  status)       cmd_status       "$@" ;;
  help|--help|-h|"") cmd_help ;;
  *) fail "未知子命令: $cmd（运行 'bash scripts/dev/devtool.sh help' 查看用法）" ;;
esac
