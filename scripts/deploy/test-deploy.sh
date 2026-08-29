#!/usr/bin/env bash
# deploy.sh 的无 Docker 生产资源测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-deploy-test.XXXXXX")"
FAKE_DOCKER="$TEST_ROOT/fake-docker"
FAKE_LOG="$TEST_ROOT/docker.log"
ENV_FILE="$TEST_ROOT/.env.prod"
COMPOSE_FILE="$TEST_ROOT/docker-compose.prod.yml"
PASSPHRASE_FILE="$TEST_ROOT/passphrase"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

cat >"$FAKE_DOCKER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NOJ_DEPLOY_TEST_LOG:?}"
if [[ "${NOJ_DEPLOY_TEST_FAIL:-}" == "up" && " $* " == *" up "* ]]; then
  exit 23
fi
if [[ "${NOJ_BACKUP_TEST_FAIL:-}" == "redis" && " $* " == *" redis "* ]]; then
  exit 31
fi
if [[ "${1:-}" == "info" ]]; then
  exit 0
elif [[ "${1:-}" == "buildx" && "${2:-}" == "version" ]]; then
  exit 0
elif [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "inspect" ]]; then
  printf 'Digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
elif [[ "${1:-}" == "compose" && " $* " == *" pg_dumpall "* ]]; then
  printf 'CREATE ROLE noj;\n'
elif [[ "${1:-}" == "compose" && " $* " == *" pg_dump "* ]]; then
  printf 'fake postgres dump\n'
elif [[ "${1:-}" == "compose" && "$*" == *"pg_restore --list"* ]]; then
  printf '1; TABLE public users noj\n'
elif [[ "${1:-}" == "compose" && "$*" == *"to_regclass"* ]]; then
  printf 'drizzle.__drizzle_migrations\n'
elif [[ "${1:-}" == "compose" && " $* " == *" psql "* ]]; then
  printf 'migration-hash:2026-08-26\n'
elif [[ "${1:-}" == "compose" && "$*" == *"--rdb -"* ]]; then
  printf 'fake redis rdb\n'
elif [[ "${1:-}" == "compose" && "$*" == *"INFO persistence"* ]]; then
  printf 'aof_enabled:1\n'
fi
EOF
chmod +x "$FAKE_DOCKER"

cat >"$ENV_FILE" <<'EOF'
NOJ_VERSION=v0.1.0
NOJ_ENFORCE_IMAGE_SIGNATURES=false
APP_URL=https://noj.test
CORS_ALLOWED_ORIGINS=https://noj.test
TRUSTED_PROXIES=172.28.0.0/16
POSTGRES_PASSWORD=strong-postgres-password
POSTGRES_USER=noj
POSTGRES_DB=noj
REDIS_PASSWORD=strong-redis-password
MINIO_ROOT_USER=minio-root
MINIO_ROOT_PASSWORD=strong-minio-password
S3_ACCESS_KEY=noj-storage
S3_SECRET_KEY=strong-storage-password
S3_BUCKET=noj-support-packages
S3_ENDPOINT=http://minio:9000
STORAGE_PROVIDER=s3
JWT_SECRET=strong-random-jwt-secret-value-1234567890
TFA_ENCRYPTION_KEY=strong-random-tfa-secret-value-1234567890
NOJ_LLM_SERVICE_TOKEN=strong-llm-service-token
NOJ_LLM_STORE_KEY=strong-llm-store-key
ADMIN_EMAIL=admin@noj.test
ADMIN_PASS=strong-admin-password
EMAIL_PROVIDER=aliyun
ALIBABA_ACCESS_KEY_ID=aliyun-id
ALIBABA_ACCESS_KEY_SECRET=aliyun-secret
ALIBABA_FROM_EMAIL=admin@noj.test
JUDGE_DOCKER_SOCKET=__TEST_ROOT__/isolated-docker.sock
JUDGE_DOCKER_SOCKET_GID=10001
NGINX_PORT=18080
EOF
sed -i.bak "s#__TEST_ROOT__#$TEST_ROOT#g" "$ENV_FILE"
touch "$TEST_ROOT/isolated-docker.sock"
chmod 600 "$ENV_FILE"
printf 'services:\n  fake:\n    image: alpine:3\n' >"$COMPOSE_FILE"
printf 'test-passphrase\n' >"$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"

run_deploy_with() {
  local env_file="$1"
  shift
  NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" \
  NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  NOJ_BACKUP_TEST_LOG="$FAKE_LOG" \
  NOJ_BACKUP_PASSPHRASE_FILE="$PASSPHRASE_FILE" \
  NOJ_BACKUP_TEST_FAIL="${NOJ_BACKUP_TEST_FAIL:-}" \
  PATH="$TEST_ROOT:$PATH" \
    bash "$DEPLOY_SCRIPT" "$@" --env-file "$env_file" --compose-file "$COMPOSE_FILE"
}

run_deploy() {
  run_deploy_with "$ENV_FILE" "$@"
}

[[ "$(bash "$DEPLOY_SCRIPT" --help)" == *"生产部署工具"* ]] || fail "帮助输出缺少工具标题"
pass "帮助输出"

panel_root="$TEST_ROOT/baota/www/server/panel"
mkdir -p "$panel_root"
NOJ_DEPLOY_PANEL_ROOT="$panel_root" run_deploy start \
  >"$TEST_ROOT/panel-auto.out" 2>&1 || fail "deploy.sh 宝塔自动检测不应失败"
grep -q '宝塔兼容模式' "$TEST_ROOT/panel-auto.out" || fail "deploy.sh 宝塔自动检测提示缺失"
grep -q '127.0.0.1:NGINX_PORT' "$TEST_ROOT/panel-auto.out" || fail "deploy.sh 面板端口提示缺失"
NOJ_DEPLOY_PANEL_ROOT="$panel_root" run_deploy start --panel none \
  >"$TEST_ROOT/panel-none.out" 2>&1 || fail "deploy.sh --panel none 不应失败"
if grep -q '宝塔兼容模式' "$TEST_ROOT/panel-none.out"; then
  fail "deploy.sh --panel none 不应输出宝塔提示"
fi
NOJ_DEPLOY_PANEL_ROOT="$TEST_ROOT/missing-panel" run_deploy start --panel baota \
  >"$TEST_ROOT/panel-force.out" 2>&1 || fail "deploy.sh --panel baota 不应失败"
grep -q '宝塔兼容模式' "$TEST_ROOT/panel-force.out" || fail "deploy.sh --panel baota 提示缺失"
pass "deploy.sh 面板自动、强制和关闭模式"

new_env="$TEST_ROOT/new.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" install --env-file "$new_env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/install.out" 2>"$TEST_ROOT/install.err"; then
  fail "首次初始化应该提示补齐配置并返回非零"
fi
[[ -f "$new_env" ]] || fail "首次初始化未创建配置文件"
[[ "$(file_mode "$new_env")" == "600" ]] ||
  fail "新建配置文件权限不是 600"
non_interactive_env="$TEST_ROOT/non-interactive.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" install --non-interactive --env-file "$non_interactive_env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/non-interactive.out" 2>"$TEST_ROOT/non-interactive.err"; then
  fail "--non-interactive 首次初始化应该返回非零"
fi
grep -q '没有可交互终端' "$TEST_ROOT/non-interactive.err" ||
  fail "--non-interactive 未给出明确的配置提示"
[[ "$(file_mode "$non_interactive_env")" == "600" ]] ||
  fail "--non-interactive 配置文件权限不是 600"
pass "非交互式首次配置提示"
grep -q '^JWT_SECRET=' "$new_env" || fail "首次初始化未写入随机密钥"
if grep -q '^JWT_SECRET=change-' "$new_env"; then fail "首次初始化仍保留 JWT 占位值"; fi
pass "首次配置初始化与权限保护"

if run_deploy start >/dev/null 2>"$TEST_ROOT/start.err"; then
  :
else
  fail "合法配置的 start 不应失败"
fi
grep -q 'compose.*up -d --wait' "$FAKE_LOG" || fail "start 未调用 Compose 健康等待"
if grep -q 'down -v' "$FAKE_LOG"; then fail "部署脚本不得删除数据卷"; fi
pass "启动参数与数据卷安全边界"

run_deploy stop >/dev/null 2>"$TEST_ROOT/stop.err" || fail "合法配置的 stop 不应失败"
grep -q 'compose.*stop' "$FAKE_LOG" || fail "stop 未调用 Compose stop"
run_deploy upgrade >/dev/null 2>"$TEST_ROOT/upgrade.err" || fail "合法配置的 upgrade 不应失败"
grep -q 'compose.*pull' "$FAKE_LOG" || fail "upgrade 未拉取镜像"
upgrade_failure_log_lines="$(wc -l <"$FAKE_LOG")"
set +e
NOJ_BACKUP_TEST_FAIL=redis run_deploy upgrade >/dev/null 2>"$TEST_ROOT/upgrade-backup-failure.err"
upgrade_backup_status=$?
set -e
[[ "$upgrade_backup_status" != "0" ]] || fail "升级前备份失败未阻断升级"
if tail -n +$((upgrade_failure_log_lines + 1)) "$FAKE_LOG" | grep -E ' pull| up ' >/dev/null; then
  fail "升级前备份失败后仍执行了镜像拉取或启动"
fi
pass "升级前备份门禁"
run_deploy logs core >/dev/null 2>"$TEST_ROOT/logs.err" || fail "合法配置的 logs 不应失败"
grep -q 'compose.*logs.*core' "$FAKE_LOG" || fail "logs 未传递服务名"
log_lines_before="$(wc -l <"$FAKE_LOG")"
run_deploy upgrade --dry-run >/dev/null 2>"$TEST_ROOT/dry-run.err" || fail "合法配置的 dry-run 不应失败"
if tail -n +$((log_lines_before + 1)) "$FAKE_LOG" | grep -E ' pull| up ' >/dev/null; then
  fail "dry-run 不应执行 Compose 变更操作"
fi
pass "生命周期命令"

set +e
NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" \
NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
NOJ_DEPLOY_TEST_FAIL=up \
  bash "$DEPLOY_SCRIPT" start --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/failed.out" 2>"$TEST_ROOT/failed.err"
failed_status=$?
set -e
[[ "$failed_status" != "0" ]] || fail "Compose 失败未传递为部署失败"
pass "Compose 失败状态传递"

cp "$ENV_FILE" "$TEST_ROOT/unsafe.env"
sed -i.bak 's#JUDGE_DOCKER_SOCKET=.*#JUDGE_DOCKER_SOCKET=/var/run/docker.sock#' "$TEST_ROOT/unsafe.env"
chmod 600 "$TEST_ROOT/unsafe.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" start --env-file "$TEST_ROOT/unsafe.env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/unsafe.out" 2>"$TEST_ROOT/unsafe.err"; then
  fail "应用宿主机 Docker socket 应该被拒绝"
fi
grep -q '应用宿主机 Docker socket' "$TEST_ROOT/unsafe.err" || fail "危险 socket 错误提示缺失"
pass "Judge Docker socket 隔离检查"

cp "$ENV_FILE" "$TEST_ROOT/missing-socket.env"
sed -i.bak "s#JUDGE_DOCKER_SOCKET=.*#JUDGE_DOCKER_SOCKET=$TEST_ROOT/missing.sock#" "$TEST_ROOT/missing-socket.env"
chmod 600 "$TEST_ROOT/missing-socket.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" start --env-file "$TEST_ROOT/missing-socket.env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/missing-socket.out" 2>"$TEST_ROOT/missing-socket.err"; then
  fail "缺失的 Judge Docker socket 应该被拒绝"
fi
grep -q 'Docker socket 不存在' "$TEST_ROOT/missing-socket.err" || fail "缺失 socket 错误提示缺失"
pass "Judge Docker socket 存在性检查"

cp "$ENV_FILE" "$TEST_ROOT/invalid.env"
sed -i.bak 's/NOJ_VERSION=v0.1.0/NOJ_VERSION=change-me-release-tag/' "$TEST_ROOT/invalid.env"
chmod 600 "$TEST_ROOT/invalid.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" start --env-file "$TEST_ROOT/invalid.env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/invalid.out" 2>"$TEST_ROOT/invalid.err"; then
  fail "占位配置应该失败"
fi
grep -q 'NOJ_VERSION' "$TEST_ROOT/invalid.err" || fail "占位配置错误未指出配置键"
if grep -q 'strong-' "$TEST_ROOT/invalid.err" "$TEST_ROOT/invalid.out"; then
  fail "配置检查输出泄露了 secret"
fi
pass "占位配置拒绝与 secret 不泄露"

cp "$ENV_FILE" "$TEST_ROOT/mutable-version.env"
sed -i.bak 's/NOJ_VERSION=v0.1.0/NOJ_VERSION=latest/' "$TEST_ROOT/mutable-version.env"
chmod 600 "$TEST_ROOT/mutable-version.env"
if NOJ_DEPLOY_DOCKER_BIN="$FAKE_DOCKER" NOJ_DEPLOY_TEST_LOG="$FAKE_LOG" \
  bash "$DEPLOY_SCRIPT" start --env-file "$TEST_ROOT/mutable-version.env" --compose-file "$COMPOSE_FILE" \
  >"$TEST_ROOT/mutable-version.out" 2>"$TEST_ROOT/mutable-version.err"; then
  fail "latest 版本应该被拒绝"
fi
grep -q '不可变 Release 标签' "$TEST_ROOT/mutable-version.err" ||
  fail "latest 版本错误提示缺失"
pass "可变 Release 标签拒绝"

cat >"$TEST_ROOT/cosign" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/cosign"
cp "$ENV_FILE" "$TEST_ROOT/signed.env"
sed -i.bak 's/NOJ_ENFORCE_IMAGE_SIGNATURES=false/NOJ_ENFORCE_IMAGE_SIGNATURES=true/' "$TEST_ROOT/signed.env"
chmod 600 "$TEST_ROOT/signed.env"
run_deploy_with "$TEST_ROOT/signed.env" start --backup-dir "$TEST_ROOT/signed-backups" \
  >/dev/null 2>"$TEST_ROOT/signed.err" || fail "合法签名配置的 start 不应失败"
manifest="$TEST_ROOT/signed-backups/current-deployment.txt"
[[ -f "$manifest" ]] || fail "成功部署未记录当前版本与镜像 digest"
grep -q '^version=v0.1.0$' "$manifest" || fail "部署记录缺少版本"
[[ "$(grep -c '^noj-' "$manifest")" -eq 6 ]] || fail "部署记录未包含六个镜像 digest"
pass "签名校验与部署 digest 记录"

if run_deploy backup --backup-dir "$TEST_ROOT/backups" >/dev/null 2>"$TEST_ROOT/backup.err"; then
  :
else
  fail "合法配置的 backup 不应失败"
fi
snapshot="$(find "$TEST_ROOT/backups" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' -print -quit)"
[[ -n "$snapshot" ]] || fail "未生成完整生产快照"
[[ -f "$snapshot/postgres.dump" && -f "$snapshot/redis.rdb" && -f "$snapshot/env.prod.gpg" ]] ||
  fail "完整快照缺少核心数据"
[[ "$(file_mode "$snapshot")" == "700" ]] ||
  fail "快照目录权限不是 700"
pass "完整生产备份与文件权限"

printf '全部部署脚本测试通过\n'
