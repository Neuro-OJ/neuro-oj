#!/usr/bin/env bash
# backup-schedule.sh 的无系统 cron 依赖测试。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-backup-schedule-test.XXXXXX")"
CRONTAB_FILE="$TEST_ROOT/crontab"
FAKE_CRONTAB="$TEST_ROOT/crontab-bin"
ENV_FILE="$TEST_ROOT/.env.prod"
COMPOSE_FILE="$TEST_ROOT/docker-compose.prod.yml"
PASSPHRASE_FILE="$TEST_ROOT/passphrase"
BACKUP_DIR="$TEST_ROOT/backups"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

cat >"$FAKE_CRONTAB" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "-l" ]]; then
  [[ -f "${NOJ_TEST_CRONTAB_FILE:?}" ]] || exit 1
  cat "$NOJ_TEST_CRONTAB_FILE"
elif [[ "${1:-}" == "-" ]]; then
  cat >"${NOJ_TEST_CRONTAB_FILE:?}"
else
  exit 2
fi
EOF
chmod 700 "$FAKE_CRONTAB"
printf 'NOJ_VERSION=v0.1.0\n' >"$ENV_FILE"
chmod 600 "$ENV_FILE"
printf 'services:\n  fake:\n    image: alpine:3\n' >"$COMPOSE_FILE"
printf 'test-passphrase\n' >"$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"
mkdir -m 700 "$BACKUP_DIR"
printf '%s\n' '# unrelated host task' '0 4 * * * /usr/local/bin/other-job' >"$CRONTAB_FILE"

run_schedule() {
  NOJ_BACKUP_CRONTAB_BIN="$FAKE_CRONTAB" \
  NOJ_TEST_CRONTAB_FILE="$CRONTAB_FILE" \
    bash "$SCRIPT_DIR/backup-schedule.sh" "$@"
}

run_schedule install \
  --schedule '30 3 * * *' \
  --env-file "$ENV_FILE" \
  --compose-file "$COMPOSE_FILE" \
  --backup-dir "$BACKUP_DIR" \
  --passphrase-file "$PASSPHRASE_FILE" >/dev/null || fail "安装调度失败"

rg -Fq '# BEGIN NEURO-OJ BACKUP (managed)' "$CRONTAB_FILE" || fail "缺少调度开始标记"
rg -Fq '30 3 * * *' "$CRONTAB_FILE" || fail "没有写入自定义调度"
rg -Fq '# unrelated host task' "$CRONTAB_FILE" || fail "覆盖了宿主机原有 cron 任务"
[[ "$(rg -c 'BEGIN NEURO-OJ BACKUP' "$CRONTAB_FILE")" == 1 ]] || fail "调度区块重复"
[[ "$(stat -c '%a' "$BACKUP_DIR/backup-cron.log" 2>/dev/null || stat -f '%Lp' "$BACKUP_DIR/backup-cron.log")" == 600 ]] || fail "备份日志权限不安全"
pass "安装并保留原有 cron 任务"

run_schedule install \
  --schedule '45 4 * * *' \
  --env-file "$ENV_FILE" \
  --compose-file "$COMPOSE_FILE" \
  --backup-dir "$BACKUP_DIR" \
  --passphrase-file "$PASSPHRASE_FILE" >/dev/null || fail "更新调度失败"
[[ "$(rg -c 'BEGIN NEURO-OJ BACKUP' "$CRONTAB_FILE")" == 1 ]] || fail "更新后调度区块重复"
rg -Fq '45 4 * * *' "$CRONTAB_FILE" || fail "更新后的调度未生效"
! rg -Fq '30 3 * * *' "$CRONTAB_FILE" || fail "旧调度仍然存在"
pass "更新调度不产生重复任务"

run_schedule status >/dev/null || fail "status 未识别已安装任务"
run_schedule remove >/dev/null || fail "删除调度失败"
! rg -Fq 'NEURO-OJ BACKUP' "$CRONTAB_FILE" || fail "删除后仍存在调度区块"
rg -Fq '# unrelated host task' "$CRONTAB_FILE" || fail "删除时误删原有 cron 任务"
pass "查看和删除调度"

set +e
run_schedule install --schedule '15 2 * * *; touch /tmp/unsafe' \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  --backup-dir "$BACKUP_DIR" --passphrase-file "$PASSPHRASE_FILE" >/dev/null 2>&1
status=$?
set -e
[[ "$status" != 0 ]] || fail "危险 cron 表达式未被拒绝"
pass "拒绝 shell 元字符"

printf '全部备份调度测试通过\n'
