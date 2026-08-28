#!/usr/bin/env bash
# backup.sh 的无 Docker 生产备份、校验和恢复安全边界测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-backup-test.XXXXXX")"
FAKE_DOCKER="$TEST_ROOT/fake-docker"
FAKE_LOG="$TEST_ROOT/docker.log"
ENV_FILE="$TEST_ROOT/.env.prod"
COMPOSE_FILE="$TEST_ROOT/docker-compose.prod.yml"
PASSPHRASE_FILE="$TEST_ROOT/passphrase"
BACKUP_DIR="$TEST_ROOT/backups"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

cat >"$FAKE_DOCKER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NOJ_BACKUP_TEST_LOG:?}"
if [[ "${1:-}" == "info" ]]; then
  exit 0
fi
if [[ "${NOJ_BACKUP_TEST_FAIL:-}" == "redis" && " $* " == *" redis "* ]]; then
  exit 31
fi
if [[ "${1:-}" == "compose" && " $* " == *" pg_dumpall "* ]]; then
  printf 'CREATE ROLE noj;\n'
elif [[ "${1:-}" == "compose" && " $* " == *" pg_dump "* ]]; then
  printf 'fake postgres dump\n'
elif [[ "${1:-}" == "compose" && "$*" == *"pg_restore --list"* ]]; then
  printf ';
; Archive created at 2026-08-26
1; TABLE public users noj
'
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
POSTGRES_USER=noj
POSTGRES_DB=noj
POSTGRES_PASSWORD=strong-postgres-password
REDIS_PASSWORD=strong-redis-password
MINIO_ROOT_USER=minio-root
MINIO_ROOT_PASSWORD=strong-minio-password
S3_BUCKET=noj-support-packages
EOF
chmod 600 "$ENV_FILE"
printf 'services:\n  fake:\n    image: alpine:3\n' >"$COMPOSE_FILE"
printf 'test-passphrase\n' >"$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"

run_backup() {
  NOJ_BACKUP_DOCKER_BIN="$FAKE_DOCKER" \
  NOJ_BACKUP_TEST_LOG="$FAKE_LOG" \
    bash "$BACKUP_SCRIPT" "$@" \
      --env-file "$ENV_FILE" \
      --compose-file "$COMPOSE_FILE" \
      --backup-dir "$BACKUP_DIR" \
      --passphrase-file "$PASSPHRASE_FILE" \
      --min-free-mb 0
}

run_backup create >/dev/null 2>"$TEST_ROOT/create.err" || {
  cat "$TEST_ROOT/create.err" >&2
  fail "完整备份创建失败"
}
snapshot="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' -print -quit)"
[[ -n "$snapshot" ]] || fail "未生成快照目录"
for required in postgres.dump postgres-globals.sql postgres.restore-list redis.rdb redis-persistence.txt minio env.prod.gpg manifest.json migration-status.txt sha256sums.txt SUCCESS; do
  [[ -e "$snapshot/$required" ]] || fail "快照缺少文件：$required"
done
[[ "$(stat -f '%Lp' "$snapshot" 2>/dev/null || stat -c '%a' "$snapshot")" == "700" ]] ||
  fail "快照目录权限不是 700"
if grep -R -q 'strong-postgres-password\|strong-redis-password\|strong-minio-password' "$snapshot"; then
  fail "快照明文泄露生产凭据"
fi
pass "完整快照与秘密保护"

run_backup verify "$snapshot" >/dev/null || fail "快照校验失败"
cp "$snapshot/manifest.json" "$TEST_ROOT/manifest.json"
printf 'tampered\n' >>"$snapshot/manifest.json"
set +e
run_backup verify "$snapshot" >/dev/null 2>"$TEST_ROOT/tamper.err"
tamper_status=$?
set -e
mv "$TEST_ROOT/manifest.json" "$snapshot/manifest.json"
[[ "$tamper_status" != "0" ]] || fail "快照篡改未被校验发现"
report="$TEST_ROOT/restore-drill.txt"
run_backup drill "$snapshot" --report "$report" >/dev/null || fail "恢复演练校验失败"
grep -q '^result=verified$' "$report" || fail "恢复演练报告缺少成功结果"
pass "SHA-256、GPG 和恢复演练校验"

run_backup restore "$snapshot" --confirm --project-name isolated-backup >/dev/null ||
  fail "隔离 Compose 恢复编排失败"
pass "显式确认后的恢复编排"

old_snapshot="$BACKUP_DIR/snapshot-20200101-000000"
mkdir -p "$old_snapshot"
touch -t 202001010000 "$old_snapshot"
run_backup create --retention-days 30 >/dev/null || fail "保留策略测试备份失败"
[[ ! -e "$old_snapshot" ]] || fail "过期快照未被清理"
pass "快照保留策略"

before_count="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' | wc -l | tr -d ' ')"
set +e
NOJ_BACKUP_TEST_FAIL=redis run_backup create >/dev/null 2>"$TEST_ROOT/component-failure.err"
failed_status=$?
set -e
[[ "$failed_status" != "0" ]] || fail "组件失败未返回非零状态"
after_count="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' | wc -l | tr -d ' ')"
[[ "$before_count" == "$after_count" ]] || fail "组件失败产生了不完整快照"
pass "组件失败状态与原子性"

set +e
run_backup restore "$snapshot" >/dev/null 2>"$TEST_ROOT/restore-confirm.err"
confirm_status=$?
set -e
[[ "$confirm_status" != "0" ]] || fail "未确认的恢复应该失败"
grep -q -- '--confirm' "$TEST_ROOT/restore-confirm.err" || fail "恢复确认提示缺失"
pass "恢复破坏性操作确认"

printf '全部备份脚本测试通过\n'
