#!/usr/bin/env bash
# scripts/init-letsencrypt.sh（issue #103）
#
# 首次部署时的 Let's Encrypt 证书初始化：
#   1. 校验 env.prod.sh 含必填项（YOUR_DOMAIN / LE_EMAIL）
#   2. 先以"占位配置"启动 nginx（仅 80 端口可服务 ACME challenge）
#   3. certbot webroot 模式签发证书
#   4. 重启 nginx 让其加载完整配置（含 443 HTTPS / 限流 / 反代）
#   5. （后续）certbot 容器每 12h 自动 renew
#
# 用法：
#   1. cp env.prod.example env.prod.sh
#   2. 编辑 env.prod.sh，填必填项
#   3. bash scripts/init-letsencrypt.sh
#   4. docker compose -f docker-compose.prod.yml up -d（启动完整栈）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/env.prod.sh"
NGINX_TEMPLATE_DIR="$ROOT_DIR/docker/nginx/templates"
TEMP_NGINX_CONF="$ROOT_DIR/docker/nginx/nginx.temp.conf"

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

echo "▶ 配置："
echo "   DOMAIN = $YOUR_DOMAIN"
echo "   EMAIL  = $LE_EMAIL"
echo

# ─── 临时 nginx 配置：只服务 80 端口（ACME challenge）───
# 启动首次 certbot 之前需要先让 nginx 跑起来（HTTP 可达），
# 但完整模板（443 + 速率限制 + SSL）需要证书存在。
# 故先用一个临时占位 nginx.conf（仅 80）+ 起 nginx + certbot + 切回完整配置

echo "▶ 生成临时 nginx 配置（仅 80 端口）..."

cat > "$TEMP_NGINX_CONF" <<'NGINX_EOF'
user  nginx;
worker_processes  auto;
error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;
events { worker_connections 1024; }
http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    server {
        listen      80 default_server;
        listen      [::]:80 default_server;
        server_name _;
        location ^~ /.well-known/acme-challenge/ {
            root /var/www/certbot;
            default_type "text/plain";
        }
        location / {
            return 200 "NOJ: cert issuance in progress.\n";
            add_header Content-Type text/plain;
        }
    }
}
NGINX_EOF

# 用临时配置启动 nginx
echo "▶ 启动 nginx（临时占位配置）..."

# 备份主配置（如果不存在）
if [[ -f "$ROOT_DIR/docker/nginx/nginx.conf" && ! -f "$ROOT_DIR/docker/nginx/nginx.conf.bak" ]]; then
  cp "$ROOT_DIR/docker/nginx/nginx.conf" "$ROOT_DIR/docker/nginx/nginx.conf.bak"
fi

# 用临时配置替换主配置
cp "$TEMP_NGINX_CONF" "$ROOT_DIR/docker/nginx/nginx.conf"

# 启动仅 nginx（其它服务暂不起）
docker compose -f "$COMPOSE_FILE" up -d nginx
sleep 5

# 验证 80 端口可达
echo "▶ 验证 80 端口..."
if ! docker compose -f "$COMPOSE_FILE" exec -T nginx wget --spider --quiet http://localhost/ 2>&1; then
  echo "❌ nginx 80 端口不可达" >&2
  # 回滚主配置
  if [[ -f "$ROOT_DIR/docker/nginx/nginx.conf.bak" ]]; then
    mv "$ROOT_DIR/docker/nginx/nginx.conf.bak" "$ROOT_DIR/docker/nginx/nginx.conf"
  fi
  rm -f "$TEMP_NGINX_CONF"
  exit 1
fi

# ─── 签发证书 ───
echo "▶ 签发证书（webroot 模式）..."
docker compose -f "$COMPOSE_FILE" run --rm certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d "$YOUR_DOMAIN" \
  --email "$LE_EMAIL" \
  --agree-tos \
  --no-bootstrap \
  --force-renewal

# ─── 切回完整 nginx 配置 ───
echo "▶ 切回完整配置（含 443 + 速率限制）..."

if [[ -f "$ROOT_DIR/docker/nginx/nginx.conf.bak" ]]; then
  mv "$ROOT_DIR/docker/nginx/nginx.conf.bak" "$ROOT_DIR/docker/nginx/nginx.conf"
fi
rm -f "$TEMP_NGINX_CONF"

# 重启 nginx 让其加载完整配置（包含 envsubst YOUR_DOMAIN + SSL 路径）
docker compose -f "$COMPOSE_FILE" restart nginx
sleep 3

# ─── 验证 ───
echo "▶ 验证 HTTPS..."
if docker compose -f "$COMPOSE_FILE" exec -T nginx sh -c "wget --spider --quiet https://localhost/ 2>&1 || exit 1"; then
  echo "✓ HTTPS 自检通过"
else
  echo "⚠ HTTPS 自检失败（容器内可能缺 CA bundle），请到宿主机："
  echo "    curl -v https://$YOUR_DOMAIN/health"
fi

echo
echo "═══════════════════════════════════════════════════════"
echo "✓ 初始化完成"
echo
echo "  证书路径：/etc/letsencrypt/live/$YOUR_DOMAIN/"
echo "  续期机制：certbot 容器内每 12h 自动 renew"
echo "            （建议同时配置宿主机 cron 调用 scripts/prod-renew-cert.sh）"
echo
echo "下一步："
echo "  docker compose -f $COMPOSE_FILE up -d   # 启动完整栈"
echo "  curl https://$YOUR_DOMAIN/health         # 验证健康"
echo "═══════════════════════════════════════════════════════"
