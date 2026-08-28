#!/usr/bin/env bash
# Neuro OJ 生产数据备份、校验、恢复和恢复演练工具。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.prod"
COMPOSE_FILE="$REPO_ROOT/docker-compose.prod.yml"
BACKUP_DIR="$REPO_ROOT/backups"
PASSPHRASE_FILE="${NOJ_BACKUP_PASSPHRASE_FILE:-}"
DOCKER_BIN="${NOJ_BACKUP_DOCKER_BIN:-docker}"
RETENTION_DAYS="${NOJ_BACKUP_RETENTION_DAYS:-30}"
MIN_FREE_MB="${NOJ_BACKUP_MIN_FREE_MB:-1024}"
PROJECT_NAME="${NOJ_BACKUP_PROJECT_NAME:-}"
COMMAND=""
SNAPSHOT=""
CONFIRM=0
RESTORE_ENV=""
DRILL_REPORT=""
CREATE_TEMP=""
VERIFY_TEMP=""

cleanup_temporary_files() {
  [[ -z "$CREATE_TEMP" || ! -e "$CREATE_TEMP" ]] || rm -rf -- "$CREATE_TEMP"
  [[ -z "$VERIFY_TEMP" || ! -e "$VERIFY_TEMP" ]] || rm -f -- "$VERIFY_TEMP"
}

trap cleanup_temporary_files EXIT

ok() { printf '[backup] ✓ %s\n' "$*"; }
warn() { printf '[backup] ⚠ %s\n' "$*" >&2; }
die() { printf '[backup] ✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Neuro OJ 生产备份工具

用法：
  backup.sh create [选项]             创建完整快照
  backup.sh verify SNAPSHOT [选项]    校验快照完整性
  backup.sh restore SNAPSHOT [选项]   恢复到已停止的 Compose 环境
  backup.sh drill SNAPSHOT [选项]     执行非破坏性的恢复演练校验

选项：
  --env-file FILE          生产环境文件（默认 .env.prod）
  --compose-file FILE      生产 Compose 文件
  --backup-dir DIR         快照根目录（默认 ./backups）
  --passphrase-file FILE   GPG 对称加密口令文件（权限必须为 600/400）
  --retention-days DAYS    保留天数（默认 30）
  --min-free-mb MB         最低可用磁盘空间（默认 1024 MB）
  --confirm                确认 restore 会覆盖目标数据
  --restore-env FILE       将加密环境文件恢复到新文件（目标不得已存在）
  --report FILE            drill 报告文件
  -h, --help               显示帮助

环境变量：
  NOJ_BACKUP_PASSPHRASE_FILE  默认 GPG 口令文件
  NOJ_BACKUP_RETENTION_DAYS   默认快照保留天数
  NOJ_BACKUP_MIN_FREE_MB      默认最低可用空间
EOF
}

env_value() {
  local key="$1" value
  [[ -f "$ENV_FILE" ]] || return 0
  value="$(awk -v key="$key" '
    index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$ENV_FILE")"
  case "$value" in
    '"'*'"'|"'"*"'"*) value="${value:1:${#value}-2}" ;;
  esac
  printf '%s\n' "$value"
}

compose() {
  local args=(compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE")
  if [[ -n "$PROJECT_NAME" ]]; then
    args+=(--project-name "$PROJECT_NAME")
  fi
  "$DOCKER_BIN" "${args[@]}" "$@"
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

check_secret_file() {
  [[ -f "$1" ]] || die "GPG 口令文件不存在：$1"
  local mode
  mode="$(file_mode "$1")"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    die "GPG 口令文件权限必须为 600 或 400：$1"
}

check_env() {
  [[ -f "$ENV_FILE" ]] || die "生产环境文件不存在：$ENV_FILE"
  local mode
  mode="$(file_mode "$ENV_FILE")"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    die "生产环境文件权限必须为 600 或 400：$ENV_FILE"
  [[ -f "$COMPOSE_FILE" ]] || die "生产 Compose 文件不存在：$COMPOSE_FILE"
  command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker daemon 不可用"
  compose config --quiet || die "Docker Compose 配置无效"
}

check_numbers() {
  [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "保留天数必须是非负整数"
  [[ "$MIN_FREE_MB" =~ ^[0-9]+$ ]] || die "最低可用空间必须是非负整数"
}

check_free_space() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  local available_kb
  available_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || die "无法读取备份目录可用空间"
  ((available_kb >= MIN_FREE_MB * 1024)) ||
    die "备份目录可用空间不足：需要至少 ${MIN_FREE_MB}MB"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "需要 sha256sum 或 shasum"
  fi
}

gpg_encrypt() {
  command -v gpg >/dev/null 2>&1 || die "创建加密环境备份需要 gpg"
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --symmetric --cipher-algo AES256 \
    --output "$1" "$ENV_FILE" >/dev/null 2>&1 || die "生产环境文件加密失败"
}

gpg_decrypt() {
  command -v gpg >/dev/null 2>&1 || die "校验加密环境备份需要 gpg"
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt --output "$2" "$1" >/dev/null 2>&1 || die "生产环境文件解密失败"
}

record_migration_status() {
  local user db schema
  user="$(env_value POSTGRES_USER)"; user="${user:-noj}"
  db="$(env_value POSTGRES_DB)"; db="${db:-noj}"
  schema="$(compose exec -T postgres psql -U "$user" -d "$db" -Atqc \
    "SELECT to_regclass('drizzle.__drizzle_migrations')" 2>/dev/null || true)"
  if [[ -n "$schema" && "$schema" != "" ]]; then
    compose exec -T postgres psql -U "$user" -d "$db" -Atqc \
      "SELECT hash || ':' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at" \
      2>/dev/null || printf 'migration-status-unavailable\n'
  else
    printf 'not-initialized\n'
  fi
}

write_checksums() {
  local root="$1" file digest
  : > "$root/sha256sums.txt"
  while IFS= read -r file; do
    digest="$(sha256 "$root/$file")"
    printf '%s  %s\n' "$digest" "$file" >> "$root/sha256sums.txt"
  done < <(cd "$root" && find . -type f ! -name 'sha256sums.txt' -print | sed 's#^./##' | LC_ALL=C sort)
}

prune_old_snapshots() {
  local old
  while IFS= read -r -d '' old; do
    rm -rf -- "$old"
    ok "已清理过期快照：$old"
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
    -name 'snapshot-*' -mtime "+$RETENTION_DAYS" -print0)
}

create_snapshot() {
  check_env
  check_numbers
  [[ -n "$PASSPHRASE_FILE" ]] || die "create 必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE"
  check_secret_file "$PASSPHRASE_FILE"
  check_free_space

  local timestamp final temp index=1
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  final="$BACKUP_DIR/snapshot-$timestamp"
  while [[ -e "$final" ]]; do
    final="$BACKUP_DIR/snapshot-$timestamp-$index"
    index=$((index + 1))
  done
  temp="$BACKUP_DIR/.snapshot-$timestamp-$$.tmp"
  mkdir -m 700 "$temp"
  CREATE_TEMP="$temp"

  local pg_user pg_db redis_file
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"

  compose exec -T postgres pg_dump -U "$pg_user" -d "$pg_db" -Fc > "$temp/postgres.dump" \
    || die "PostgreSQL 备份失败"
  [[ -s "$temp/postgres.dump" ]] || die "PostgreSQL 备份为空"
  compose exec -T postgres pg_dumpall -U "$pg_user" --globals-only --no-role-passwords > "$temp/postgres-globals.sql" \
    || die "PostgreSQL 全局对象备份失败"
  compose exec -T postgres pg_restore --list - < "$temp/postgres.dump" > "$temp/postgres.restore-list" \
    || die "PostgreSQL 备份结构校验失败"

  redis_file="$temp/redis.rdb"
  compose exec -T redis sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --rdb -' > "$redis_file" \
    || die "Redis RDB 备份失败"
  [[ -s "$redis_file" ]] || die "Redis RDB 备份为空"
  compose exec -T redis sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning INFO persistence' \
    > "$temp/redis-persistence.txt" || die "Redis 持久化状态读取失败"

  mkdir -m 700 "$temp/minio"
  compose run --rm --no-deps --entrypoint /bin/sh -v "$temp/minio:/backup:rw" minio-init -c \
    'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --preserve "local/$S3_BUCKET" /backup' \
    || die "MinIO/S3 对象备份失败"

  gpg_encrypt "$temp/env.prod.gpg"
  cat > "$temp/manifest.json" <<EOF
{
  "format_version": 1,
  "created_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "postgres_database": "$pg_db",
  "redis_policy": "RDB snapshot; judge queue is recoverable transient data",
  "object_storage": "MinIO/S3 mirror",
  "postgres_backup_mode": "logical-full",
  "incremental_policy": "MinIO mirror is incremental; PostgreSQL WAL/PITR requires external infrastructure",
  "rpo": "snapshot interval configured by scheduler",
  "rto": "restore duration depends on database and object volume",
  "retention_days": $RETENTION_DAYS
}
EOF
  printf '%s\n' "$(record_migration_status)" > "$temp/migration-status.txt"
  write_checksums "$temp"
  printf 'success\n' > "$temp/SUCCESS"
  chmod -R go-rwx "$temp"
  mv "$temp" "$final"
  CREATE_TEMP=""
  verify_snapshot "$final"
  prune_old_snapshots
  ok "完整生产快照已创建：$final"
  ok "PostgreSQL、Redis、MinIO/S3 和加密环境文件均已写入"
}

validate_snapshot_path() {
  [[ -d "$1" ]] || die "快照目录不存在：$1"
  [[ "$(basename "$1")" == snapshot-* ]] || die "只允许校验 snapshot-* 快照目录"
  [[ "$1" != */..* && "$1" != */.snapshot-* ]] || die "非法快照路径"
}

verify_snapshot() {
  local snapshot="$1"
  validate_snapshot_path "$snapshot"
  local snapshot_mode
  snapshot_mode="$(file_mode "$snapshot")"
  [[ "$snapshot_mode" == "700" ]] || die "快照目录权限必须为 700：$snapshot"
  [[ -n "$PASSPHRASE_FILE" ]] || die "verify 必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE"
  check_secret_file "$PASSPHRASE_FILE"
  [[ -f "$snapshot/sha256sums.txt" ]] || die "快照缺少 sha256sums.txt"
  [[ -f "$snapshot/SUCCESS" ]] || die "快照缺少成功标记"

  local line expected file actual temp
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    expected="${line%%  *}"
    file="${line#*  }"
    [[ "$file" != "$line" && "$file" != /* && "$file" != *".."* ]] || die "校验清单包含非法路径"
    [[ -f "$snapshot/$file" ]] || die "快照文件缺失：$file"
    actual="$(sha256 "$snapshot/$file")"
    [[ "$actual" == "$expected" ]] || die "SHA-256 校验失败：$file"
  done < "$snapshot/sha256sums.txt"
  [[ -s "$snapshot/postgres.restore-list" ]] || die "PostgreSQL dump 结构清单为空"
  [[ -s "$snapshot/redis.rdb" ]] || die "Redis RDB 为空"
  [[ -d "$snapshot/minio" ]] || die "MinIO/S3 快照目录缺失"

  temp="$(mktemp)"
  VERIFY_TEMP="$temp"
  gpg_decrypt "$snapshot/env.prod.gpg" "$temp"
  [[ -s "$temp" ]] || die "加密环境文件解密结果为空"
  rm -f "$temp"
  VERIFY_TEMP=""
  ok "快照校验通过：$snapshot"
}

ensure_stopped() {
  local running
  running="$(compose ps --status running -q 2>/dev/null || true)"
  [[ -z "$running" ]] || die "恢复前必须停止 Compose 服务；请先执行 deploy.sh stop"
}

restore_env_file() {
  [[ -n "$RESTORE_ENV" ]] || return 0
  [[ ! -e "$RESTORE_ENV" ]] || die "恢复环境文件目标已存在，为避免覆盖请先移走：$RESTORE_ENV"
  gpg_decrypt "$SNAPSHOT/env.prod.gpg" "$RESTORE_ENV"
  chmod 600 "$RESTORE_ENV"
  ok "加密环境文件已恢复：$RESTORE_ENV"
}

restore_snapshot() {
  validate_snapshot_path "$SNAPSHOT"
  [[ "$CONFIRM" == "1" ]] || die "restore 会覆盖目标数据，必须显式提供 --confirm"
  verify_snapshot "$SNAPSHOT"
  check_env
  ensure_stopped
  restore_env_file

  local pg_user pg_db
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"
  compose up -d --wait --wait-timeout 180 postgres redis minio || die "恢复前数据服务启动失败"

  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" < "$SNAPSHOT/postgres-globals.sql" \
    || die "PostgreSQL 全局对象恢复失败"
  compose exec -T postgres pg_restore --clean --if-exists --no-owner --exit-on-error \
    -U "$pg_user" -d "$pg_db" - < "$SNAPSHOT/postgres.dump" \
    || die "PostgreSQL 数据恢复失败"

  compose stop redis || die "停止 Redis 失败"
  compose run --rm --no-deps --entrypoint /bin/sh redis -c \
    'set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb' < "$SNAPSHOT/redis.rdb" \
    || die "写入 Redis RDB 失败"
  compose up -d --wait --wait-timeout 180 redis || die "恢复后 Redis 启动失败"

  compose run --rm --no-deps --entrypoint /bin/sh -v "$SNAPSHOT/minio:/restore:ro" minio-init -c \
    'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --overwrite --remove /restore "local/$S3_BUCKET"' \
    || die "MinIO/S3 对象恢复失败"
  compose stop postgres redis minio >/dev/null || true
  ok "快照恢复完成；数据服务已停止，请人工检查后再启动业务服务"
}

drill_snapshot() {
  validate_snapshot_path "$SNAPSHOT"
  verify_snapshot "$SNAPSHOT"
  local report="${DRILL_REPORT:-$SNAPSHOT/restore-drill.txt}"
  {
    printf 'result=verified\n'
    printf 'snapshot=%s\n' "$SNAPSHOT"
    printf 'next_step=restore --confirm in an isolated Compose project\n'
    printf 'postgres=logical dump structure verified\n'
    printf 'redis=RDB payload and persistence metadata verified\n'
    printf 'minio=object mirror directory verified\n'
    printf 'env=GPG decryption verified\n'
    printf 'warning=PostgreSQL incremental/PITR requires external WAL archive infrastructure\n'
  } > "$report"
  chmod 600 "$report"
  ok "恢复演练校验通过，报告已写入：$report"
}

parse_args() {
  [[ "$#" -gt 0 ]] || { usage; exit 2; }
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then usage; exit 0; fi
  COMMAND="$1"
  shift
  if [[ "$COMMAND" == "verify" || "$COMMAND" == "restore" || "$COMMAND" == "drill" ]]; then
    [[ "$#" -gt 0 ]] || die "$COMMAND 需要 SNAPSHOT 参数"
    SNAPSHOT="$1"
    shift
  fi
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --env-file) [[ "$#" -ge 2 ]] || die "--env-file 缺少参数"; ENV_FILE="$2"; shift 2 ;;
      --compose-file) [[ "$#" -ge 2 ]] || die "--compose-file 缺少参数"; COMPOSE_FILE="$2"; shift 2 ;;
      --backup-dir) [[ "$#" -ge 2 ]] || die "--backup-dir 缺少参数"; BACKUP_DIR="$2"; shift 2 ;;
      --passphrase-file) [[ "$#" -ge 2 ]] || die "--passphrase-file 缺少参数"; PASSPHRASE_FILE="$2"; shift 2 ;;
      --retention-days) [[ "$#" -ge 2 ]] || die "--retention-days 缺少参数"; RETENTION_DAYS="$2"; shift 2 ;;
      --min-free-mb) [[ "$#" -ge 2 ]] || die "--min-free-mb 缺少参数"; MIN_FREE_MB="$2"; shift 2 ;;
      --project-name) [[ "$#" -ge 2 ]] || die "--project-name 缺少参数"; PROJECT_NAME="$2"; shift 2 ;;
      --confirm) CONFIRM=1; shift ;;
      --restore-env) [[ "$#" -ge 2 ]] || die "--restore-env 缺少参数"; RESTORE_ENV="$2"; shift 2 ;;
      --report) [[ "$#" -ge 2 ]] || die "--report 缺少参数"; DRILL_REPORT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知选项：$1" ;;
    esac
  done
}

parse_args "$@"
case "$COMMAND" in
  create) create_snapshot ;;
  verify) verify_snapshot "$SNAPSHOT" ;;
  restore) restore_snapshot ;;
  drill) drill_snapshot ;;
  help) usage ;;
  *) die "未知命令：$COMMAND" ;;
esac
