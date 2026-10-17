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
  # stdin 显式接 /dev/null 并指定不存在的 TTY 路径：模拟非 TTY（闸门必须因此报错而非挂起）
  NOJ_DEPLOY_DOCKER_BIN="$FAKE_BIN/docker" \
  NOJ_TEST_DOCKER_LOG="$DOCKER_LOG" \
  NOJ_DEPLOY_TTY_PATH="/dev/nonexistent" \
    timeout 10 bash "$DEPLOY_DIR/deploy.sh" "$@" </dev/null
}

# ── 1 + 4：非 TTY 且未显式接受 → 打印警告 + 退出码 2 + 不挂起 + 零副作用 ──
set +e
out="$(run_deploy status --dir "$DIR" 2>&1)"
status=$?
set -e
[[ "$status" == "2" ]] || fail "非 TTY 应退出码 2（实得 ${status}）"
grep -q "已废弃" <<<"$out" || fail "未打印弃用警告"
grep -q "noj-cli" <<<"$out" || fail "警告未给出替代命令"
grep -q "NOJ_ACCEPT_DEPRECATED=1" <<<"$out" || fail "未告知跳过方式"
[[ ! -s "$DOCKER_LOG" ]] || fail "被拒绝时不得调用 docker（零副作用）"
pass "非 TTY：警告 + 退出码 2 + 零副作用 + 不挂起"

# 同一行为对 restore-drill.sh 成立
set +e
out2="$(NOJ_DEPLOY_DOCKER_BIN="$FAKE_BIN/docker" NOJ_TEST_DOCKER_LOG="$DOCKER_LOG" \
  NOJ_DEPLOY_TTY_PATH="/dev/nonexistent" \
  timeout 10 bash "$DEPLOY_DIR/restore-drill.sh" /nonexistent 2>&1 </dev/null)"
status2=$?
set -e
[[ "$status2" == "2" ]] || fail "restore-drill 非 TTY 应退出码 2（实得 ${status2}）"
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
#
# `script` 的参数各平台不兼容：util-linux 是 `-qec <命令> <文件>`（`-e` 才透传
# 子进程退出码），BSD/macOS 只接受 `script [-aeFkpqr] [-t time] [file [command ...]]`，
# 遇到 `-c` 直接报 `illegal option`。因此**先探测**再使用，不能假定 `-qec`。
#
# 探测用例同时验证三件事，缺一不可：
#   1. 命令真的在 PTY 里跑起来（打印标记）；
#   2. 管道送入的一行能被 `read` 读到（BSD `script` 的坑，见下）；
#   3. 子进程退出码被透传（下面断言 `pty_status == 0` 的前提）。
SCRIPT_MODE=""
PTY_PROBE_CMD='IFS= read -r a; printf "NOJ_PTY_PROBE:%s\n" "$a"; exit 7'

# 在 PTY 中执行：$1 = 命令串，$2 = 送入 PTY 的一行输入。
run_in_pty() {
  case "$SCRIPT_MODE" in
    util-linux)
      printf '%s\n' "$2" | script -qec "$1" /dev/null
      ;;
    bsd)
      # BSD/macOS 的 script 若在启动瞬间就读到 stdin 的 EOF，会先往 PTY 写一个
      # `^D`，使第一次 `read` 立刻返回空行——答案被吞掉。让数据先到、并让管道
      # 多保持一小会儿，可确保首个 `read` 拿到答案（探测会验证这一点）。
      { printf '%s\n' "$2"; sleep 1; } | script -q /dev/null sh -c "$1"
      ;;
    *)
      return 125
      ;;
  esac
}

probe_script_mode() {
  local mode="$1" out rc
  SCRIPT_MODE="$mode"
  set +e
  out="$(run_in_pty "$PTY_PROBE_CMD" y 2>&1)"
  rc=$?
  set -e
  [[ "$rc" == "7" && "$out" == *"NOJ_PTY_PROBE:y"* ]]
}

detect_script_mode() {
  local mode
  for mode in util-linux bsd; do
    if probe_script_mode "$mode"; then
      SCRIPT_MODE="$mode"
      return 0
    fi
  done
  SCRIPT_MODE=""
  return 1
}

SKIPPED=0
if ! command -v script >/dev/null 2>&1; then
  SKIPPED=1
  printf '! SKIP：未找到 script 命令，PTY 用例（输入 n / 输入 y）不适用，已跳过\n' >&2
elif ! detect_script_mode; then
  SKIPPED=1
  printf '! SKIP：本机 script 不支持满足本用例前提的 PTY 调用形式\n' >&2
  printf '        （已试 util-linux 的 -qec 与 BSD/macOS 的尾随命令形式；要求：\n' >&2
  printf '         命令能执行、stdin 一行能被 read 读到、子进程退出码被透传）\n' >&2
  printf '        PTY 用例（输入 n / 输入 y）不适用，已跳过\n' >&2
else
  printf '· PTY 用例使用 script 形式：%s\n' "$SCRIPT_MODE"

  rm -f "$DOCKER_LOG"
  : >"$DOCKER_LOG"
  set +e
  pty_out="$(run_in_pty \
    "NOJ_DEPLOY_DOCKER_BIN='$FAKE_BIN/docker' NOJ_TEST_DOCKER_LOG='$DOCKER_LOG' \
     timeout 10 bash '$DEPLOY_DIR/deploy.sh' status --dir '$DIR'" n 2>&1)"
  pty_status=$?
  set -e
  [[ "$pty_status" == "0" ]] ||
    fail "输入 n 应退出码 0（用户主动取消，实得 ${pty_status}）"
  grep -q "已取消" <<<"$pty_out" || fail "取消时未给出提示"
  [[ ! -s "$DOCKER_LOG" ]] || fail "取消后不得调用 docker（零副作用）"
  pass "PTY + n：退出码 0 且零副作用"

  # ── 2b：真实 PTY + 输入 y → 进入正常流程（闸门放行）──
  : >"$DOCKER_LOG"
  set +e
  pty_out2="$(run_in_pty \
    "NOJ_DEPLOY_DOCKER_BIN='$FAKE_BIN/docker' NOJ_TEST_DOCKER_LOG='$DOCKER_LOG' \
     timeout 15 bash '$DEPLOY_DIR/deploy.sh' status --dir '$DIR'" y 2>&1)"
  set -e
  # 放行的证据：越过闸门后开始做事（这里会因假配置而失败，但**已经**进入流程）
  grep -qE "检查部署环境|生产配置" <<<"$pty_out2" ||
    fail "输入 y 后应进入正常流程"
  pass "PTY + y：闸门放行并进入正常流程"
fi

if [[ "$SKIPPED" == "1" ]]; then
  printf '弃用闸门测试通过（PTY 用例已显式跳过，PTY 交互路径未被覆盖）\n'
else
  printf '全部弃用闸门测试通过\n'
fi
