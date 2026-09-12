#!/usr/bin/env bash
# Neuro OJ 生产备份 cron 调度管理。
#
# 该脚本只管理自己标记的 crontab 区块，保留宿主机上的其他任务。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
ENV_FILE="$INSTALL_DIR/.env.prod"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.prod.yml"
BACKUP_DIR="$INSTALL_DIR/backups"
PASSPHRASE_FILE=""
SCHEDULE="15 2 * * *"
CRONTAB_BIN="${NOJ_BACKUP_CRONTAB_BIN:-crontab}"
COMMAND=""

MARKER_BEGIN="# BEGIN NEURO-OJ BACKUP (managed)"
MARKER_END="# END NEURO-OJ BACKUP (managed)"

usage() {
  cat <<'EOF'
Neuro OJ 生产备份定期调度

用法：
  backup-schedule.sh install [选项]   安装或更新每日 cron 任务
  backup-schedule.sh status          查看当前任务
  backup-schedule.sh remove          删除本工具安装的任务

选项：
  --schedule CRON       五段 cron 表达式（默认：15 2 * * *）
  --env-file FILE       生产环境文件（默认：安装目录/.env.prod）
  --compose-file FILE   生产 Compose 文件（默认：安装目录/docker-compose.prod.yml）
  --backup-dir DIR      快照目录（默认：安装目录/backups）
  --passphrase-file FILE GPG 口令文件（必填，也可用 NOJ_BACKUP_PASSPHRASE_FILE）
  -h, --help            显示帮助

说明：
  install 会以当前用户安装 cron 任务，每次执行均写入快照和 backup-cron.log。
  调度任务调用绝对路径，不依赖 PATH；任务失败时 cron 进程返回非零并保留日志。
EOF
}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok() { printf '✓ %s\n' "$*"; }

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

validate_schedule() {
  # 只接受 cron 常见的数字、范围、列表、步长、星号和问号，拒绝 shell 元字符。
  [[ "$SCHEDULE" =~ ^[0-9*/?,-]+[[:space:]]+[0-9*/?,-]+[[:space:]]+[0-9*/?,-]+[[:space:]]+[0-9*/?,-]+[[:space:]]+[0-9*/?,-]+$ ]] ||
    die "--schedule 必须是五段 cron 表达式，且不能包含 shell 元字符"
}

validate_install() {
  [[ -x "$BACKUP_SCRIPT" ]] || die "备份脚本不存在或不可执行：$BACKUP_SCRIPT"
  [[ -f "$ENV_FILE" ]] || die "生产环境文件不存在：$ENV_FILE"
  [[ -f "$COMPOSE_FILE" ]] || die "生产 Compose 文件不存在：$COMPOSE_FILE"
  [[ -n "$PASSPHRASE_FILE" ]] || die "install 必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE"
  [[ -f "$PASSPHRASE_FILE" ]] || die "GPG 口令文件不存在：$PASSPHRASE_FILE"
  local mode
  mode="$(file_mode "$PASSPHRASE_FILE")"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    die "GPG 口令文件权限必须为 600 或 400：$PASSPHRASE_FILE"
  command -v "$CRONTAB_BIN" >/dev/null 2>&1 || die "找不到 crontab：$CRONTAB_BIN"
  validate_schedule
  mkdir -m 700 -p "$BACKUP_DIR"
  touch "$BACKUP_DIR/backup-cron.log"
  chmod 600 "$BACKUP_DIR/backup-cron.log"
}

read_crontab() {
  "$CRONTAB_BIN" -l 2>/dev/null || true
}

remove_block() {
  awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  '
}

write_crontab() {
  local content="$1"
  printf '%s\n' "$content" | "$CRONTAB_BIN" - || die "写入 crontab 失败"
}

install_schedule() {
  validate_install
  local current entry updated env_q compose_q backup_q pass_q backup_script_q log_file_q
  current="$(read_crontab | remove_block)"
  printf -v env_q '%q' "$ENV_FILE"
  printf -v compose_q '%q' "$COMPOSE_FILE"
  printf -v backup_q '%q' "$BACKUP_DIR"
  printf -v pass_q '%q' "$PASSPHRASE_FILE"
  printf -v backup_script_q '%q' "$BACKUP_SCRIPT"
  printf -v log_file_q '%q' "$BACKUP_DIR/backup-cron.log"
  entry="$SCHEDULE $backup_script_q create --env-file $env_q --compose-file $compose_q --backup-dir $backup_q --passphrase-file $pass_q >> $log_file_q 2>&1"
  updated="$current"
  [[ -z "$updated" ]] || updated+=$'\n'
  updated+="$MARKER_BEGIN"$'\n'"$entry"$'\n'"$MARKER_END"
  write_crontab "$updated"
  ok "已安装每日备份任务：$SCHEDULE"
  ok "备份日志：$BACKUP_DIR/backup-cron.log"
}

status_schedule() {
  local block
  block="$(read_crontab | awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
    $0 == begin { found = 1 }
    found { print }
    $0 == end { exit }
  ')"
  if [[ -n "$block" ]]; then
    printf '%s\n' "$block"
  else
    printf '未安装 Neuro OJ 备份调度\n'
    return 1
  fi
}

remove_schedule() {
  command -v "$CRONTAB_BIN" >/dev/null 2>&1 || die "找不到 crontab：$CRONTAB_BIN"
  local current updated
  current="$(read_crontab)"
  updated="$(printf '%s\n' "$current" | remove_block)"
  [[ "$current" != "$updated" ]] || {
    ok "未找到 Neuro OJ 备份调度"
    return 0
  }
  write_crontab "$updated"
  ok "已删除 Neuro OJ 备份调度"
}

parse_args() {
  COMMAND="${1:-}"
  [[ -n "$COMMAND" ]] || { usage; exit 2; }
  shift
  while (($# > 0)); do
    case "$1" in
      --schedule) (($# >= 2)) || die "--schedule 缺少参数"; SCHEDULE="$2"; shift 2 ;;
      --env-file) (($# >= 2)) || die "--env-file 缺少参数"; ENV_FILE="$2"; shift 2 ;;
      --compose-file) (($# >= 2)) || die "--compose-file 缺少参数"; COMPOSE_FILE="$2"; shift 2 ;;
      --backup-dir) (($# >= 2)) || die "--backup-dir 缺少参数"; BACKUP_DIR="$2"; shift 2 ;;
      --passphrase-file) (($# >= 2)) || die "--passphrase-file 缺少参数"; PASSPHRASE_FILE="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知选项：$1" ;;
    esac
  done
  PASSPHRASE_FILE="${PASSPHRASE_FILE:-${NOJ_BACKUP_PASSPHRASE_FILE:-}}"
}

parse_args "$@"
case "$COMMAND" in
  install) install_schedule ;;
  status) status_schedule ;;
  remove) remove_schedule ;;
  *) usage >&2; die "未知命令：$COMMAND" ;;
esac
