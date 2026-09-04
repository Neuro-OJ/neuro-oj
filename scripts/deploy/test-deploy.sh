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

NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  has_interactive_tty() { return 0; }
  read_prompt() { PROMPT_VALUE=UNINSTALL; }
  confirm_uninstall
' bash "$DEPLOY_SCRIPT" >/dev/null 2>"$TEST_ROOT/uninstall-confirm.err" ||
  fail "输入 UNINSTALL 后应允许卸载"
if NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  has_interactive_tty() { return 0; }
  read_prompt() { PROMPT_VALUE=no; }
  confirm_uninstall
' bash "$DEPLOY_SCRIPT" >/dev/null 2>"$TEST_ROOT/uninstall-cancel.err"; then
  fail "未输入 UNINSTALL 时不应允许卸载"
fi
grep -q '未确认卸载' "$TEST_ROOT/uninstall-cancel.err" || fail "卸载取消提示缺失"
pass "uninstall 交互确认词"

NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  UNINSTALL_ALL=1
  has_interactive_tty() { return 0; }
  read_prompt() { PROMPT_VALUE="DELETE ALL"; }
  confirm_uninstall
' bash "$DEPLOY_SCRIPT" >/dev/null 2>"$TEST_ROOT/uninstall-all-confirm.err" ||
  fail "输入 DELETE ALL 后应允许完全删除"
if NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  UNINSTALL_ALL=1
  has_interactive_tty() { return 0; }
  read_prompt() { PROMPT_VALUE=UNINSTALL; }
  confirm_uninstall
' bash "$DEPLOY_SCRIPT" >/dev/null 2>"$TEST_ROOT/uninstall-all-cancel.err"; then
  fail "完全删除不应接受普通 UNINSTALL 确认词"
fi
grep -q '未确认完全删除' "$TEST_ROOT/uninstall-all-cancel.err" || fail "完全删除取消提示缺失"
pass "uninstall --all 交互确认词"

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

generated_passphrase="$TEST_ROOT/generated-passphrase"
generated_env="$TEST_ROOT/generated-passphrase.env"
cp "$ENV_FILE" "$generated_env"
NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  ENV_FILE="$2"
  DEFAULT_BACKUP_PASSPHRASE_FILE="$3"
  BACKUP_PASSPHRASE_FILE=""
  ensure_backup_passphrase
  [[ -f "$3" ]]
  [[ "$(passphrase_file_mode "$3")" == 600 ]]
  grep -q "^NOJ_BACKUP_PASSPHRASE_FILE=$3$" "$2"
' bash "$DEPLOY_SCRIPT" "$generated_env" "$generated_passphrase" ||
  fail "首次部署未自动准备备份口令文件"
pass "备份口令文件自动准备与路径持久化"

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
grep -q '是否安装评测服务 Judge' "$DEPLOY_SCRIPT" || fail "Judge 安装选择提示缺失"
grep -q 'configure_env_interactive 1' "$DEPLOY_SCRIPT" || fail "重新填写未清空旧值默认值"
pass "重新填写和易懂配置提示"

skip_judge_config_env="$TEST_ROOT/skip-judge-config.env"
cp "$ENV_FILE" "$skip_judge_config_env"
if NOJ_DEPLOY_SOURCE_ONLY=1 bash -c '
  source "$1"
  ENV_FILE="$2"
  prompt_text() {
    case "$1" in
      安装版本*) PROMPT_VALUE=v0.8.0-rc.1 ;;
      网站地址*) PROMPT_VALUE=noj.example.com ;;
      邮件服务*) PROMPT_VALUE=disabled ;;
      评测服务连接位置*|评测服务连接编号*)
        printf "不应在跳过 Judge 后询问连接配置\n" >&2
        return 1
        ;;
      *) return 1 ;;
    esac
  }
  prompt_yes_no() {
    [[ "$1" == *"是否安装评测服务 Judge"* ]] && return 1
    return 0
  }
  configure_env_interactive 1
' bash "$DEPLOY_SCRIPT" "$skip_judge_config_env" \
  >"$TEST_ROOT/skip-judge-config.out" 2>"$TEST_ROOT/skip-judge-config.err"; then
  :
else
  fail "跳过 Judge 的配置向导失败"
fi
grep -q '^JUDGE_ENABLED=false$' "$skip_judge_config_env" || fail "跳过 Judge 后未写入关闭配置"
pass "配置向导可跳过 Judge 连接配置"

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

no_admin_env="$TEST_ROOT/no-admin.env"
cp "$ENV_FILE" "$no_admin_env"
sed -i.bak -e '/^ADMIN_EMAIL=/d' -e '/^ADMIN_PASS=/d' "$no_admin_env"
run_deploy_with "$no_admin_env" start >/dev/null 2>"$TEST_ROOT/no-admin.err" ||
  fail "没有管理员环境变量时合法配置不应失败"
if grep -q '管理员邮箱' "$DEPLOY_SCRIPT"; then
  fail "生产配置向导不应继续询问管理员邮箱"
fi
pass "无需预先配置管理员"

cat >"$TEST_ROOT/cosign" <<'EOF'
#!/usr/bin/env bash
exit 91
EOF
chmod +x "$TEST_ROOT/cosign"
run_deploy start >"$TEST_ROOT/signature-disabled.out" 2>"$TEST_ROOT/signature-disabled.err" ||
  fail "默认关闭镜像签名校验时不应要求 Cosign"
grep -q '已关闭镜像签名校验' "$TEST_ROOT/signature-disabled.err" ||
  fail "关闭镜像签名校验时未给出提示"
pass "默认关闭镜像签名校验"

if run_deploy start >/dev/null 2>"$TEST_ROOT/start.err"; then
  :
else
  fail "合法配置的 start 不应失败"
fi
grep -q 'compose.*up -d --wait' "$FAKE_LOG" || fail "start 未调用 Compose 健康等待"
grep -q 'compose.*up -d --force-recreate --no-deps nginx' "$FAKE_LOG" ||
  fail "启动或升级后未刷新 Nginx 上游容器"
grep -q 'compose.*--profile judge.*up -d --wait' "$FAKE_LOG" || fail "启用 Judge 时未启用 Compose profile"
if grep -q 'down -v' "$FAKE_LOG"; then fail "部署脚本不得删除数据卷"; fi
pass "启动参数与数据卷安全边界"

grep -q 'pg_restore --list < "\$temp/postgres.dump"' "$SCRIPT_DIR/backup.sh" ||
  fail "PostgreSQL 备份未从标准输入校验 dump"
if grep -q 'pg_restore --list - < "\$temp/postgres.dump"' "$SCRIPT_DIR/backup.sh"; then
  fail "PostgreSQL 备份仍传递不兼容的 - 文件参数"
fi
pass "PostgreSQL 备份结构校验"

skip_judge_env="$TEST_ROOT/skip-judge.env"
cp "$ENV_FILE" "$skip_judge_env"
printf 'JUDGE_ENABLED=false\n' >>"$skip_judge_env"
skip_judge_log_lines="$(wc -l <"$FAKE_LOG")"
run_deploy_with "$skip_judge_env" start >"$TEST_ROOT/skip-judge.out" 2>"$TEST_ROOT/skip-judge.err" ||
  fail "跳过 Judge 后合法配置的 start 不应失败"
grep -q '已跳过 Judge Docker socket 检查' "$TEST_ROOT/skip-judge.out" ||
  fail "跳过 Judge 后未跳过 socket 检查"
if tail -n +$((skip_judge_log_lines + 1)) "$FAKE_LOG" | grep -- '--profile judge' >/dev/null; then
  fail "跳过 Judge 后不应启用 Compose judge profile"
fi
pass "跳过 Judge 时不检查、不启动 Judge"

sed -i.bak 's/^JUDGE_ENABLED=false$/JUDGE_ENABLED=true/' "$skip_judge_env"
run_deploy_with "$skip_judge_env" start >"$TEST_ROOT/re-enable-judge.out" 2>"$TEST_ROOT/re-enable-judge.err" ||
  fail "重新启用 Judge 后合法配置的 start 不应失败"
grep -q 'compose.*--profile judge.*up -d --wait' "$FAKE_LOG" ||
  fail "重新启用 Judge 后未启用 Compose profile"
pass "Judge 可通过配置重新启用"

run_deploy stop >/dev/null 2>"$TEST_ROOT/stop.err" || fail "合法配置的 stop 不应失败"
grep -q 'compose.*stop' "$FAKE_LOG" || fail "stop 未调用 Compose stop"
run_deploy upgrade >/dev/null 2>"$TEST_ROOT/upgrade.err" || fail "合法配置的 upgrade 不应失败"
grep -q 'compose.*pull' "$FAKE_LOG" || fail "upgrade 未拉取镜像"

uninstall_log_lines="$(wc -l <"$FAKE_LOG")"
run_deploy uninstall --yes >/dev/null 2>"$TEST_ROOT/uninstall.err" ||
  fail "合法配置的 uninstall 不应失败"
tail -n +$((uninstall_log_lines + 1)) "$FAKE_LOG" | grep -E -q 'compose.*--profile judge.*down.*--remove-orphans.*--rmi local' ||
  fail "uninstall 未清理全部 Compose profile 的容器、网络和本地镜像"
if tail -n +$((uninstall_log_lines + 1)) "$FAKE_LOG" | grep -E -q 'down.*(--volumes|-v)'; then
  fail "uninstall 不得删除数据卷"
fi
pass "uninstall 清理范围与数据卷保护"

uninstall_no_confirm_lines="$(wc -l <"$FAKE_LOG")"
if NOJ_DEPLOY_TTY_PATH="$TEST_ROOT/no-tty" run_deploy uninstall >"$TEST_ROOT/uninstall-no-confirm.out" 2>&1; then
  fail "非交互 uninstall 未确认时应返回非零退出码"
fi
[[ "$(wc -l <"$FAKE_LOG")" == "$uninstall_no_confirm_lines" ]] ||
  fail "未确认 uninstall 时不应调用 Docker"
grep -q '请显式使用 --yes' "$TEST_ROOT/uninstall-no-confirm.out" ||
  fail "未确认 uninstall 的提示不清晰"
pass "uninstall 未确认保护"

uninstall_all_log_lines="$(wc -l <"$FAKE_LOG")"
run_deploy uninstall --all --yes >/dev/null 2>"$TEST_ROOT/uninstall-all.err" ||
  fail "合法配置的 uninstall --all 不应失败"
tail -n +$((uninstall_all_log_lines + 1)) "$FAKE_LOG" | grep -E -q 'compose.*--profile judge.*down.*--remove-orphans.*--rmi all.*--volumes' ||
  fail "uninstall --all 未清理全部 Compose 数据"
pass "uninstall --all 数据清理参数"

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

: >"$FAKE_LOG"
config_before="$(openssl dgst -sha256 "$TEST_ROOT/signed.env")"
run_deploy_with "$TEST_ROOT/signed.env" config-check >"$TEST_ROOT/config-check.out" 2>&1 || fail "只读配置校验失败"
if grep -Eq 'buildx|imagetools| up | pull| down | exec ' "$FAKE_LOG"; then
  fail "配置校验不应检查远端镜像或修改服务"
fi
[[ "$(openssl dgst -sha256 "$TEST_ROOT/signed.env")" == "$config_before" ]] || fail "配置校验修改了生产配置"
pass "配置校验不检查远端镜像、不修改服务和配置"

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
