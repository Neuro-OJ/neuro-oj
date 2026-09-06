#!/usr/bin/env bash
# restore-drill.sh 的无 Docker 隔离恢复演练测试：fake docker 模拟 Compose 全链路。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
DRILL_SCRIPT="$SCRIPT_DIR/restore-drill.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-drill-test.XXXXXX")"
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

# ---------------------------------------------------------------------------
# fake docker：记录全部调用并模拟 Compose/psql/redis-cli/mc 行为。
# ---------------------------------------------------------------------------
cat >"$FAKE_DOCKER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NOJ_DRILL_TEST_LOG:?}"
if [[ "${1:-}" == "info" ]]; then
  exit 0
fi
if [[ "${NOJ_DRILL_TEST_FAIL:-}" == "pg_restore" && "$*" == *"pg_restore --clean"* ]]; then
  exit 41
fi
if [[ "${NOJ_DRILL_TEST_FAIL:-}" == "verify" && "$*" == *"deno run -A /opt/verify.ts"* ]]; then
  exit 42
fi
if [[ "$*" == *" pg_dump "* ]]; then
  printf 'fake postgres dump\n'
elif [[ "$*" == *"pg_restore --list"* ]]; then
  printf ';
1; TABLE public users noj
'
elif [[ "$*" == *"pg_dumpall"* ]]; then
  printf 'CREATE ROLE noj;\n'
elif [[ "$*" == *"--rdb -"* ]]; then
  printf 'fake redis rdb\n'
elif [[ "$*" == *"INFO persistence"* ]]; then
  printf 'aof_enabled:1\n'
elif [[ "$*" == *"to_regclass"* ]]; then
  printf 'drizzle.__drizzle_migrations\n'
elif [[ "$*" == *"psql"* && "$*" == *'hash || '* ]]; then
  printf 'migration-hash:2026-08-26\n'
elif [[ "$*" == *'count(*) FROM users'* ]]; then
  printf '3\n'
elif [[ "$*" == *"judge_images"* && "$*" == *"evaluator"* ]]; then
  printf 'noj-evaluator-python\n'
elif [[ "$*" == *"judge_images"* && "$*" == *"solution"* ]]; then
  printf 'noj-solution-python\n'
elif [[ "$*" == *"DBSIZE"* ]]; then
  printf '5\n'
elif [[ "$*" == *"mc ls --recursive"* ]]; then
  printf '0\n'
elif [[ "$*" == *"deno run -A /opt/verify.ts"* ]]; then
  cat "${NOJ_DRILL_TEST_VERIFY_OUTPUT:?}"
  exit "${NOJ_DRILL_TEST_VERIFY_STATUS:-0}"
fi
exit 0
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

cat >"$TEST_ROOT/verify-output.txt" <<'EOF'
{"step":"login","status":"passed","detail":"管理员 drill_admin 登录成功"}
{"step":"problem_import","status":"passed","detail":"演练题目导入成功"}
{"step":"problem_read","status":"passed","detail":"题目读取正常"}
{"step":"attachment_download","status":"passed","detail":"支持包下载成功"}
{"step":"evaluation","status":"passed","detail":"自测评测成功"}
{"step":"summary","status":"passed","passed":true,"steps":[]}
EOF
cat >"$TEST_ROOT/verify-failed.txt" <<'EOF'
{"step":"login","status":"passed","detail":"ok"}
{"step":"problem_import","status":"passed","detail":"ok"}
{"step":"evaluation","status":"failed","detail":"评测超时"}
{"step":"summary","status":"failed","passed":false,"steps":[]}
EOF

run_backup_create() {
  NOJ_BACKUP_DOCKER_BIN="$FAKE_DOCKER" \
  NOJ_BACKUP_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
    bash "$BACKUP_SCRIPT" create \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE" \
    --backup-dir "$BACKUP_DIR" \
    --passphrase-file "$PASSPHRASE_FILE" \
    --min-free-mb 0 >/dev/null 2>&1
}

make_snapshot() {
  run_backup_create || fail "fixture：backup.sh create 应成功"
  local snapshot
  snapshot="$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'snapshot-*' | head -n 1)"
  [[ -d "$snapshot" ]] || fail "fixture：快照目录未生成"
  printf '%s' "$snapshot"
}

run_drill() {
  local snapshot="$1"
  shift
  NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  NOJ_DRILL_TEST_VERIFY_STATUS="${NOJ_DRILL_TEST_VERIFY_STATUS:-0}" \
  NOJ_DRILL_TEST_FAIL="${NOJ_DRILL_TEST_FAIL:-}" \
  NOJ_BACKUP_DOCKER_BIN="$FAKE_DOCKER" \
    bash "$DRILL_SCRIPT" "$snapshot" \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE" \
    --passphrase-file "$PASSPHRASE_FILE" \
    "$@"
}

# ---------------------------------------------------------------------------
# 1. 输入校验与安全边界
# ---------------------------------------------------------------------------
if bash "$DRILL_SCRIPT" --help >/dev/null 2>&1; then
  pass "help 正常退出"
else
  fail "--help 应成功退出"
fi

local_snapshot="$(make_snapshot)"
if NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  bash "$DRILL_SCRIPT" "$local_snapshot" \
  --passphrase-file "$PASSPHRASE_FILE" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  --project-name noj-prod-drill >/dev/null 2>&1; then
  fail "项目名包含 prod 应被拒绝"
else
  pass "项目名包含 prod 被拒绝"
fi

if NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  bash "$DRILL_SCRIPT" "$BACKUP_DIR/not-a-snapshot" \
  --passphrase-file "$PASSPHRASE_FILE" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" >/dev/null 2>&1; then
  fail "非 snapshot-* 目录应被拒绝"
else
  pass "非快照目录被拒绝"
fi

: >"$FAKE_LOG"
if NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  bash "$DRILL_SCRIPT" "$local_snapshot" \
  --passphrase-file "$ENV_FILE" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" >/dev/null 2>&1; then
  fail "口令文件权限校验应失败"
else
  pass "口令文件权限校验生效"
fi
[[ "$(grep -c 'up' "$FAKE_LOG" || true)" == "0" ]] ||
  fail "校验失败时不得启动任何 Compose 服务"
pass "校验失败时不启动 Compose"

# 缺少口令文件参数
if NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  bash "$DRILL_SCRIPT" "$local_snapshot" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" >/dev/null 2>&1; then
  fail "缺少口令文件应失败"
else
  pass "缺少口令文件参数被拒绝"
fi

# ---------------------------------------------------------------------------
# 2. 完整演练（--skip-judge + --keep）：隔离配置、报告与业务验收
# ---------------------------------------------------------------------------
: >"$FAKE_LOG"
report="$TEST_ROOT/drill-report.txt"
run_drill "$local_snapshot" --skip-judge --keep --project-name noj-drill \
  --report "$report" --rpo-max-hours 24 --rto-max-minutes 60 >/dev/null 2>"$TEST_ROOT/drill.err" ||
  { cat "$TEST_ROOT/drill.err" >&2; fail "隔离恢复演练应成功"; }
pass "隔离恢复演练（--skip-judge）成功"

[[ -f "$report" ]] || fail "报告未生成"
grep -q '^result=passed$' "$report" || fail "报告应标记 result=passed"
grep -q '^drill_type=isolated-restore-with-business-verification$' "$report" ||
  fail "报告应标记演练类型"
grep -q '^restore_data_check=passed$' "$report" || fail "报告应包含数据核对结果"
grep -q '^rpo_hours=' "$report" && grep -q '^rpo_met=true$' "$report" ||
  fail "报告应包含 RPO 目标与达标标记"
grep -q '^rto_minutes=' "$report" && grep -q '^rto_met=true$' "$report" ||
  fail "报告应包含 RTO 目标与达标标记"
grep -q '^snapshot_created_at=' "$report" || fail "报告应记录快照时间"
grep -q '^credential_note=' "$report" || fail "报告应包含凭证保存说明"
pass "报告内容完整（结果/RPO/RTO/快照时间/数据核对/凭证说明）"

grep -q '"step":"summary","status":"passed","passed":true' "$report" ||
  fail "报告应包含业务验收 summary"
pass "报告包含业务验收明细"

[[ "$(grep -c 'down -v' "$FAKE_LOG" || true)" == "0" ]] ||
  fail "--keep 模式不得清理演练资源"
pass "--keep 模式保留演练资源"

grep -q 'JUDGE_EVALUATOR_NETWORK=noj-drill_noj-net' \
  "$TEST_ROOT/backups"/drill-*/.work/env.drill ||
  fail "演练环境应隔离评测网络名"
grep -q 'subnet: 172.29.0.0/16' "$TEST_ROOT/backups"/drill-*/.work/compose.drill-override.yml ||
  fail "演练覆盖 Compose 应使用独立子网"
rg -Fq 'image: denoland/deno:debian-2.9.5@sha256:' "$TEST_ROOT/backups"/drill-*/.work/compose.drill-override.yml ||
  fail "演练覆盖 Compose 应包含固定版本的 Deno 验收容器"
rg -Fq 'DO $role$ BEGIN IF NOT EXISTS' "$TEST_ROOT/backups"/drill-*/.work/postgres-globals.sql ||
  fail "PostgreSQL 全局对象恢复应幂等处理已有角色"
pass "演练环境与覆盖 Compose 隔离配置正确"

# ---------------------------------------------------------------------------
# 3. judge 链路：白名单镜像读取 + 评测验收执行
# ---------------------------------------------------------------------------
: >"$FAKE_LOG"
run_drill "$local_snapshot" --keep --project-name noj-drill >/dev/null 2>&1 ||
  fail "带 judge 的完整演练应成功"
grep -q '"step":"evaluation","status":"passed"' \
  "$TEST_ROOT/backups"/drill-*/.work/verify-output.log ||
  fail "完整演练应执行真实评测验收"
pass "完整演练包含真实评测验收"

# ---------------------------------------------------------------------------
# 4. 失败路径：数据库恢复失败 → 非零退出 + 失败报告 + 资源回收
# ---------------------------------------------------------------------------
: >"$FAKE_LOG"
fail_report="$TEST_ROOT/fail-report.txt"
if NOJ_DRILL_TEST_FAIL=pg_restore \
  NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-output.txt" \
  NOJ_BACKUP_DOCKER_BIN="$FAKE_DOCKER" \
  bash "$DRILL_SCRIPT" "$local_snapshot" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  --passphrase-file "$PASSPHRASE_FILE" \
  --report "$fail_report" >/dev/null 2>&1; then
  fail "pg_restore 失败时演练应失败"
fi
grep -q '^result=failed$' "$fail_report" || fail "失败报告应标记 result=failed"
grep -q '^failed_stage=restore-data$' "$fail_report" ||
  fail "失败报告应记录失败阶段 restore-data"
grep -q 'down -v --remove-orphans' "$FAKE_LOG" ||
  fail "失败时也应执行 down -v 清理"
pass "数据库恢复失败：非零退出 + 失败报告 + 资源回收"

# ---------------------------------------------------------------------------
# 5. 失败路径：业务验收失败
# ---------------------------------------------------------------------------
: >"$FAKE_LOG"
biz_fail_report="$TEST_ROOT/biz-fail-report.txt"
if NOJ_DRILL_TEST_VERIFY_STATUS=1 \
  NOJ_DRILL_TEST_LOG="$FAKE_LOG" \
  NOJ_DRILL_TEST_VERIFY_OUTPUT="$TEST_ROOT/verify-failed.txt" \
  NOJ_BACKUP_DOCKER_BIN="$FAKE_DOCKER" \
  bash "$DRILL_SCRIPT" "$local_snapshot" \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  --passphrase-file "$PASSPHRASE_FILE" \
  --skip-judge --report "$biz_fail_report" >/dev/null 2>&1; then
  fail "业务验收失败时演练应失败"
fi
grep -q '^result=failed$' "$biz_fail_report" || fail "业务失败报告应标记 result=failed"
grep -q '^failed_stage=business-verify$' "$biz_fail_report" ||
  fail "业务失败报告应记录失败阶段 business-verify"
grep -q '"step":"evaluation","status":"failed"' "$biz_fail_report" ||
  fail "业务失败报告应保留验收失败现场"
pass "业务验收失败：非零退出 + 保留失败现场"

# ---------------------------------------------------------------------------
# 6. 默认报告位置：写入快照目录且演练临时目录被清理
# ---------------------------------------------------------------------------
# 清理前序 --keep 用例保留的演练目录，验证默认路径下的资源回收。
rm -rf "$BACKUP_DIR"/drill-*
: >"$FAKE_LOG"
run_drill "$local_snapshot" --skip-judge >/dev/null 2>&1 ||
  fail "默认报告位置的演练应成功"
[[ -f "$local_snapshot/restore-drill-report.txt" ]] || fail "默认报告应写入快照目录"
drill_dirs="$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'drill-*' | wc -l | tr -d ' ')"
[[ "$drill_dirs" == "0" ]] || fail "演练临时目录应被清理"
grep -q 'down -v --remove-orphans' "$FAKE_LOG" ||
  fail "演练结束应执行 down -v 清理"
pass "默认报告写入快照目录、资源回收、临时目录已清理"

printf '\n全部恢复演练测试通过。\n'
