#!/usr/bin/env bash
# scripts/init-letsencrypt.sh（issue #103）
#
# 首次部署时的 Let's Encrypt 证书初始化：
#   1. 校验 env.prod.sh 含必填项（YOUR_DOMAIN / LE_EMAIL）
#   2. 用 docker-compose.init.yml（独立 nginx.conf + 仅 nginx/certbot 服务）
#      启动临时栈，**不修改 docker/nginx/nginx.conf 主配置**
#   3. certbot webroot 模式签发证书
#   4. 销毁临时栈 → 用户用 docker-compose.prod.yml 启动正式栈
#
# 设计说明（修复 init-letsencrypt race window）：
#   - 原版直接覆盖 docker/nginx/nginx.conf，靠 .bak 回滚；脚本中途崩溃
#     会污染主配置。
#   - 现版用 docker-compose.init.yml override，提供独立的 nginx.init.conf；
#     主配置全程不动；脚本退出只需 docker compose down 清理临时容器。
#
# 用法：
#   1. cp env.prod.example env.prod.sh
#   2. 编辑 env.prod.sh，填必填项
#   3. bash scripts/init-letsencrypt.sh
#   4. docker compose -f docker-compose.prod.yml up -d（启动完整栈）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_BASE="$ROOT_DIR/docker-compose.prod.yml"
COMPOSE_INIT="$ROOT_DIR/docker-compose.init.yml"
ENV_FILE="$ROOT_DIR/env.prod.sh"
INIT_PROJECT="noj-init"

# ─── 校验前置 ───
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE 不存在" >&2
  echo "   请先：cp env.prod.example env.prod.sh 并填写必填项" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${YOUR_DOMAIN:?请在 env.prod.sh 设置 YOUR_DOMAIN}"
: "${LE_EMAIL:?请在 env.prod.sh 设置 LE_EMAIL}"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker 命令未找到" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "❌ docker compose v2 未安装" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_INIT" ]]; then
  echo "❌ $COMPOSE_INIT 不存在（应为 docker-compose.init.yml）" >&2
  exit 1
fi

# 临时栈清理函数（异常退出时也调用）
cleanup() {
  echo
  echo "▶ 清理临时栈..."
  docker compose -f "$COMPOSE_INIT" -p "$INIT_PROJECT" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "▶ 配置："
echo "   DOMAIN = $YOUR_DOMAIN"
echo "   EMAIL  = $LE_EMAIL"
echo

# ─── 启动临时栈（init override）───
echo "▶ 启动临时 nginx（init override）..."

# 显式导出 YOUR_DOMAIN 让 docker compose 自动 envsubst 注入
export YOUR_DOMAIN

# 使用独立 init compose（-p noj-init 隔离 project，避免与正式栈冲突）
docker compose -f "$COMPOSE_INIT" -p "$INIT_PROJECT" up -d nginx
sleep 5

# 验证 80 端口可达
echo "▶ 验证 80 端口..."
if ! docker compose -f "$COMPOSE_INIT" -p "$INIT_PROJECT" exec -T nginx wget --spider --quiet http://localhost/ 2>&1; then
  echo "❌ nginx 80 端口不可达" >&2
  exit 1
fi

# ─── 签发证书 ───
echo "▶ 签发证书（webroot 模式）..."
docker compose -f "$COMPOSE_INIT" -p "$INIT_PROJECT" run --rm certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d "$YOUR_DOMAIN" \
  --email "$LE_EMAIL" \
  --agree-tos \
  --no-bootstrap \
  --force-renewal

# ─── 销毁临时栈 ───
echo "▶ 销毁临时栈（保留命名卷 letsencrypt_data / certbot_www）..."
docker compose -f "$COMPOSE_INIT" -p "$INIT_PROJECT" down --remove-orphans

# trap cleanup 现在无意义，显式解除
trap - EXIT

# ─── 验证（用户后续用正式栈自检）───
echo
echo "═══════════════════════════════════════════════════════"
echo "✓ 初始化完成"
echo
echo "  证书路径（命名卷 letsencrypt_data 内）："
echo "    /etc/letsencrypt/live/$YOUR_DOMAIN/fullchain.pem"
echo
echo "  ⚠️  续期机制（重要）："
echo "    本编排的 certbot 服务是 profiles: [\"certbot\"] 的工具容器，"
echo "    无长驻进程；不会自动续期。"
echo "    必须配置宿主机 cron 调用 scripts/prod-renew-cert.sh："
echo
echo "      # /etc/cron.d/noj-cert-renew（每天 03:30 检查一次）"
echo "      30 3 * * * root /opt/noj/scripts/prod-renew-cert.sh \\"
echo "        >> /var/log/noj-cert-renew.log 2>&1"
echo
echo "    或运行 ./scripts/install-backup-cron.sh --with-cert-renew"
echo "    一键安装（详见脚本 --help）"
echo
echo "下一步："
echo "  docker compose -f $COMPOSE_BASE up -d        # 启动完整栈"
echo "  curl https://$YOUR_DOMAIN/health              # 验证健康"
echo "═══════════════════════════════════════════════════════"