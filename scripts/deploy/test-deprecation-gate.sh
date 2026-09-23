#!/usr/bin/env bash
# R2 弃用闸门测试（T24）。
#
# 对应 spec §8 R2 的四条验收：
#   1. 启动打印弃用警告；
#   2. 要求输入 y，非 y → 退出且**无副作用**；
#   3. NOJ_ACCEPT_DEPRECATED=1 可跳过；
#   4. 非 TTY 环境**不挂起**（明确报错）。
#
# 全部断言基于**进程退出码 + 输出内容 + 副作用**，不需要真实 docker：
# 闸门在任何副作用之前执行，因此被拒绝的路径必然零副作用。
set -Eeuo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-deprecation-gate-test.XXXXXX")"
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 假 docker：任何调用都写入日志（用于断言"零副作用"）。
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${NOJ_TEST_DOCKER_LOG:?}"
exit 0
EOF
chmod 700 "$FAKE_BIN/docker"

# 一个"看似完整"的生产目录：闸门若失效，脚本会真的去调用 docker。
DIR="$TEST_ROOT/install"
mkdir -p "$DIR"
printf 'NOJ_VERSION=v0.9.5\n' >"$DIR/.env.prod"
chmod 600 "$DIR/.env.prod"
printf 'services: {}\n' >"$DIR/docker-compose.prod.yml"

DOCKER_LOG="$TEST_ROOT/docker.log"
: >"$DOCKER_LOG"

run_deploy() {
  # stdin 显式接 /dev/null：模拟非 TTY（闸门必须因此报错而非挂起）
  NOJ_DEPLOY_DOCKER_BIN="$FAKE_BIN/docker" \
  NOJ_TEST_DOCKER_LOG="$DOCKER_LOG" \
    timeout 10 bash "$DEPLOY_DIR/deploy.sh" "$@" </dev/null
}

# ── 1 + 4：非 TTY 且未显式接受 → 打印警告 + 退出码 2 + 不挂起 + 零副作用 ──
set +e
out="$(run_deploy status --dir "$DIR" 2>&1)"
status=$?
set -e
[[ "$status" == "2" ]] || fail "非 TTY 应退出码 2（实得 $status）"
grep -q "已废弃" <<<"$out" || fail "未打印弃用警告"
grep -q "noj-cli" <<<"$out" || fail "警告未给出替代命令"
grep -q "NOJ_ACCEPT_DEPRECATED=1" <<<"$out" || fail "未告知跳过方式"
[[ ! -s "$DOCKER_LOG" ]] || fail "被拒绝时不得调用 docker（零副作用）"
pass "非 TTY：警告 + 退出码 2 + 零副作用 + 不挂起"

# 同一行为对 restore-drill.sh 成立
set +e
out2="$(NOJ_DEPLOY_DOCKER_BIN="$FAKE_BIN/docker" NOJ_TEST_DOCKER_LOG="$DOCKER_LOG" \
  timeout 10 bash "$DEPLOY_DIR/restore-drill.sh" /nonexistent 2>&1 </dev/null)"
status2=$?
set -e
[[ "$status2" == "2" ]] || fail "restore-drill 非 TTY 应退出码 2（实得 $status2）"
grep -q "restore-drill.sh 已废弃" <<<"$out2" || fail "restore-drill 未打印弃用警告"
[[ ! -s "$DOCKER_LOG" ]] || fail "restore-drill 被拒绝时不得调用 docker"
pass "restore-drill.sh 同样受闸门保护"

# ── 3：NOJ_ACCEPT_DEPRECATED=1 跳过（进入正常流程）──
set +e
out3="$(NOJ_ACCEPT_DEPRECATED=1 run_deploy status --dir "$DIR" 2>&1)"
status3=$?
set -e
grep -q "跳过弃用确认" <<<"$out3" || fail "未提示已跳过"
[[ "$status3" != "2" ]] || fail "显式接受后不应再以退出码 2 拒绝"
pass "NOJ_ACCEPT_DEPRECATED=1 可跳过"

# ── 2：真实 PTY + 输入 n → 退出码 0 且零副作用 ──
if command -v script >/dev/null 2>&1; then
  rm -f "$DOCKER_LOG"
  : >"$DOCKER_LOG"
  set +e
  pty_out="$(printf 'n\n' | script -qec \
    "NOJ_DEPLOY_DOCKER_BIN='$FAKE_BIN/docker' NOJ_TEST_DOCKER_LOG='$DOCKER_LOG' \
     timeout 10 bash '$DEPLOY_DIR/deploy.sh' status --dir '$DIR'" \
    /dev/null 2>&1)"
  pty_status=$?
  set -e
  [[ "$pty_status" == "0" ]] || fail "输入 n 应退出码 0（用户主动取消，实得 $pty_status）"
  grep -q "已取消" <<<"$pty_out" || fail "取消时未给出提示"
  [[ ! -s "$DOCKER_LOG" ]] || fail "取消后不得调用 docker（零副作用）"
  pass "PTY + n：退出码 0 且零副作用"

  # ── 2b：真实 PTY + 输入 y → 进入正常流程（闸门放行）──
  : >"$DOCKER_LOG"
  set +e
  pty_out2="$(printf 'y\n' | script -qec \
    "NOJ_DEPLOY_DOCKER_BIN='$FAKE_BIN/docker' NOJ_TEST_DOCKER_LOG='$DOCKER_LOG' \
     timeout 15 bash '$DEPLOY_DIR/deploy.sh' status --dir '$DIR'" \
    /dev/null 2>&1)"
  set -e
  # 放行的证据：越过闸门后开始做事（这里会因假配置而失败，但**已经**进入流程）
  grep -qE "检查部署环境|生产配置" <<<"$pty_out2" ||
    fail "输入 y 后应进入正常流程"
  pass "PTY + y：闸门放行并进入正常流程"
else
  printf '! 跳过 PTY 用例（无 script 命令）\n' >&2
fi

printf '全部弃用闸门测试通过\n'
