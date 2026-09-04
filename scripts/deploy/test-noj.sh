#!/usr/bin/env bash
# noj 命令入口的无 Docker 路由测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_NOJ="$SCRIPT_DIR/production.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-cli-test.XXXXXX")"
NORMALIZED_TEST_ROOT="$(cd -P "$TEST_ROOT" && pwd)"
LOG_FILE="$TEST_ROOT/route.log"
COMMAND_BIN="$TEST_ROOT/commands"
UPDATE_LOG="$TEST_ROOT/update.log"
CUSTOM_ENV="$TEST_ROOT/custom.env"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

mkdir -p "$TEST_ROOT/scripts/deploy" "$TEST_ROOT/bin"
cp "$SOURCE_NOJ" "$TEST_ROOT/scripts/deploy/production.sh"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'source_path="$0"' \
  'while [[ -L "$source_path" ]]; do source_path="$(readlink "$source_path")"; done' \
  'exec bash "$(dirname "$source_path")/../scripts/deploy/production.sh" "$@"' \
  >"$TEST_ROOT/bin/noj-cli"
chmod 755 "$TEST_ROOT/bin/noj-cli"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "%s\n" "$*" >>"${NOJ_FAKE_LOG:?}"' \
  'if [[ "${NOJ_FAKE_EXIT:-0}" != 0 ]]; then exit "$NOJ_FAKE_EXIT"; fi' \
  >"$TEST_ROOT/scripts/deploy/deploy.sh"
chmod 755 "$TEST_ROOT/scripts/deploy/deploy.sh"
printf '%s\n' 'NOJ_VERSION=v-test' >"$TEST_ROOT/.env.prod"
printf '%s\n' 'NOJ_VERSION=v-custom' >"$CUSTOM_ENV"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'printf "bootstrap=%s\\n" "$0" >>"${NOJ_UPDATE_LOG:?}"' \
  'printf "%s\n" "$*" >>"${NOJ_UPDATE_LOG:?}"' \
  >"$TEST_ROOT/scripts/deploy/install.sh"
chmod 755 "$TEST_ROOT/scripts/deploy/install.sh"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'if [[ "${NOJ_UPDATE_TEST_API_FAIL:-0}" == 1 ]]; then exit 22; fi' \
  'printf '\''{"tag_name":"%s","draft":false,"prerelease":false}\n'\'' "${NOJ_UPDATE_TEST_LATEST_TAG:-v0.2.0}"' \
  >"$TEST_ROOT/curl"
chmod 755 "$TEST_ROOT/curl"

run_noj() {
  NOJ_BIN_DIR="${NOJ_BIN_DIR:-$COMMAND_BIN}" \
  NOJ_FAKE_LOG="$LOG_FILE" NOJ_UPDATE_LOG="$UPDATE_LOG" NOJ_FAKE_EXIT="${NOJ_FAKE_EXIT:-0}" \
  NOJ_UPDATE_API_URL="${NOJ_UPDATE_API_URL:-https://api.test/releases/latest}" \
  PATH="$TEST_ROOT:$PATH" \
    "$TEST_ROOT/bin/noj-cli" "$@"
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
[[ -L "$COMMAND_BIN/noj-cli" ]] || fail "install 未注册 PATH 命令"
cmp -s "$COMMAND_BIN/noj-cli" "$TEST_ROOT/bin/noj-cli" || fail "PATH 命令未指向当前安装"
pass "基础命令路由与参数透传"

run_noj backup create --passphrase-file /tmp/noj-passphrase
assert_last_route "backup --passphrase-file /tmp/noj-passphrase"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "backup:%s passphrase:%s\n" "$*" "$NOJ_BACKUP_PASSPHRASE_FILE" >>"${NOJ_FAKE_LOG:?}"' \
  >"$TEST_ROOT/scripts/deploy/backup.sh"
printf 'NOJ_BACKUP_PASSPHRASE_FILE="/tmp/noj passphrase"\n' >>"$TEST_ROOT/.env.prod"
for command in verify restore drill; do
  run_noj backup "$command" snapshot --confirm
  assert_last_route "backup:$command snapshot --confirm passphrase:/tmp/noj passphrase"
done
pass "备份创建、校验、恢复和演练路由及口令路径配置"

: >"$LOG_FILE"
run_noj check --port 18080
[[ ! -s "$LOG_FILE" ]] || fail "环境检查不应调用生产部署脚本"
pass "环境检查入口"

: >"$LOG_FILE"
run_noj uninstall --yes
assert_last_route "uninstall --yes"
[[ ! -e "$COMMAND_BIN/noj-cli" ]] || fail "uninstall 未移除当前安装的 PATH 命令"
pass "uninstall 路由与当前 PATH 命令清理"

ln -s "$NORMALIZED_TEST_ROOT/noj" "$COMMAND_BIN/noj"
run_noj uninstall --yes
[[ ! -L "$COMMAND_BIN/noj" ]] || fail "卸载未移除指向当前旧安装的 noj 软链接"
pass "卸载清理旧 noj PATH 链接"

: >"$LOG_FILE"
run_noj install
[[ -L "$COMMAND_BIN/noj-cli" ]] || fail "重复注册破坏了 PATH 命令"
pass "PATH 命令重复注册"

: >"$LOG_FILE"
run_noj uninstall --yes --dry-run >"$TEST_ROOT/uninstall-dry-run.out"
assert_last_route "uninstall --yes --dry-run"
[[ -L "$COMMAND_BIN/noj-cli" ]] || fail "uninstall dry-run 不应移除 PATH 命令"
pass "uninstall dry-run 无副作用"

ln -s "$TEST_ROOT/bin/noj-cli" "$TEST_ROOT/linked-noj"
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
bootstrap_path="$(sed -n 's/^bootstrap=//p' "$UPDATE_LOG" | tail -n 1)"
[[ "$bootstrap_path" != "$TEST_ROOT/scripts/deploy/install.sh" && ! -e "$bootstrap_path" ]] ||
  fail "update 仍直接执行或遗留安装目录中的 bootstrap"
pass "update 同步部署文件并升级服务"

: >"$LOG_FILE"
run_noj update --env-file "$CUSTOM_ENV" --dry-run
assert_last_route "upgrade --env-file $CUSTOM_ENV --dry-run"
pass "update 路由到 upgrade"

run_noj upgrade --env-file "$CUSTOM_ENV" --dry-run
assert_last_route "upgrade --env-file $CUSTOM_ENV --dry-run"
pass "upgrade 别名"

: >"$LOG_FILE"
: >"$UPDATE_LOG"
run_noj update --latest --dry-run >"$TEST_ROOT/latest-dry-run.out"
grep -E -q '^upgrade --dry-run --env-file .+/.env.prod\.latest\.[A-Za-z0-9]+$' "$LOG_FILE" ||
  fail "update --latest --dry-run 未使用版本配置暂存文件"
grep -Fqx -- "--ref v0.2.0 --dir $NORMALIZED_TEST_ROOT --files-only --dry-run" "$UPDATE_LOG" ||
  fail "update --latest --dry-run 未同步目标版本部署文件"
grep -Fqx 'NOJ_VERSION=v-test' "$TEST_ROOT/.env.prod" ||
  fail "update --latest --dry-run 不应修改生产版本配置"
grep -q '最新稳定版本：v0.2.0' "$TEST_ROOT/latest-dry-run.out" ||
  fail "update --latest 未展示目标版本"
pass "update --latest dry-run"

: >"$LOG_FILE"
: >"$UPDATE_LOG"
run_noj update --latest >"$TEST_ROOT/latest.out"
grep -Fqx -- "--ref v0.2.0 --dir $NORMALIZED_TEST_ROOT --files-only" "$UPDATE_LOG" ||
  fail "update --latest 未同步目标版本部署文件"
grep -q '^NOJ_VERSION=v0.2.0$' "$TEST_ROOT/.env.prod" ||
  fail "update --latest 成功后未提交目标版本配置"
pass "update --latest 成功升级"

before_noop_log="$(wc -l <"$LOG_FILE")"
run_noj update --latest >"$TEST_ROOT/latest-noop.out"
after_noop_log="$(wc -l <"$LOG_FILE")"
[[ "$before_noop_log" == "$after_noop_log" ]] || fail "已经是最新版本时不应重启或升级"
grep -q '无需升级' "$TEST_ROOT/latest-noop.out" || fail "已经是最新版本时未给出无操作提示"
pass "update --latest 已是最新版本"

before_rc_log="$(wc -l <"$LOG_FILE")"
if NOJ_UPDATE_TEST_LATEST_TAG=v0.3.0-rc.1 \
  run_noj update --latest >"$TEST_ROOT/latest-rc.out" 2>&1; then
  fail "稳定版本自动升级不应选择 RC 标签"
fi
after_rc_log="$(wc -l <"$LOG_FILE")"
[[ "$before_rc_log" == "$after_rc_log" ]] || fail "RC 标签被拒绝前不应进入升级流程"
grep -E -q '不是稳定版本标签|无效或仍是预发布版本' "$TEST_ROOT/latest-rc.out" || fail "RC 标签拒绝提示不清晰"
pass "update --latest 拒绝 RC 标签"

cp "$TEST_ROOT/.env.prod" "$TEST_ROOT/api-failure.env"
before_api_failure="$(sha256sum "$TEST_ROOT/api-failure.env" 2>/dev/null || shasum "$TEST_ROOT/api-failure.env")"
if NOJ_UPDATE_TEST_API_FAIL=1 NOJ_UPDATE_API_URL=https://api.test/releases/latest \
  run_noj update --latest --env-file "$TEST_ROOT/api-failure.env" >"$TEST_ROOT/latest-api-failure.out" 2>&1; then
  fail "最新版本 API 失败时应返回非零退出码"
fi
after_api_failure="$(sha256sum "$TEST_ROOT/api-failure.env" 2>/dev/null || shasum "$TEST_ROOT/api-failure.env")"
[[ "$before_api_failure" == "$after_api_failure" ]] || fail "最新版本 API 失败时修改了生产配置"
pass "update --latest API 失败保护"

cp "$TEST_ROOT/.env.prod" "$TEST_ROOT/upgrade-failure.env"
before_upgrade_failure="$(sha256sum "$TEST_ROOT/upgrade-failure.env" 2>/dev/null || shasum "$TEST_ROOT/upgrade-failure.env")"
if NOJ_UPDATE_TEST_LATEST_TAG=v0.3.0 NOJ_FAKE_EXIT=17 \
  run_noj update --latest --env-file "$TEST_ROOT/upgrade-failure.env" >"$TEST_ROOT/latest-upgrade-failure.out" 2>&1; then
  fail "升级失败时应返回非零退出码"
fi
after_upgrade_failure="$(sha256sum "$TEST_ROOT/upgrade-failure.env" 2>/dev/null || shasum "$TEST_ROOT/upgrade-failure.env")"
[[ "$before_upgrade_failure" == "$after_upgrade_failure" ]] || fail "升级失败时修改了生产配置"
pass "update --latest 升级失败保护"

: >"$LOG_FILE"
run_noj restart --env-file "$CUSTOM_ENV"
[[ "$(sed -n '1p' "$LOG_FILE")" == "stop --env-file $CUSTOM_ENV" ]] || fail "restart 未先停止服务"
[[ "$(sed -n '2p' "$LOG_FILE")" == "start --env-file $CUSTOM_ENV" ]] || fail "restart 未再启动服务"
pass "restart 顺序"

: >"$LOG_FILE"
run_noj config check --env-file "$CUSTOM_ENV"
assert_last_route "config-check --env-file $CUSTOM_ENV"
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
printf 'existing command\n' >"$TEST_ROOT/conflict-bin/noj-cli"
NOJ_BIN_DIR="$TEST_ROOT/conflict-bin" run_noj install >"$TEST_ROOT/conflict.out" 2>&1 ||
  fail "PATH 冲突不应导致已完成安装失败"
grep -q '未覆盖已有命令' "$TEST_ROOT/conflict.out" || fail "PATH 冲突未给出保护提示"
pass "已有同名命令保护"

other_install="$TEST_ROOT/other-install"
mkdir -p "$other_install"
printf '#!/usr/bin/env bash\n' >"$other_install/noj-cli"
rm -f -- "$COMMAND_BIN/noj-cli"
ln -s "$other_install/noj-cli" "$COMMAND_BIN/noj-cli"
: >"$LOG_FILE"
run_noj uninstall --yes
assert_last_route "uninstall --yes"
[[ -L "$COMMAND_BIN/noj-cli" ]] || fail "uninstall 错误删除了其他安装的 PATH 命令"
pass "其他安装的 PATH 命令保护"

rm -f -- "$COMMAND_BIN/noj-cli"
run_noj install >/dev/null
before_uninstall_failure_link="$(readlink "$COMMAND_BIN/noj-cli")"
if NOJ_FAKE_EXIT=17 run_noj uninstall --yes >"$TEST_ROOT/uninstall-failure.out" 2>&1; then
  fail "uninstall 底层失败时应返回非零退出码"
fi
[[ "$(readlink "$COMMAND_BIN/noj-cli")" == "$before_uninstall_failure_link" ]] ||
  fail "uninstall 失败时不应移除 PATH 命令"
pass "uninstall 失败保护"

printf 'not a directory\n' >"$TEST_ROOT/blocked-bin"
HOME="$TEST_ROOT/fallback-home" \
NOJ_BIN_DIR="$TEST_ROOT/blocked-bin/subdir" run_noj install >"$TEST_ROOT/fallback.out" 2>&1 ||
  fail "全局目录不可写时不应导致已完成安装失败"
[[ -L "$TEST_ROOT/fallback-home/.local/bin/noj-cli" ]] || fail "全局目录不可用时未回退用户目录"
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
: >"$LOG_FILE"
if run_noj uninstall --all --yes >"$TEST_ROOT/uninstall-all-git.out" 2>&1; then
  fail "uninstall --all 不应删除 Git 工作区"
fi
[[ -d "$TEST_ROOT" ]] || fail "Git 工作区保护失败后安装目录不应被删除"
[[ ! -s "$LOG_FILE" ]] || fail "Git 工作区保护应在删除 Compose 数据之前执行"
grep -q '检测到 Git 工作区' "$TEST_ROOT/uninstall-all-git.out" || fail "Git 工作区保护提示缺失"
rmdir "$TEST_ROOT/.git"
pass "uninstall --all Git 工作区保护"

run_noj install >/dev/null
all_output="$(run_noj uninstall --all --yes 2>&1)" || fail "uninstall --all 应成功删除完整安装目录"
[[ "$all_output" == *"已删除 NOJ 安装目录"* ]] || fail "uninstall --all 未报告安装目录已删除"
[[ ! -d "$TEST_ROOT" ]] || fail "uninstall --all 未删除当前安装目录"
printf '✓ uninstall --all 删除安装目录\n'

printf 'noj CLI 路由测试通过\n'
