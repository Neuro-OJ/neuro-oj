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
DOMAIN=noj.test
CORS_ALLOWED_ORIGINS=https://noj.test
NOJ_ALLOW_INSECURE_HTTP=false
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

default_ip="$(NOJ_DEPLOY_DEFAULT_IP=192.0.2.10 NOJ_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; detect_default_ipv4' bash "$DEPLOY_SCRIPT")"
[[ "$default_ip" == 192.0.2.10 ]] || fail "服务器 IP 默认值检测失败"
pass "服务器 IP 默认值检测"

grep -q '可直接回车使用检测到的 IP' "$DEPLOY_SCRIPT" || fail "网站地址的服务器 IP 引导提示缺失"
grep -q '正式环境仍需 HTTPS' "$DEPLOY_SCRIPT" || fail "IP 场景 HTTPS 提示缺失"
pass "服务器 IP 默认值和 HTTPS 提示"

bad_domain_env="$TEST_ROOT/bad-domain.env"
cp "$ENV_FILE" "$bad_domain_env"
sed -i.bak 's/^DOMAIN=.*/DOMAIN=exit/' "$bad_domain_env"
stored_bad_domain="$(NOJ_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; ENV_FILE="$2"; current_config_value DOMAIN' bash "$DEPLOY_SCRIPT" "$bad_domain_env")"
[[ -z "$stored_bad_domain" ]] || fail "旧的退出文字仍被当成网站地址默认值"
if run_deploy_with "$bad_domain_env" start >"$TEST_ROOT/bad-domain.out" 2>&1; then
  fail "无效网站地址不应通过配置校验"
fi
grep -q '网站地址必须是域名或服务器 IP' "$TEST_ROOT/bad-domain.out" ||
  fail "无效网站地址未给出易懂错误提示"
pass "清理旧的退出文字配置"

reuse_yes="$(NOJ_DEPLOY_SOURCE_ONLY=1 NOJ_DEPLOY_TEST_CONFIRM=y bash -c 'source "$1"; read_prompt() { PROMPT_VALUE="$NOJ_DEPLOY_TEST_CONFIRM"; }; confirm_reuse_config' bash "$DEPLOY_SCRIPT")"
[[ "$reuse_yes" == *"将使用先前配置"* ]] || fail "确认使用先前配置未生效"
reuse_no="$(NOJ_DEPLOY_SOURCE_ONLY=1 NOJ_DEPLOY_TEST_CONFIRM=n bash -c 'source "$1"; read_prompt() { PROMPT_VALUE="$NOJ_DEPLOY_TEST_CONFIRM"; }; confirm_reuse_config' bash "$DEPLOY_SCRIPT" 2>&1 || true)"
[[ "$reuse_no" == *"重新填写"* ]] || fail "拒绝使用先前配置未进入覆盖流程"
pass "先前配置复用确认"

grep -q '是否写入配置？（Y=写入并继续部署，N=取消）' "$DEPLOY_SCRIPT" || fail "最终写入确认提示缺失"
grep -q '回车继续使用，输入 skip 暂不配置' "$DEPLOY_SCRIPT" || fail "已有邮件配置的复用提示缺失"
grep -q '直接回车暂不配置' "$DEPLOY_SCRIPT" || fail "无邮件配置的跳过提示缺失"
empty_email_label="$(NOJ_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; email_provider_prompt_label ""' bash "$DEPLOY_SCRIPT")"
[[ "$empty_email_label" == *"直接回车暂不配置"* ]] || fail "无邮件配置时回车含义不清楚"
aliyun_email_label="$(NOJ_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; email_provider_prompt_label aliyun' bash "$DEPLOY_SCRIPT")"
[[ "$aliyun_email_label" == *"回车继续使用"* ]] || fail "阿里云配置复用提示缺失"
pass "邮件服务回车与跳过提示"

staging_env="$TEST_ROOT/staging.env"
cp "$ENV_FILE" "$staging_env"
staging_before="$(sha256sum "$staging_env" 2>/dev/null || shasum "$staging_env")"
NOJ_DEPLOY_SOURCE_ONLY=1 NOJ_DEPLOY_TEST_SOCKET="$TEST_ROOT/isolated-docker.sock" bash -c '
  source "$1"
  ENV_FILE="$2"
  begin_config_staging
  set_env_value STAGING_TEST_KEY staged-value
  [[ "$(env_value STAGING_TEST_KEY)" == staged-value ]]
  [[ "$(grep -c "^STAGING_TEST_KEY=" "$2" || true)" == 0 ]]
  cancel_config_staging
  [[ ! -e "$CONFIG_STAGE_FILE" ]]
  [[ "$(env_value STAGING_TEST_KEY)" == "" ]]
' bash "$DEPLOY_SCRIPT" "$staging_env" || fail "配置暂存或取消流程失败"
staging_after_cancel="$(sha256sum "$staging_env" 2>/dev/null || shasum "$staging_env")"
[[ "$staging_before" == "$staging_after_cancel" ]] || fail "取消暂存后正式配置发生变化"
NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  ENV_FILE="$2"
  begin_config_staging
  set_env_value STAGING_TEST_KEY committed-value
  commit_config_staging
  [[ "$(env_value STAGING_TEST_KEY)" == committed-value ]]
' bash "$DEPLOY_SCRIPT" "$staging_env" || fail "配置确认写入流程失败"
grep -q '^STAGING_TEST_KEY=committed-value$' "$staging_env" || fail "确认后未写入正式配置"
pass "配置暂存、取消和最终写入"

configure_commit_env="$TEST_ROOT/configure-commit.env"
cp "$ENV_FILE" "$configure_commit_env"
NOJ_DEPLOY_SOURCE_ONLY=1 NOJ_DEPLOY_TEST_SOCKET="$TEST_ROOT/isolated-docker.sock" bash -c '
  source "$1"
  ENV_FILE="$2"
  prompt_text() {
    case "$1" in
      安装版本*) PROMPT_VALUE=v0.8.0-rc.1 ;;
      网站地址*) PROMPT_VALUE=noj.example.com ;;
      管理员邮箱*) PROMPT_VALUE=admin@noj.example.com ;;
      邮件服务*) PROMPT_VALUE=disabled ;;
      评测服务连接位置*) PROMPT_VALUE="$NOJ_DEPLOY_TEST_SOCKET" ;;
      评测服务连接编号*) PROMPT_VALUE=10001 ;;
      *) return 1 ;;
    esac
  }
  prompt_password() { PROMPT_VALUE=strong-admin-password; }
  prompt_yes_no() {
    [[ "$1" == *"是否写入配置"* ]] || return 0
    return 0
  }
  configure_env_interactive 1
' bash "$DEPLOY_SCRIPT" "$configure_commit_env" "$TEST_ROOT/isolated-docker.sock" \
  >/dev/null 2>"$TEST_ROOT/configure-commit.err" || fail "配置向导确认写入失败"
grep -q '^NOJ_VERSION=v0.8.0-rc.1$' "$configure_commit_env" || fail "配置向导确认后未写入版本"
grep -q '^EMAIL_PROVIDER=disabled$' "$configure_commit_env" || fail "配置向导确认后未写入邮件选项"
pass "配置向导最终确认写入"

configure_cancel_env="$TEST_ROOT/configure-cancel.env"
cp "$ENV_FILE" "$configure_cancel_env"
configure_cancel_before="$(sha256sum "$configure_cancel_env" 2>/dev/null || shasum "$configure_cancel_env")"
if NOJ_DEPLOY_SOURCE_ONLY=1 NOJ_DEPLOY_TEST_SOCKET="$TEST_ROOT/isolated-docker.sock" bash -c '
  source "$1"
  ENV_FILE="$2"
  prompt_text() {
    case "$1" in
      安装版本*) PROMPT_VALUE=v0.8.0-rc.1 ;;
      网站地址*) PROMPT_VALUE=noj.example.com ;;
      管理员邮箱*) PROMPT_VALUE=admin@noj.example.com ;;
      邮件服务*) PROMPT_VALUE=disabled ;;
      评测服务连接位置*) PROMPT_VALUE="$NOJ_DEPLOY_TEST_SOCKET" ;;
      评测服务连接编号*) PROMPT_VALUE=10001 ;;
      *) return 1 ;;
    esac
  }
  prompt_password() { PROMPT_VALUE=strong-admin-password; }
  prompt_yes_no() {
    [[ "$1" == *"是否写入配置"* ]] && return 1
    return 0
  }
  configure_env_interactive 1
' bash "$DEPLOY_SCRIPT" "$configure_cancel_env" "$TEST_ROOT/isolated-docker.sock" \
  >/dev/null 2>"$TEST_ROOT/configure-cancel.err"; then
  fail "拒绝写入后配置向导不应继续部署"
fi
configure_cancel_after="$(sha256sum "$configure_cancel_env" 2>/dev/null || shasum "$configure_cancel_env")"
[[ "$configure_cancel_before" == "$configure_cancel_after" ]] || fail "拒绝写入后正式配置发生变化"
pass "配置向导取消不落盘"

grep -q '是否使用先前配置？' "$DEPLOY_SCRIPT" || fail "先前配置确认提示缺失"
reset_prompt="$(NOJ_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; config_prompt_value DOMAIN 1' bash "$DEPLOY_SCRIPT")"
[[ -z "$reset_prompt" ]] || fail "选择重新填写时仍保留旧配置默认值"
grep -q '网站地址（域名或服务器 IP' "$DEPLOY_SCRIPT" || fail "网站地址提示不够友好"
grep -q '是否使用 HTTPS（证书需在宝塔或反向代理中配置）' "$DEPLOY_SCRIPT" || fail "HTTPS 选择提示缺失"
grep -q '暂不配置' "$DEPLOY_SCRIPT" || fail "邮件服务跳过提示缺失"
grep -q 'configure_env_interactive 1' "$DEPLOY_SCRIPT" || fail "重新填写未清空旧值默认值"
pass "重新填写和易懂配置提示"

http_env="$TEST_ROOT/http.env"
cp "$ENV_FILE" "$http_env"
sed -i.bak \
  -e 's#^APP_URL=.*#APP_URL=http://noj.test#' \
  -e 's#^CORS_ALLOWED_ORIGINS=.*#CORS_ALLOWED_ORIGINS=http://noj.test#' \
  -e 's#^NOJ_ALLOW_INSECURE_HTTP=.*#NOJ_ALLOW_INSECURE_HTTP=true#' \
  "$http_env"
run_deploy_with "$http_env" start >/dev/null 2>"$TEST_ROOT/http.err" ||
  fail "明确开启临时 HTTP 后 start 不应失败"
sed -i.bak 's#^NOJ_ALLOW_INSECURE_HTTP=.*#NOJ_ALLOW_INSECURE_HTTP=false#' "$http_env"
if run_deploy_with "$http_env" start >"$TEST_ROOT/http-disabled.out" 2>&1; then
  fail "未明确开启临时 HTTP 时不应通过配置校验"
fi
grep -q '必须明确选择临时 HTTP 模式' "$TEST_ROOT/http-disabled.out" ||
  fail "HTTP 安全门禁提示缺失"
pass "HTTPS 默认安全门禁和临时 HTTP"

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

disabled_env="$TEST_ROOT/disabled-email.env"
cp "$ENV_FILE" "$disabled_env"
sed -i.bak 's/^EMAIL_PROVIDER=.*/EMAIL_PROVIDER=disabled/' "$disabled_env"
run_deploy_with "$disabled_env" start >/dev/null 2>"$TEST_ROOT/disabled-email.err" ||
  fail "跳过邮件服务后合法配置的 start 不应失败"
pass "跳过邮件服务配置"

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
