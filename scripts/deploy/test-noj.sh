#!/usr/bin/env bash
# noj 命令入口的无 Docker 路由测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_NOJ="$SCRIPT_DIR/../../noj"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-cli-test.XXXXXX")"
NORMALIZED_TEST_ROOT="$(cd -P "$TEST_ROOT" && pwd)"
LOG_FILE="$TEST_ROOT/route.log"
COMMAND_BIN="$TEST_ROOT/commands"
UPDATE_LOG="$TEST_ROOT/update.log"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

mkdir -p "$TEST_ROOT/scripts/deploy"
cp "$SOURCE_NOJ" "$TEST_ROOT/noj"
chmod 755 "$TEST_ROOT/noj"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "%s\n" "$*" >>"${NOJ_FAKE_LOG:?}"' \
  'if [[ "${NOJ_FAKE_EXIT:-0}" != 0 ]]; then exit "$NOJ_FAKE_EXIT"; fi' \
  >"$TEST_ROOT/scripts/deploy/deploy.sh"
chmod 755 "$TEST_ROOT/scripts/deploy/deploy.sh"
printf '%s\n' 'NOJ_VERSION=v-test' >"$TEST_ROOT/.env.prod"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "%s\n" "$*" >>"${NOJ_UPDATE_LOG:?}"' \
  >"$TEST_ROOT/scripts/deploy/install.sh"
chmod 755 "$TEST_ROOT/scripts/deploy/install.sh"

run_noj() {
  NOJ_BIN_DIR="${NOJ_BIN_DIR:-$COMMAND_BIN}" \
  NOJ_FAKE_LOG="$LOG_FILE" NOJ_UPDATE_LOG="$UPDATE_LOG" NOJ_FAKE_EXIT="${NOJ_FAKE_EXIT:-0}" \
    "$TEST_ROOT/noj" "$@"
}

assert_last_route() {
  local expected="$1" actual
  actual="$(tail -n 1 "$LOG_FILE")"
  [[ "$actual" == "$expected" ]] ||
    fail "路由错误：期望 [$expected]，实际 [$actual]"
}

: >"$LOG_FILE"
[[ "$(run_noj --help)" == *"Neuro OJ 生产运维命令"* ]] || fail "帮助输出缺少标题"
[[ ! -s "$LOG_FILE" ]] || fail "帮助命令不应调用部署脚本"
pass "帮助命令"

for command in install start stop status logs backup verify; do
  : >"$LOG_FILE"
  run_noj "$command" --env-file /tmp/noj-test.env
  assert_last_route "$command --env-file /tmp/noj-test.env"
done
[[ -L "$COMMAND_BIN/noj" ]] || fail "install 未注册 PATH 命令"
cmp -s "$COMMAND_BIN/noj" "$TEST_ROOT/noj" || fail "PATH 命令未指向当前安装"
pass "基础命令路由与参数透传"

: >"$LOG_FILE"
run_noj uninstall --yes
assert_last_route "uninstall --yes"
[[ ! -e "$COMMAND_BIN/noj" ]] || fail "uninstall 未移除当前安装的 PATH 命令"
pass "uninstall 路由与当前 PATH 命令清理"

: >"$LOG_FILE"
run_noj install
[[ -L "$COMMAND_BIN/noj" ]] || fail "重复注册破坏了 PATH 命令"
pass "PATH 命令重复注册"

: >"$LOG_FILE"
run_noj uninstall --yes --dry-run >"$TEST_ROOT/uninstall-dry-run.out"
assert_last_route "uninstall --yes --dry-run"
[[ -L "$COMMAND_BIN/noj" ]] || fail "uninstall dry-run 不应移除 PATH 命令"
pass "uninstall dry-run 无副作用"

ln -s "$TEST_ROOT/noj" "$TEST_ROOT/linked-noj"
: >"$LOG_FILE"
NOJ_BIN_DIR="$TEST_ROOT/linked-commands" NOJ_FAKE_LOG="$LOG_FILE" NOJ_FAKE_EXIT=0 \
  "$TEST_ROOT/linked-noj" status
assert_last_route "status"
pass "软链接调用定位安装目录"

: >"$LOG_FILE"
: >"$UPDATE_LOG"
run_noj update --dry-run
assert_last_route "upgrade --dry-run"
grep -Fqx -- "--ref v-test --dir $NORMALIZED_TEST_ROOT --files-only --dry-run" "$UPDATE_LOG" ||
  fail "update 未先同步配置版本的部署文件"
pass "update 同步部署文件并升级服务"

: >"$LOG_FILE"
run_noj update --env-file /tmp/noj-test.env --dry-run
assert_last_route "upgrade --env-file /tmp/noj-test.env --dry-run"
pass "update 路由到 upgrade"

: >"$LOG_FILE"
run_noj restart --env-file /tmp/noj-test.env
[[ "$(sed -n '1p' "$LOG_FILE")" == "stop --env-file /tmp/noj-test.env" ]] || fail "restart 未先停止服务"
[[ "$(sed -n '2p' "$LOG_FILE")" == "start --env-file /tmp/noj-test.env" ]] || fail "restart 未再启动服务"
pass "restart 顺序"

: >"$LOG_FILE"
run_noj config check --env-file /tmp/noj-test.env
assert_last_route "verify --env-file /tmp/noj-test.env"
pass "config check 路由"

: >"$LOG_FILE"
if run_noj unknown >/dev/null 2>&1; then
  fail "未知命令应返回非零退出码"
fi
[[ ! -s "$LOG_FILE" ]] || fail "未知命令不应调用部署脚本"
pass "未知命令"

: >"$LOG_FILE"
if NOJ_FAKE_EXIT=17 run_noj status >/dev/null 2>&1; then
  fail "底层部署脚本失败时 noj 应返回非零退出码"
fi
pass "底层退出码透传"

mkdir -p "$TEST_ROOT/conflict-bin"
printf 'existing command\n' >"$TEST_ROOT/conflict-bin/noj"
NOJ_BIN_DIR="$TEST_ROOT/conflict-bin" run_noj install >"$TEST_ROOT/conflict.out" 2>&1 ||
  fail "PATH 冲突不应导致已完成安装失败"
grep -q '未覆盖已有命令' "$TEST_ROOT/conflict.out" || fail "PATH 冲突未给出保护提示"
pass "已有同名命令保护"

other_install="$TEST_ROOT/other-install"
mkdir -p "$other_install"
printf '#!/usr/bin/env bash\n' >"$other_install/noj"
rm -f -- "$COMMAND_BIN/noj"
ln -s "$other_install/noj" "$COMMAND_BIN/noj"
: >"$LOG_FILE"
run_noj uninstall --yes
assert_last_route "uninstall --yes"
[[ -L "$COMMAND_BIN/noj" ]] || fail "uninstall 错误删除了其他安装的 PATH 命令"
pass "其他安装的 PATH 命令保护"

rm -f -- "$COMMAND_BIN/noj"
run_noj install >/dev/null
before_uninstall_failure_link="$(readlink "$COMMAND_BIN/noj")"
if NOJ_FAKE_EXIT=17 run_noj uninstall --yes >"$TEST_ROOT/uninstall-failure.out" 2>&1; then
  fail "uninstall 底层失败时应返回非零退出码"
fi
[[ "$(readlink "$COMMAND_BIN/noj")" == "$before_uninstall_failure_link" ]] ||
  fail "uninstall 失败时不应移除 PATH 命令"
pass "uninstall 失败保护"

printf 'not a directory\n' >"$TEST_ROOT/blocked-bin"
HOME="$TEST_ROOT/fallback-home" \
NOJ_BIN_DIR="$TEST_ROOT/blocked-bin/subdir" run_noj install >"$TEST_ROOT/fallback.out" 2>&1 ||
  fail "全局目录不可写时不应导致已完成安装失败"
[[ -L "$TEST_ROOT/fallback-home/.local/bin/noj" ]] || fail "全局目录不可用时未回退用户目录"
grep -Fqx 'export PATH="$HOME/.local/bin:$PATH"' "$TEST_ROOT/fallback-home/.profile" ||
  fail "用户目录回退时未补充登录 PATH"
pass "用户级 PATH 回退"

mv "$TEST_ROOT/scripts/deploy/deploy.sh" "$TEST_ROOT/scripts/deploy/deploy.sh.missing"
if run_noj status >"$TEST_ROOT/missing.out" 2>&1; then
  fail "缺少部署脚本时 noj 应返回非零退出码"
fi
grep -q '未找到生产部署脚本' "$TEST_ROOT/missing.out" || fail "缺少部署脚本时错误提示不清晰"
pass "部署脚本缺失提示"

mv "$TEST_ROOT/scripts/deploy/deploy.sh.missing" "$TEST_ROOT/scripts/deploy/deploy.sh"
printf 'services:\n  fake:\n    image: alpine:3\n' >"$TEST_ROOT/docker-compose.prod.yml"
mkdir "$TEST_ROOT/.git"
if run_noj uninstall --all --yes >"$TEST_ROOT/uninstall-all-git.out" 2>&1; then
  fail "uninstall --all 不应删除 Git 工作区"
fi
[[ -d "$TEST_ROOT" ]] || fail "Git 工作区保护失败后安装目录不应被删除"
grep -q '检测到 Git 工作区' "$TEST_ROOT/uninstall-all-git.out" || fail "Git 工作区保护提示缺失"
rmdir "$TEST_ROOT/.git"
pass "uninstall --all Git 工作区保护"

run_noj install >/dev/null
all_output="$(run_noj uninstall --all --yes 2>&1)" || fail "uninstall --all 应成功删除完整安装目录"
[[ "$all_output" == *"已删除 NOJ 安装目录"* ]] || fail "uninstall --all 未报告安装目录已删除"
[[ ! -d "$TEST_ROOT" ]] || fail "uninstall --all 未删除当前安装目录"
printf '✓ uninstall --all 删除安装目录\n'

printf 'noj CLI 路由测试通过\n'
