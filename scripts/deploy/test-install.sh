#!/usr/bin/env bash
# install.sh 的离线 bootstrap smoke test。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-bootstrap-test.XXXXXX")"
FAKE_BIN="$TEST_ROOT/bin"
ARCHIVE="$TEST_ROOT/source.tar.gz"
DOWNLOAD_LOG="$TEST_ROOT/download.log"
DEPLOY_LOG="$TEST_ROOT/deploy.log"

cleanup() { rm -rf -- "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

mkdir -p "$FAKE_BIN" "$TEST_ROOT/source/noj-neuro-oj-v0.1.0/scripts/deploy"
printf 'target\n' >"$TEST_ROOT/source/noj-neuro-oj-v0.1.0/AGENTS.md"
ln -s AGENTS.md "$TEST_ROOT/source/noj-neuro-oj-v0.1.0/CLAUDE.md"
cat >"$TEST_ROOT/source/noj-neuro-oj-v0.1.0/scripts/deploy/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >"${NOJ_BOOTSTRAP_DEPLOY_LOG:?}"
exit "${NOJ_BOOTSTRAP_DEPLOY_STATUS:-0}"
EOF
chmod +x "$TEST_ROOT/source/noj-neuro-oj-v0.1.0/scripts/deploy/deploy.sh"
printf 'services:\n  fake:\n    image: alpine:3\n' \
  >"$TEST_ROOT/source/noj-neuro-oj-v0.1.0/docker-compose.prod.yml"
tar -czf "$ARCHIVE" -C "$TEST_ROOT/source" noj-neuro-oj-v0.1.0

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
url=''
while (($# > 0)); do
  case "$1" in
    --output|-o) output="$2"; shift ;;
    --header) shift ;;
  esac
  url="$1"
  shift
done
if [[ "$url" == *'/releases?per_page=1' ]]; then
  [[ "${NOJ_BOOTSTRAP_API_FAIL:-0}" != 1 ]] || exit 22
  printf '{"tag_name":"%s"}\n' "${NOJ_BOOTSTRAP_LATEST_REF:-v0.1.0}"
  exit 0
fi
if [[ -n "${NOJ_SETUP_PAYLOAD:-}" ]]; then
  cp "$NOJ_SETUP_PAYLOAD" "${output:?}"
  exit 0
fi
printf '%s\n' "${output:?}" >>"${NOJ_BOOTSTRAP_DOWNLOAD_LOG:?}"
if [[ "${NOJ_BOOTSTRAP_DOWNLOAD_FAIL:-0}" == 1 ]]; then
  exit 22
fi
cp "${NOJ_BOOTSTRAP_ARCHIVE:?}" "$output"
EOF
chmod +x "$FAKE_BIN/curl"

cat >"$FAKE_BIN/tar" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${NOJ_BOOTSTRAP_DANGEROUS_TAR:-0}" == 1 && "${1:-}" == -*t* ]]; then
  printf 'noj-neuro-oj-v0.1.0/../escape\n'
  exit 0
fi
exec /usr/bin/tar "$@"
EOF
chmod +x "$FAKE_BIN/tar"

cat >"$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf '%s\n' "${NOJ_BOOTSTRAP_TEST_ARCH:-x86_64}" ;;
  *) /usr/bin/uname "$@" ;;
esac
EOF
chmod +x "$FAKE_BIN/uname"

cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${NOJ_BOOTSTRAP_DOCKER_FAIL:-0}" == 1 && "${1:-}" == info ]]; then
  exit 1
fi
case "${1:-}" in
  --version) printf 'Docker version 28.0.0, build test\n' ;;
  info) exit 0 ;;
  compose) printf 'Docker Compose version v2.36.0\n' ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"

cat >"$FAKE_BIN/ss" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/ss"

cat >"$FAKE_BIN/apt-get" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/apt-get"

export PATH="$FAKE_BIN:$PATH"
export NOJ_BOOTSTRAP_ARCHIVE="$ARCHIVE"
export NOJ_BOOTSTRAP_DOWNLOAD_LOG="$DOWNLOAD_LOG"
export NOJ_BOOTSTRAP_DEPLOY_LOG="$DEPLOY_LOG"

bash "$INSTALL_SCRIPT" --help >/dev/null
pass "帮助输出"

NOJ_SETUP_BOOTSTRAP_URL="https://example.test/install.sh" \
NOJ_SETUP_PAYLOAD="$INSTALL_SCRIPT" \
  bash "$SCRIPT_DIR/../../setup.sh" --help >"$TEST_ROOT/setup.out"
grep -q '默认自动选择最新 Release' "$TEST_ROOT/setup.out" || fail "根目录一键入口未转交 bootstrap"
pass "根目录一键入口"

check_out="$TEST_ROOT/check.out"
bash "$INSTALL_SCRIPT" check --port 18080 >"$check_out"
grep -q '环境检测通过' "$check_out" || fail "环境检测通过提示缺失"
grep -q 'Docker Compose：v2 可用' "$check_out" || fail "Compose 检测结果缺失"
pass "环境检测与资源摘要"

panel_root="$TEST_ROOT/baota/www/server/panel"
mkdir -p "$panel_root"
NOJ_BOOTSTRAP_PANEL_ROOT="$panel_root" bash "$INSTALL_SCRIPT" check --port 18081 \
  >"$TEST_ROOT/panel-check.out"
grep -q '宝塔兼容模式' "$TEST_ROOT/panel-check.out" || fail "bootstrap 宝塔自动检测提示缺失"
grep -q '反向代理' "$TEST_ROOT/panel-check.out" || fail "bootstrap 面板反向代理提示缺失"
pass "bootstrap 宝塔自动检测"

NOJ_BOOTSTRAP_PANEL_ROOT="$panel_root" bash "$INSTALL_SCRIPT" check --panel none --port 18082 \
  >"$TEST_ROOT/panel-none.out"
if grep -q '宝塔兼容模式' "$TEST_ROOT/panel-none.out"; then
  fail "bootstrap --panel none 不应输出宝塔提示"
fi
NOJ_BOOTSTRAP_PANEL_ROOT="$TEST_ROOT/missing-panel" bash "$INSTALL_SCRIPT" check --panel baota --port 18083 \
  >"$TEST_ROOT/panel-force.out"
grep -q '宝塔兼容模式' "$TEST_ROOT/panel-force.out" || fail "bootstrap --panel baota 提示缺失"
pass "bootstrap 面板模式覆盖"

set +e
NOJ_BOOTSTRAP_TEST_ARCH=aarch64 bash "$INSTALL_SCRIPT" check \
  >"$TEST_ROOT/arm64.out" 2>"$TEST_ROOT/arm64.err"
arm64_status=$?
set -e
[[ "$arm64_status" != 0 ]] || fail "ARM64 架构未被当前版本阻断"
grep -q '仅发布 linux/amd64' "$TEST_ROOT/arm64.err" || fail "ARM64 提示缺失"
pass "ARM64 架构提示"

set +e
NOJ_BOOTSTRAP_DOCKER_FAIL=1 bash "$INSTALL_SCRIPT" check >"$TEST_ROOT/check-fail.out" 2>"$TEST_ROOT/check-fail.err"
check_status=$?
set -e
[[ "$check_status" != 0 ]] || fail "Docker daemon 缺失未被检测"
grep -q 'Docker daemon' "$TEST_ROOT/check-fail.err" || fail "Docker 缺失错误提示缺失"
[[ ! -s "$DOWNLOAD_LOG" ]] || fail "check 命令不应下载源码"
pass "环境缺失状态与无副作用"

install_env_out="$TEST_ROOT/install-env.out"
bash "$INSTALL_SCRIPT" install-env --dry-run >"$install_env_out"
grep -q '安装基础工具' "$install_env_out" || fail "install-env 未显示基础工具安装计划"
grep -q 'Docker 请按发行版官方文档安装' <(bash "$INSTALL_SCRIPT" --help) ||
  fail "Docker 安装边界说明缺失"
pass "基础依赖安装计划"

dry_run_dir="$TEST_ROOT/dry-run"
bash "$INSTALL_SCRIPT" --dry-run --repo https://example.com/repo --ref v0.1.0 --dir "$dry_run_dir" >"$TEST_ROOT/dry-run.out"
[[ ! -e "$dry_run_dir" ]] || fail "dry-run 创建了目标目录"
[[ ! -s "$DOWNLOAD_LOG" ]] || fail "dry-run 下载了源码"
grep -q 'https://example.com/repo/archive/v0.1.0.tar.gz' "$TEST_ROOT/dry-run.out" ||
  fail "dry-run 未显示下载地址"
pass "dry-run 不产生副作用"

set +e
NOJ_BOOTSTRAP_API_FAIL=1 bash "$INSTALL_SCRIPT" --dir "$TEST_ROOT/api-fail" \
  >/dev/null 2>"$TEST_ROOT/api-fail.err"
api_status=$?
set -e
[[ "$api_status" != 0 ]] || fail "最新 Release 获取失败未返回非零"
grep -q '使用 --ref' "$TEST_ROOT/api-fail.err" || fail "最新 Release 获取失败提示缺少显式版本建议"
pass "最新 Release 获取失败"

NOJ_BOOTSTRAP_API_FAIL=1 bash "$INSTALL_SCRIPT" --ref v0.1.0 --dir "$TEST_ROOT/explicit-ref" >/dev/null
pass "显式版本跳过 Release 查询"

download_only_dir="$TEST_ROOT/download-only"
rm -f "$DEPLOY_LOG"
bash "$INSTALL_SCRIPT" --download-only --repo https://example.com/repo --ref v0.1.0 \
  --dir "$download_only_dir" >/dev/null
[[ -f "$download_only_dir/scripts/deploy/deploy.sh" ]] || fail "下载模式缺少部署脚本"
[[ ! -e "$DEPLOY_LOG" ]] || fail "download-only 启动了部署"
[[ -z "$(find "$TEST_ROOT" -maxdepth 1 -type d -name 'noj-bootstrap.*' -print -quit)" ]] ||
  fail "下载完成后未清理临时目录"
pass "源码下载与临时文件清理"

deploy_dir="$TEST_ROOT/deploy"
bash "$INSTALL_SCRIPT" --repo https://example.com/repo --ref v0.1.0 --dir "$deploy_dir" -- \
  --env-file /tmp/example.env --backup-dir /tmp/backups >/dev/null
[[ "$(cat "$DEPLOY_LOG")" == 'install --env-file /tmp/example.env --backup-dir /tmp/backups' ]] ||
  fail "部署参数未正确传递"
pass "部署入口与参数传递"

resume_dir="$TEST_ROOT/resume"
mkdir -p "$resume_dir/scripts/deploy"
cp "$TEST_ROOT/source/noj-neuro-oj-v0.1.0/scripts/deploy/deploy.sh" \
  "$resume_dir/scripts/deploy/deploy.sh"
chmod +x "$resume_dir/scripts/deploy/deploy.sh"
printf 'services:\n  fake:\n    image: alpine:3\n' >"$resume_dir/docker-compose.prod.yml"
printf 'NOJ_VERSION=v0.1.0\nADMIN_PASS=keep-this-secret\n' >"$resume_dir/.env.prod"
mkdir -p "$resume_dir/backups"
printf 'keep\n' >"$resume_dir/backups/marker.txt"
bash "$INSTALL_SCRIPT" --panel baota --dir "$resume_dir" >/dev/null
grep -q 'install --panel baota' "$DEPLOY_LOG" || fail "已有 NOJ 安装未继续执行 deploy.sh"
grep -q '^ADMIN_PASS=keep-this-secret$' "$resume_dir/.env.prod" || fail "续装覆盖了生产配置"
[[ "$(cat "$resume_dir/backups/marker.txt")" == keep ]] || fail "续装覆盖了备份目录"
pass "已有 NOJ 安装保留配置并继续部署"

panel_deploy_dir="$TEST_ROOT/panel-deploy"
bash "$INSTALL_SCRIPT" --panel baota --dir "$panel_deploy_dir" >/dev/null
grep -q 'install --panel baota' "$DEPLOY_LOG" || fail "bootstrap 未将面板模式传递给 deploy.sh"
pass "bootstrap 面板参数传递"

nonempty_dir="$TEST_ROOT/nonempty"
mkdir -p "$nonempty_dir"
printf 'keep\n' >"$nonempty_dir/keep.txt"
if bash "$INSTALL_SCRIPT" --dir "$nonempty_dir" >/dev/null 2>"$TEST_ROOT/nonempty.err"; then
  fail "非空目录未被拒绝"
fi
grep -q '非空' "$TEST_ROOT/nonempty.err" || fail "非空目录错误提示缺失"
[[ "$(cat "$nonempty_dir/keep.txt")" == keep ]] || fail "非空目录内容被覆盖"
pass "已有目录保护"

set +e
NOJ_BOOTSTRAP_DOWNLOAD_FAIL=1 TMPDIR="$TEST_ROOT/tmp-download-fail" \
  bash "$INSTALL_SCRIPT" --dir "$TEST_ROOT/download-fail" >/dev/null 2>"$TEST_ROOT/download-fail.err"
download_status=$?
set -e
[[ "$download_status" != 0 ]] || fail "下载失败未返回非零"
[[ ! -e "$TEST_ROOT/download-fail" ]] || fail "下载失败创建了目标目录"
[[ -z "$(find "$TEST_ROOT/tmp-download-fail" -mindepth 1 -maxdepth 1 -type d -name 'noj-bootstrap.*' -print -quit 2>/dev/null)" ]] ||
  fail "下载失败后未清理临时目录"
pass "下载失败传播与清理"

set +e
NOJ_BOOTSTRAP_DANGEROUS_TAR=1 \
  bash "$INSTALL_SCRIPT" --dir "$TEST_ROOT/dangerous" >/dev/null 2>"$TEST_ROOT/dangerous.err"
dangerous_status=$?
set -e
[[ "$dangerous_status" != 0 ]] || fail "危险归档未被拒绝"
grep -q '目录穿越' "$TEST_ROOT/dangerous.err" || fail "危险归档错误提示缺失"
[[ ! -e "$TEST_ROOT/dangerous" ]] || fail "危险归档创建了目标目录"
pass "危险归档拒绝"

set +e
NOJ_BOOTSTRAP_DEPLOY_STATUS=37 \
  bash "$INSTALL_SCRIPT" --dir "$TEST_ROOT/deploy-fail" >/dev/null 2>"$TEST_ROOT/deploy-fail.err"
deploy_status=$?
set -e
if [[ "$deploy_status" -ne 37 ]]; then
  printf '部署失败测试 stderr：\n' >&2
  sed -n '1,80p' "$TEST_ROOT/deploy-fail.err" >&2
  [[ -f "$DEPLOY_LOG" ]] && printf '部署记录：%s\n' "$(cat "$DEPLOY_LOG")" >&2
  fail "部署失败状态未原样传递：$deploy_status"
fi
grep -q 'status 或 logs' "$TEST_ROOT/deploy-fail.err" || fail "部署失败诊断提示缺失"
pass "部署失败状态传递"

printf '全部 bootstrap 脚本测试通过\n'
