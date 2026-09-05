#!/usr/bin/env bash
# Neuro OJ 生产备份隔离恢复演练。
#
# 与 backup.sh drill（纯文件校验）不同，本脚本把快照真实恢复到一个独立的
# Compose 项目（独立数据卷、独立网络子网、不映射宿主机端口），随后验收业务：
# 登录、题目读取、附件下载和至少一次真实评测。任何环节失败都以非零退出并
# 保留诊断报告。
#
# 用法：restore-drill.sh SNAPSHOT [选项]
# 详见 usage()。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERIFY_SCRIPT="$SCRIPT_DIR/restore-drill-verify.ts"

SNAPSHOT=""
ENV_FILE="$REPO_ROOT/.env.prod"
COMPOSE_FILE="$REPO_ROOT/docker-compose.prod.yml"
PASSPHRASE_FILE="${NOJ_BACKUP_PASSPHRASE_FILE:-}"
DOCKER_BIN="${NOJ_BACKUP_DOCKER_BIN:-docker}"
PROJECT_NAME="${NOJ_DRILL_PROJECT_NAME:-noj-drill}"
DRILL_DIR=""
REPORT=""
SUBNET="${NOJ_DRILL_SUBNET:-172.29.0.0/16}"
RPO_MAX_HOURS="${NOJ_DRILL_RPO_MAX_HOURS:-24}"
RTO_MAX_MINUTES="${NOJ_DRILL_RTO_MAX_MINUTES:-60}"
WAIT_TIMEOUT="${NOJ_DRILL_WAIT_TIMEOUT:-300}"
SKIP_JUDGE=0
KEEP=0

DRILL_STARTED_AT=""
STAGE="init"
TEMP_DIR=""
COMPOSE_ENV_FILE=""
DRILL_EVALUATOR_IMAGE=""
DRILL_SOLUTION_IMAGE=""

# 演练管理员账号：只存在于隔离演练数据库，不影响生产。密码固定，保证演练
# 可复现（Drill-Recover-2026，bcrypt cost 12，满足最小密码策略）。
DRILL_ADMIN_USER="drill_admin"
DRILL_ADMIN_EMAIL_DOMAIN="restore-drill.invalid"
DRILL_ADMIN_PASSWORD="Drill-Recover-2026"
DRILL_BCRYPT_HASH='$2b$12$edDmxsubnHJL8B/Wsdryxu4ibNin0/SEhqAXkB.Yn50SCoN29lQCW'

# judge_images 白名单缺失时的兜底评测镜像（与官方发布镜像一致）。
DEFAULT_EVALUATOR_IMAGE="noj-evaluator-python"
DEFAULT_SOLUTION_IMAGE="noj-solution-python"

ok() { printf '[drill] ✓ %s\n' "$*"; }
warn() { printf '[drill] ⚠ %s\n' "$*" >&2; }
die() {
  printf '[drill] ✗ %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Neuro OJ 备份隔离恢复演练

用法：
  restore-drill.sh SNAPSHOT [选项]

与 backup.sh drill（快照文件校验）不同，本命令把快照真实恢复到独立 Compose
项目（独立数据卷、独立子网、不占用宿主机端口），恢复后通过真实 API 验收：
登录、题目读取、附件（支持包）下载与一次真实评测。

选项：
  --env-file FILE          生产环境文件（默认 .env.prod）
  --compose-file FILE      生产 Compose 文件（默认 docker-compose.prod.yml）
  --passphrase-file FILE   GPG 口令文件（权限必须为 600/400）
  --project-name NAME      演练 Compose 项目名（默认 noj-drill；禁止包含 prod）
  --drill-dir DIR          演练临时目录（默认自动创建于快照同级的 drill-* 目录）
  --report FILE            演练报告（默认写入 SNAPSHOT/restore-drill-report.txt）
  --subnet CIDR            演练网络子网（默认 172.29.0.0/16，避免与生产冲突）
  --rpo-max-hours N        RPO 目标：快照允许的最大时长（默认 24 小时）
  --rto-max-minutes N      RTO 目标：恢复+验收允许的最大时长（默认 60 分钟）
  --wait-timeout N         Compose 服务等待超时秒数（默认 300）
  --skip-judge             跳过真实评测（仍执行登录/题目/附件验收）
  --keep                   保留演练临时目录与 Compose 资源供人工检查
  -h, --help               显示帮助

环境变量：
  NOJ_BACKUP_PASSPHRASE_FILE   默认 GPG 口令文件
  NOJ_DRILL_PROJECT_NAME       默认演练项目名
  NOJ_DRILL_SUBNET             默认演练子网
  NOJ_DRILL_RPO_MAX_HOURS      默认 RPO 目标（小时）
  NOJ_DRILL_RTO_MAX_MINUTES    默认 RTO 目标（分钟）

说明：
  - 真实评测需要宿主机 judge 沙箱 Docker socket 与 noj-evaluator-python /
    noj-solution-python 镜像（与生产 judge 相同的独立 rootless daemon）。
  - 演练管理员账号由本脚本直接写入隔离演练数据库，仅存在于演练项目内。
  - 备份快照与解密口令文件应异地独立保存；口令丢失时快照无法恢复。
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

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

check_secret_file() {
  [[ -f "$1" ]] || die "GPG 口令文件不存在：$1"
  local mode
  mode="$(file_mode "$1")"
  [[ "$mode" == "600" || "$mode" == "400" ]] ||
    die "GPG 口令文件权限必须为 600 或 400：$1"
}

gpg_decrypt() {
  command -v gpg >/dev/null 2>&1 || die "解密环境备份需要 gpg"
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt --output "$2" "$1" >/dev/null 2>&1 || die "生产环境文件解密失败"
}

# pg_dumpall --globals-only 会包含 CREATE ROLE，而 Compose 启动的 PostgreSQL
# 已经通过 POSTGRES_USER 创建了默认角色；恢复前将角色创建语句改为幂等形式。
prepare_idempotent_globals() {
  local source="$1" target="$2"
  awk '
    function sql_escape(value) {
      gsub(/\047/, "\047\047", value)
      return value
    }
    /^CREATE ROLE / {
      identifier = substr($0, 13)
      sub(/;[[:space:]]*$/, "", identifier)
      name = identifier
      if (name ~ /^".*"$/) {
        name = substr(name, 2, length(name) - 2)
        gsub(/""/, "\"", name)
      }
      printf "DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \047%s\047) THEN CREATE ROLE %s; END IF; END $role$;\n", sql_escape(name), identifier
      next
    }
    { print }
  ' "$source" > "$target" || die "生成幂等 PostgreSQL 全局对象脚本失败"
}

compose() {
  local -a args=(compose --project-name "$PROJECT_NAME"
    --env-file "$COMPOSE_ENV_FILE"
    --file "$COMPOSE_FILE"
    --file "$TEMP_DIR/compose.drill-override.yml")
  if ((SKIP_JUDGE == 0)); then
    args+=(--profile judge)
  fi
  "$DOCKER_BIN" "${args[@]}" "$@"
}

# 统一退出处理：失败时回收演练资源并写失败报告；成功时仅清理临时目录。
on_exit() {
  local status=$?
  if ((status != 0)); then
    # 先写报告（需要读取验证日志），再回收资源，最后清理临时目录。
    write_failure_report "$status"
    if [[ -n "$COMPOSE_ENV_FILE" && "$KEEP" != "1" ]]; then
      warn "清理演练 Compose 资源（down -v）"
      local -a down_args=(compose --project-name "$PROJECT_NAME"
        --env-file "$COMPOSE_ENV_FILE"
        --file "$COMPOSE_FILE")
      if [[ -d "$TEMP_DIR" ]]; then
        down_args+=(--file "$TEMP_DIR/compose.drill-override.yml")
      fi
      "$DOCKER_BIN" "${down_args[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$DRILL_DIR" && -d "$DRILL_DIR" && "$KEEP" != "1" ]]; then
    rm -rf -- "$DRILL_DIR"
  fi
  exit "$status"
}

write_failure_report() {
  local status="$1"
  [[ -n "$REPORT" && "$STAGE" != "init" && "$STAGE" != "preflight" ]] || return 0
  {
    printf 'result=failed\n'
    printf 'drill_type=isolated-restore-with-business-verification\n'
    printf 'snapshot=%s\n' "$SNAPSHOT"
    printf 'failed_stage=%s\n' "$STAGE"
    printf 'drill_started_at=%s\n' "${DRILL_STARTED_AT:-unknown}"
    printf 'compose_project=%s\n' "$PROJECT_NAME"
    if [[ -f "$TEMP_DIR/verify-output.log" ]]; then
      printf '# ---- 业务验收输出（失败现场） ----\n'
      tail -n 50 "$TEMP_DIR/verify-output.log"
    fi
    printf 'cleanup=%s\n' "$([[ "$KEEP" == "1" ]] && printf 'kept-for-review' || printf 'done')"
    printf 'credential_note=备份快照与 GPG 口令文件应异地独立保存；口令丢失即无法恢复。\n'
  } > "$REPORT"
  chmod 600 "$REPORT"
  warn "演练在 ${STAGE} 阶段失败，报告：$REPORT"
}

validate_snapshot_path() {
  [[ -d "$1" ]] || die "快照目录不存在：$1"
  [[ "$(basename "$1")" == snapshot-* ]] || die "只允许演练 snapshot-* 快照目录"
  [[ "$1" != */..* && "$1" != */.snapshot-* ]] || die "非法快照路径"
}

parse_args() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  [[ "$#" -ge 1 ]] || { usage; exit 2; }
  SNAPSHOT="$1"
  shift
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --env-file) [[ "$#" -ge 2 ]] || die "--env-file 缺少参数"; ENV_FILE="$2"; shift 2 ;;
      --compose-file) [[ "$#" -ge 2 ]] || die "--compose-file 缺少参数"; COMPOSE_FILE="$2"; shift 2 ;;
      --passphrase-file) [[ "$#" -ge 2 ]] || die "--passphrase-file 缺少参数"; PASSPHRASE_FILE="$2"; shift 2 ;;
      --project-name) [[ "$#" -ge 2 ]] || die "--project-name 缺少参数"; PROJECT_NAME="$2"; shift 2 ;;
      --drill-dir) [[ "$#" -ge 2 ]] || die "--drill-dir 缺少参数"; DRILL_DIR="$2"; shift 2 ;;
      --report) [[ "$#" -ge 2 ]] || die "--report 缺少参数"; REPORT="$2"; shift 2 ;;
      --subnet) [[ "$#" -ge 2 ]] || die "--subnet 缺少参数"; SUBNET="$2"; shift 2 ;;
      --rpo-max-hours) [[ "$#" -ge 2 ]] || die "--rpo-max-hours 缺少参数"; RPO_MAX_HOURS="$2"; shift 2 ;;
      --rto-max-minutes) [[ "$#" -ge 2 ]] || die "--rto-max-minutes 缺少参数"; RTO_MAX_MINUTES="$2"; shift 2 ;;
      --wait-timeout) [[ "$#" -ge 2 ]] || die "--wait-timeout 缺少参数"; WAIT_TIMEOUT="$2"; shift 2 ;;
      --skip-judge) SKIP_JUDGE=1; shift ;;
      --keep) KEEP=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知选项：$1" ;;
    esac
  done
}

preflight() {
  STAGE="preflight"
  validate_snapshot_path "$SNAPSHOT"
  [[ -f "$SNAPSHOT/SUCCESS" ]] || die "快照缺少成功标记：$SNAPSHOT/SUCCESS"
  [[ -f "$SNAPSHOT/manifest.json" ]] || die "快照缺少 manifest.json"
  [[ -f "$SNAPSHOT/env.prod.gpg" ]] || die "快照缺少加密环境文件 env.prod.gpg"
  [[ -n "$PASSPHRASE_FILE" ]] || die "必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE"
  check_secret_file "$PASSPHRASE_FILE"
  [[ -f "$ENV_FILE" ]] || die "生产环境文件不存在：$ENV_FILE"
  [[ -f "$COMPOSE_FILE" ]] || die "生产 Compose 文件不存在：$COMPOSE_FILE"
  command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker daemon 不可用"
  [[ -f "$VERIFY_SCRIPT" ]] || die "缺少业务验收脚本：$VERIFY_SCRIPT"
  [[ "$PROJECT_NAME" != *prod* ]] || die "演练项目名不得包含 prod：$PROJECT_NAME"
  [[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    die "演练项目名只能包含小写字母、数字、- 和 _"
  [[ "$RPO_MAX_HOURS" =~ ^[0-9]+$ && "$RTO_MAX_MINUTES" =~ ^[0-9]+$ ]] ||
    die "RPO/RTO 目标必须是非负整数"

  # 文件级校验复用 backup.sh verify：损坏快照或口令错误在此直接失败。
  ok "执行快照文件校验（backup.sh verify）"
  NOJ_BACKUP_PASSPHRASE_FILE="$PASSPHRASE_FILE" \
  NOJ_BACKUP_DOCKER_BIN="$DOCKER_BIN" \
    bash "$SCRIPT_DIR/backup.sh" verify "$SNAPSHOT" \
    --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
    --passphrase-file "$PASSPHRASE_FILE" ||
    die "快照文件校验失败，中止演练"
}

prepare_directories() {
  STAGE="prepare"
  DRILL_STARTED_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  local timestamp index=1
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  if [[ -z "$DRILL_DIR" ]]; then
    DRILL_DIR="$(dirname "$SNAPSHOT")/drill-$timestamp"
    while [[ -e "$DRILL_DIR" ]]; do
      index=$((index + 1))
      DRILL_DIR="$(dirname "$SNAPSHOT")/drill-$timestamp-$index"
    done
  fi
  [[ ! -e "$DRILL_DIR" ]] || die "演练目录已存在：$DRILL_DIR"
  mkdir -m 700 -p "$DRILL_DIR"
  TEMP_DIR="$DRILL_DIR/.work"
  mkdir -m 700 "$TEMP_DIR"
  if [[ -z "$REPORT" ]]; then
    REPORT="$SNAPSHOT/restore-drill-report.txt"
  fi
  : > "$REPORT"
  chmod 600 "$REPORT"
  ok "演练目录：${DRILL_DIR}；报告：${REPORT}"
}

# 解密生产环境文件并叠加演练隔离配置（评测器网络名指向演练网络）。
prepare_env() {
  STAGE="prepare-env"
  COMPOSE_ENV_FILE="$TEMP_DIR/env.drill"
  gpg_decrypt "$SNAPSHOT/env.prod.gpg" "$COMPOSE_ENV_FILE"
  [[ -s "$COMPOSE_ENV_FILE" ]] || die "解密后的环境文件为空"
  chmod 600 "$COMPOSE_ENV_FILE"
  {
    printf '\n# ---- restore-drill 隔离覆盖（自动生成，勿提交） ----\n'
    printf 'JUDGE_EVALUATOR_NETWORK=%s_noj-net\n' "$PROJECT_NAME"
  } >> "$COMPOSE_ENV_FILE"
  ok "已解密环境文件并叠加演练隔离配置"
}

# 生成演练覆盖 Compose：仅改子网；数据卷沿用项目名前缀实现隔离。
prepare_compose_override() {
  STAGE="prepare-compose"
  cat > "$TEMP_DIR/compose.drill-override.yml" <<EOF
# restore-drill 自动生成的隔离覆盖：独立子网，避免与生产 noj-net 冲突。
services:
  verifier:
    image: denoland/deno:debian-2.9.5@sha256:5d46f925d213e9adaf18a0664b291fe973c91ba7b929572877610dcaaf09ee2b
    networks:
      - noj-net
networks:
  noj-net:
    ipam:
      config:
        - subnet: ${SUBNET}
EOF
  compose config --quiet || die "演练 Compose 配置无效"
  ok "演练 Compose 覆盖已生成（子网 ${SUBNET}）"
}

restore_data_services() {
  STAGE="restore-data"
  local pg_user pg_db
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"

  ok "启动隔离数据服务（postgres/redis/minio）"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres redis minio ||
    die "隔离数据服务启动失败"
  compose run --rm minio-init >/dev/null 2>&1 || die "MinIO bucket 初始化失败"

  ok "恢复 PostgreSQL"
  local globals_file="$TEMP_DIR/postgres-globals.sql"
  prepare_idempotent_globals "$SNAPSHOT/postgres-globals.sql" "$globals_file"
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" \
    < "$globals_file" || die "PostgreSQL 全局对象恢复失败"
  compose exec -T postgres pg_restore --clean --if-exists --no-owner --exit-on-error \
    -U "$pg_user" -d "$pg_db" - < "$SNAPSHOT/postgres.dump" ||
    die "PostgreSQL 数据恢复失败"

  ok "恢复 Redis"
  compose stop redis >/dev/null || die "停止 Redis 失败"
  compose run --rm --no-deps --entrypoint /bin/sh redis -c \
    'set -eu; rm -rf /data/appendonlydir /data/dump.rdb; cat > /data/dump.rdb' \
    < "$SNAPSHOT/redis.rdb" || die "写入 Redis RDB 失败"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" redis ||
    die "恢复后 Redis 启动失败"

  ok "恢复 MinIO/S3 对象"
  compose run --rm --no-deps --entrypoint /bin/sh -v "$SNAPSHOT/minio:/restore:ro" minio-init -c \
    'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc mirror --overwrite --remove /restore "local/$S3_BUCKET"' ||
    die "MinIO/S3 对象恢复失败"
}

# 数据核对：迁移版本、用户数、Redis 键数、对象数与快照一致性。
verify_data() {
  STAGE="verify-data"
  local pg_user pg_db
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"

  local expected_migrations actual_migrations
  expected_migrations="$(cat "$SNAPSHOT/migration-status.txt" 2>/dev/null || true)"
  actual_migrations="$(compose exec -T postgres psql -U "$pg_user" -d "$pg_db" -Atqc \
    "SELECT hash || ':' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at" 2>/dev/null || true)"
  [[ -n "$expected_migrations" && "$expected_migrations" != "not-initialized" ]] ||
    die "数据核对失败：快照缺少迁移状态记录"
  [[ "$expected_migrations" == "$actual_migrations" ]] ||
    die "数据核对失败：迁移版本与快照不一致"
  ok "数据核对：迁移版本与快照一致"

  local user_count
  user_count="$(compose exec -T postgres psql -U "$pg_user" -d "$pg_db" -Atqc \
    "SELECT count(*) FROM users" 2>/dev/null || true)"
  [[ "$user_count" =~ ^[0-9]+$ ]] || die "数据核对失败：无法读取用户数"
  ok "数据核对：恢复后用户数 ${user_count}"

  local redis_keys
  redis_keys="$(compose exec -T redis sh -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning DBSIZE' 2>/dev/null | tr -d '[:space:]')"
  [[ "$redis_keys" =~ ^[0-9]+$ ]] || redis_keys=0
  ok "数据核对：Redis 键数 ${redis_keys}"

  local snapshot_objects restored_objects bucket
  bucket="$(env_value S3_BUCKET)"; bucket="${bucket:-noj-support-packages}"
  snapshot_objects="$(find "$SNAPSHOT/minio" -type f ! -name 'sha256sums.txt' 2>/dev/null | wc -l | tr -d ' ')"
  restored_objects="$(compose run --rm --no-deps --entrypoint /bin/sh minio-init -c \
    'set -eu; for i in $(seq 1 30); do mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break; sleep 2; done; mc ls --recursive --json "local/$S3_BUCKET" | wc -l' 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
  [[ "$restored_objects" =~ ^[0-9]+$ ]] || die "数据核对失败：无法读取恢复后的对象数"
  ((restored_objects >= snapshot_objects)) ||
    die "数据核对失败：MinIO 对象数少于快照（快照 ${snapshot_objects} / 恢复 ${restored_objects}）"
  ok "数据核对：MinIO 对象数 快照 ${snapshot_objects} / 恢复 ${restored_objects}"

  {
    printf 'restore_data_check=passed\n'
    printf 'restored_user_count=%s\n' "$user_count"
    printf 'restored_redis_keys=%s\n' "$redis_keys"
    printf 'snapshot_object_count=%s\n' "$snapshot_objects"
    printf 'restored_object_count=%s\n' "$restored_objects"
  } > "$TEMP_DIR/checks.env"
}

# 演练管理员：直接写入隔离演练库并授予 admin 角色（不影响生产）。
seed_drill_admin() {
  STAGE="seed-admin"
  local pg_user pg_db
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"
  local now
  now="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"

  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" <<SQL ||
INSERT INTO users (id, username, email, email_verified, password_hash, created_at, updated_at)
VALUES ('drill-admin-user', '${DRILL_ADMIN_USER}', 'drill-admin@${DRILL_ADMIN_EMAIL_DOMAIN}',
        true, '${DRILL_BCRYPT_HASH}', '${now}', '${now}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO user_roles (user_id, role_id)
SELECT 'drill-admin-user', id FROM roles WHERE name = 'admin'
ON CONFLICT DO NOTHING;
SQL
  die "写入演练管理员失败"
  ok "演练管理员已写入隔离数据库"
}

start_business_services() {
  STAGE="start-business"
  ok "执行迁移并启动 core"
  compose run --rm migrate >/dev/null 2>&1 || die "隔离环境迁移失败"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" core ||
    die "隔离 core 启动失败"

  if ((SKIP_JUDGE)); then
    warn "跳过 judge（--skip-judge）：演练不包含真实评测"
    return 0
  fi

  ok "启动 judge（使用与生产相同的独立沙箱 daemon）"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" judge ||
    die "隔离 judge 启动失败"
  ensure_judge_images
}

# 确认 judge_images 白名单包含演练所需镜像（只读取既有数据，不写入）。
ensure_judge_images() {
  local pg_user pg_db
  pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-noj}"
  pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-noj}"

  DRILL_EVALUATOR_IMAGE="$(compose exec -T postgres psql -U "$pg_user" -d "$pg_db" -Atqc \
    "SELECT image FROM judge_images WHERE kind = 'evaluator' ORDER BY CASE WHEN image LIKE '%noj-evaluator-python%' THEN 0 ELSE 1 END, created_at DESC LIMIT 1" 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  DRILL_SOLUTION_IMAGE="$(compose exec -T postgres psql -U "$pg_user" -d "$pg_db" -Atqc \
    "SELECT image FROM judge_images WHERE kind = 'solution' ORDER BY CASE WHEN image LIKE '%noj-solution-python%' THEN 0 ELSE 1 END, created_at DESC LIMIT 1" 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  [[ -n "$DRILL_EVALUATOR_IMAGE" ]] || die "judge_images 白名单缺少 evaluator 镜像"
  [[ -n "$DRILL_SOLUTION_IMAGE" ]] || die "judge_images 白名单缺少 solution 镜像"
  ok "评测镜像：evaluator=${DRILL_EVALUATOR_IMAGE} solution=${DRILL_SOLUTION_IMAGE}"
}

run_business_verification() {
  STAGE="business-verify"
  ok "运行业务验收（登录/题目/附件/评测）"
  local -a compose_args=(run --rm --no-deps
    -e "DRILL_BASE_URL=http://core:8000/api/v1"
    -e "DRILL_ADMIN_USER=${DRILL_ADMIN_USER}"
    -e "DRILL_ADMIN_PASSWORD=${DRILL_ADMIN_PASSWORD}"
    -e "DRILL_EVALUATOR_IMAGE=${DRILL_EVALUATOR_IMAGE:-${DEFAULT_EVALUATOR_IMAGE}}"
    -e "DRILL_SOLUTION_IMAGE=${DRILL_SOLUTION_IMAGE:-${DEFAULT_SOLUTION_IMAGE}}")
  ((SKIP_JUDGE)) && compose_args+=(-e "DRILL_SKIP_EVALUATION=1") || true
  local status=0
  compose "${compose_args[@]}" \
    -v "$VERIFY_SCRIPT:/opt/verify.ts:ro" \
    verifier deno run -A /opt/verify.ts 2>&1 | tee "$TEMP_DIR/verify-output.log" || status=$?
  ((status == 0)) || die "业务验收未通过"
}

snapshot_created_at() {
  awk 'match($0, /"created_at"[[:space:]]*:[[:space:]]*"[^"]+"/) {
    value = substr($0, RSTART, RLENGTH)
    sub(/^.*:[[:space:]]*"/, "", value)
    sub(/"$/, "", value)
    print value
    exit
  }' "$SNAPSHOT/manifest.json"
}

hours_since_snapshot() {
  local created epoch_created epoch_now
  created="$(snapshot_created_at)"
  epoch_created="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$created" '+%s' 2>/dev/null ||
    date -d "$created" '+%s' 2>/dev/null || echo 0)"
  epoch_now="$(date '+%s')"
  awk -v a="$epoch_created" -v b="$epoch_now" 'BEGIN { printf "%.2f", (b - a) / 3600 }'
}

write_report() {
  STAGE="report"
  local rto_minutes="$1" restore_seconds="$2" total_seconds="$3"
  local finished_at rpo_hours rpo_met rto_met result
  finished_at="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  rpo_hours="$(hours_since_snapshot)"
  rpo_met="true"; rto_met="true"; result="passed"
  awk -v v="$rpo_hours" -v max="$RPO_MAX_HOURS" 'BEGIN { exit (v <= max) ? 0 : 1 }' ||
    rpo_met="false"
  (( RTO_MAX_MINUTES >= rto_minutes )) || rto_met="false"
  [[ "$rpo_met" == "true" && "$rto_met" == "true" ]] || result="passed_with_warnings"

  {
    printf 'result=%s\n' "$result"
    printf 'drill_type=isolated-restore-with-business-verification\n'
    printf 'snapshot=%s\n' "$SNAPSHOT"
    printf 'snapshot_created_at=%s\n' "$(snapshot_created_at)"
    printf 'drill_started_at=%s\n' "$DRILL_STARTED_AT"
    printf 'drill_finished_at=%s\n' "$finished_at"
    printf 'restore_duration_seconds=%s\n' "$restore_seconds"
    printf 'total_duration_seconds=%s\n' "$total_seconds"
    printf 'rpo_hours=%s\n' "$rpo_hours"
    printf 'rpo_target_hours=%s\n' "$RPO_MAX_HOURS"
    printf 'rpo_met=%s\n' "$rpo_met"
    printf 'rto_minutes=%s\n' "$rto_minutes"
    printf 'rto_target_minutes=%s\n' "$RTO_MAX_MINUTES"
    printf 'rto_met=%s\n' "$rto_met"
    printf 'compose_project=%s\n' "$PROJECT_NAME"
    printf 'network_subnet=%s\n' "$SUBNET"
    if [[ -f "$TEMP_DIR/checks.env" ]]; then
      cat "$TEMP_DIR/checks.env"
    fi
    if [[ -f "$TEMP_DIR/verify-output.log" ]]; then
      printf '# ---- 业务验收明细 ----\n'
      cat "$TEMP_DIR/verify-output.log"
    fi
    printf 'cleanup=%s\n' "$([[ "$KEEP" == "1" ]] && printf 'kept-for-review' || printf 'done')"
    printf 'credential_note=备份快照与 GPG 口令文件应异地独立保存；口令丢失即无法恢复。\n'
  } > "$REPORT"
  chmod 600 "$REPORT"
  write_drill_metrics
}

# 输出 Prometheus textfile 指标，供告警检测"恢复演练长期未执行"。
write_drill_metrics() {
  local metrics_dir="${NOJ_BACKUP_METRICS_DIR:-$(dirname "$SNAPSHOT")/metrics}"
  mkdir -m 755 -p "$metrics_dir"
  {
    printf '# HELP noj_restore_drill_last_success_unix_time 最近一次隔离恢复演练成功的 Unix 时间戳。\n'
    printf '# TYPE noj_restore_drill_last_success_unix_time gauge\n'
    printf 'noj_restore_drill_last_success_unix_time %s\n' "$(date '+%s')"
  } > "$metrics_dir/noj_restore_drill.prom"
  chmod 644 "$metrics_dir/noj_restore_drill.prom"
}

main() {
  parse_args "$@"
  preflight

  local restore_start restore_end restore_seconds total_start total_seconds rto_minutes
  total_start="$(date '+%s')"
  prepare_directories
  prepare_env
  prepare_compose_override
  restore_start="$(date '+%s')"
  restore_data_services
  verify_data
  restore_end="$(date '+%s')"
  restore_seconds=$((restore_end - restore_start))

  seed_drill_admin
  start_business_services
  run_business_verification
  total_seconds=$(( $(date '+%s') - total_start ))
  rto_minutes=$((total_seconds / 60))

  STAGE="report"
  write_report "$rto_minutes" "$restore_seconds" "$total_seconds"
  if [[ "$KEEP" != "1" ]]; then
    "$DOCKER_BIN" compose --project-name "$PROJECT_NAME" \
      --env-file "$COMPOSE_ENV_FILE" --file "$COMPOSE_FILE" \
      --file "$TEMP_DIR/compose.drill-override.yml" \
      down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  ok "隔离恢复演练通过，报告已写入：$REPORT"
}

trap on_exit EXIT
main "$@"
