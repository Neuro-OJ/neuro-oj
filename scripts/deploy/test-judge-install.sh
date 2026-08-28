#!/usr/bin/env bash
# 独立 Judge 部署脚本的离线安全边界测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/judge-install.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-judge-install-test.XXXXXX")"
FAKE_DOCKER="$TEST_ROOT/fake-docker"
FAKE_CURL="$TEST_ROOT/fake-curl"
FAKE_UNAME="$TEST_ROOT/uname"
DOCKER_LOG="$TEST_ROOT/docker.log"
TARGET_DIR="$TEST_ROOT/target"
ENV_FILE="$TARGET_DIR/.env.judge"
SOCKET="$TEST_ROOT/isolated-docker.sock"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

cat >"$FAKE_DOCKER" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${NOJ_JUDGE_TEST_LOG:?}"
case "${1:-}" in
  info) exit 0 ;;
  compose)
    [[ "${2:-}" == version ]] && exit 0
    exit 0
    ;;
  image)
    exit 1
    ;;
  buildx)
    printf 'Name: fake\nPlatform: linux/amd64\n'
    exit 0
    ;;
  run)
    printf 'PONG\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_DOCKER"

cat >"$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output=""
while (($# > 0)); do
  if [[ "$1" == -o ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]] || exit 2
cp "${NOJ_JUDGE_SOURCE_SCRIPT:?}" "$output"
EOF
chmod +x "$FAKE_CURL"

cat >"$FAKE_UNAME" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -m ]]; then
  printf '%s\n' "${NOJ_JUDGE_TEST_ARCH:-x86_64}"
else
  printf 'Linux\n'
fi
EOF
chmod +x "$FAKE_UNAME"

mkdir -p "$TARGET_DIR"
python3 - "$SOCKET" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.listen(1)
PY
chmod 660 "$SOCKET"
SOCKET_GID="$(stat -c '%g' "$SOCKET" 2>/dev/null || stat -f '%g' "$SOCKET")"

cat >"$ENV_FILE" <<EOF
NOJ_VERSION=v0.1.0
REDIS_URL=redis://:secret-password@redis.test.local:6379/0
JUDGE_QUEUE=noj:judge:queue
RESULT_QUEUE=noj:judge:results
WORK_DIR=/tmp/noj-judge
JUDGE_MAX_CONCURRENT_JUDGES=2
JUDGE_IMAGE_PREFIX=noj-
JUDGE_IMAGE_REGISTRY=ghcr.io/neuro-oj
JUDGE_DOCKER_SOCKET=$SOCKET
JUDGE_DOCKER_SOCKET_GID=$SOCKET_GID
JUDGE_DOCKER_HOST=unix:///run/noj-judge/docker.sock
JUDGE_REQUIRE_ISOLATED_DOCKER=true
JUDGE_UID=10001
JUDGE_GID=10001
EOF
chmod 600 "$ENV_FILE"

run_judge() {
  NOJ_JUDGE_DOCKER_BIN="$FAKE_DOCKER" \
  NOJ_JUDGE_CURL_BIN="$FAKE_CURL" \
  NOJ_JUDGE_TEST_LOG="$DOCKER_LOG" \
  NOJ_JUDGE_SOURCE_SCRIPT="$DEPLOY_SCRIPT" \
  PATH="$TEST_ROOT:$PATH" \
    bash "$DEPLOY_SCRIPT" "$@" --dir "$TARGET_DIR"
}

[[ "$(bash "$DEPLOY_SCRIPT" --help)" == *"独立 Judge Worker 部署工具"* ]] ||
  fail "帮助输出缺少工具标题"
pass "帮助输出"

NOJ_JUDGE_DOCKER_BIN="$FAKE_DOCKER" \
NOJ_JUDGE_CURL_BIN="$FAKE_CURL" \
NOJ_JUDGE_TEST_LOG="$DOCKER_LOG" \
PATH="$TEST_ROOT:$PATH" \
  bash -s -- install-env <"$DEPLOY_SCRIPT" >/dev/null ||
  fail "从 curl 管道执行 install-env 不应失败"
pass "curl 管道入口"

PROMPT_DIR="$TEST_ROOT/prompt-target"
PROMPT_SOCKET="$TEST_ROOT/prompt.sock"
mkdir -p "$PROMPT_DIR"
python3 - "$PROMPT_SOCKET" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.listen(1)
PY
chmod 660 "$PROMPT_SOCKET"
PROMPT_SOCKET_GID="$(stat -c '%g' "$PROMPT_SOCKET" 2>/dev/null || stat -f '%g' "$PROMPT_SOCKET")"
PROMPT_OUTPUT="$TEST_ROOT/prompt.out"
NOJ_JUDGE_DOCKER_BIN="$FAKE_DOCKER" \
NOJ_JUDGE_CURL_BIN="$FAKE_CURL" \
NOJ_JUDGE_TEST_LOG="$DOCKER_LOG" \
PATH="$TEST_ROOT:$PATH" \
  bash "$DEPLOY_SCRIPT" install --dir "$PROMPT_DIR" >"$PROMPT_OUTPUT" 2>&1 <<EOF
v0.1.0
redis://redis.test.local:6379/0






$PROMPT_SOCKET
$PROMPT_SOCKET_GID


EOF
grep -q 'Redis 地址.*同一个 Redis 和队列' "$PROMPT_OUTPUT" || fail "Redis 配置说明缺失"
grep -q '无密码示例：redis://127.0.0.1:6379/0' "$PROMPT_OUTPUT" || fail "Redis 示例缺失"
grep -q '专用 Docker socket.*rootless' "$PROMPT_OUTPUT" || fail "Docker socket 配置说明缺失"
grep -q '^JUDGE_QUEUE=noj:judge:queue$' "$PROMPT_DIR/.env.judge" || fail "默认任务队列未生效"
grep -q '^RESULT_QUEUE=noj:judge:results$' "$PROMPT_DIR/.env.judge" || fail "默认结果队列未生效"
pass "交互式配置说明和默认值"

DOWNLOAD_DIR="$TEST_ROOT/download"
NOJ_JUDGE_DOCKER_BIN="$FAKE_DOCKER" \
NOJ_JUDGE_CURL_BIN="$FAKE_CURL" \
NOJ_JUDGE_TEST_LOG="$DOCKER_LOG" \
NOJ_JUDGE_SOURCE_SCRIPT="$DEPLOY_SCRIPT" \
PATH="$TEST_ROOT:$PATH" \
  bash "$DEPLOY_SCRIPT" download --dir "$DOWNLOAD_DIR" --ref test-ref >/dev/null
[[ -x "$DOWNLOAD_DIR/judge-install.sh" ]] || fail "download 未生成可执行脚本"
bash -n "$DOWNLOAD_DIR/judge-install.sh" || fail "下载脚本不是有效 Bash"
pass "仅下载脚本"

run_judge install >/dev/null
[[ -f "$TARGET_DIR/docker-compose.judge.yml" ]] || fail "install 未生成 Compose 文件"
grep -q 'JUDGE_REQUIRE_ISOLATED_DOCKER: "true"' "$TARGET_DIR/docker-compose.judge.yml" ||
  fail "Compose 未启用隔离 Docker"
grep -q ':ro"' "$TARGET_DIR/docker-compose.judge.yml" || fail "Docker socket 未以只读方式挂载"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --project-name noj-judge-standalone-test --env-file "$ENV_FILE" \
    -f "$TARGET_DIR/docker-compose.judge.yml" config --quiet ||
    fail "实际 Docker Compose 无法渲染独立 Judge 配置"
fi
if grep -q 'secret-password' "$DOCKER_LOG"; then fail "Docker 命令日志泄露 Redis 密码"; fi
pass "配置生成、Compose 安全项和 secret 脱敏"

run_judge start >/dev/null || fail "重复 start 不应失败"
run_judge status >/dev/null || fail "status 不应失败"
run_judge logs >/dev/null || fail "logs 不应失败"
run_judge stop >/dev/null || fail "stop 不应失败"
grep -q 'compose.*stop' "$DOCKER_LOG" || fail "stop 未调用 Compose stop"
pass "生命周期命令和重复启动"

run_judge upgrade --version v0.2.0 >/dev/null || fail "upgrade 不应失败"
grep -q '^NOJ_VERSION=v0.2.0$' "$ENV_FILE" || fail "upgrade 未更新版本"
pass "升级保留配置"

cp "$ENV_FILE" "$TEST_ROOT/unsafe.env"
sed -i.bak 's#JUDGE_DOCKER_SOCKET=.*#JUDGE_DOCKER_SOCKET=/var/run/docker.sock#' "$TEST_ROOT/unsafe.env"
chmod 600 "$TEST_ROOT/unsafe.env"
if run_judge check --env-file "$TEST_ROOT/unsafe.env" >/dev/null 2>"$TEST_ROOT/unsafe.err"; then
  fail "共享 Docker socket 应该被拒绝"
fi
grep -q '禁止使用应用宿主机 Docker socket' "$TEST_ROOT/unsafe.err" ||
  fail "共享 socket 错误提示缺失"
pass "共享 Docker socket 拒绝"

cp "$ENV_FILE" "$TEST_ROOT/missing.env"
sed -i.bak "s#JUDGE_DOCKER_SOCKET=.*#JUDGE_DOCKER_SOCKET=$TEST_ROOT/missing.sock#" "$TEST_ROOT/missing.env"
chmod 600 "$TEST_ROOT/missing.env"
if run_judge check --env-file "$TEST_ROOT/missing.env" >/dev/null 2>"$TEST_ROOT/missing.err"; then
  fail "缺失 Docker socket 应该被拒绝"
fi
grep -q '不是 Unix socket' "$TEST_ROOT/missing.err" || fail "缺失 socket 错误提示缺失"
pass "专用 Docker socket 存在性检查"

if NOJ_JUDGE_TEST_ARCH=aarch64 run_judge check >/dev/null 2>"$TEST_ROOT/arm64.err"; then
  fail "ARM64 无匹配镜像 manifest 时应该被拒绝"
fi
grep -q 'linux/arm64' "$TEST_ROOT/arm64.err" || fail "ARM64 架构错误提示缺失"
pass "ARM64 镜像架构门禁"

if NOJ_JUDGE_DOCKER_BIN="$FAKE_DOCKER" NOJ_JUDGE_TEST_LOG="$DOCKER_LOG" PATH="$TEST_ROOT:$PATH" \
  bash "$DEPLOY_SCRIPT" install --dir "$TEST_ROOT/non-interactive" --non-interactive \
  >"$TEST_ROOT/non-interactive.out" 2>"$TEST_ROOT/non-interactive.err"; then
  fail "非交互模式缺少配置时应该失败"
fi
grep -q 'NOJ_VERSION' "$TEST_ROOT/non-interactive.err" || fail "非交互缺失配置提示缺少"
pass "非交互必填配置门禁"

if grep -q 'secret-password' "$TARGET_DIR/docker-compose.judge.yml" "$DOCKER_LOG"; then
  fail "部署产物或 Docker 日志泄露了 Redis 密码"
fi
pass "最终 secret 泄露检查"

printf '全部独立 Judge 部署脚本测试通过\n'
