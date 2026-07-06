#!/usr/bin/env bash
# scripts/prod-renew-cert.sh（issue #103）
#
# 手动 / 定时触发证书续期 + nginx reload。
#
# ⚠️ 重要：docker-compose.prod.yml 中的 certbot 服务是
# profiles: ["certbot"] 的工具容器，无长驻进程，不会自动续期。
# 必须由本脚本在宿主机执行，推荐通过 systemd timer 或 cron：
#
#   # 推荐：./scripts/install-backup-cron.sh --with-cert-renew 一键安装
#   # 或手动 crontab：30 3 * * * /opt/noj/scripts/prod-renew-cert.sh >> /var/log/noj-cert-renew.log 2>&1
#
# 实现：
#   1. 在 certbot 容器内运行 certbot renew
#   2. 若有证书被更新（stdout 含 'renewed'），通过 docker compose reload nginx
#
# 也可以让 certbot 容器内的 entrypoint 自带此行为，但需要在容器内调用
# 宿主机 docker 命令（或共享 sock）。本脚本以宿主机视角运行更干净。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"

if [[ ! -f "$ROOT_DIR/env.prod.sh" ]]; then
  echo "❌ $ROOT_DIR/env.prod.sh 不存在" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ROOT_DIR/env.prod.sh"

: "${YOUR_DOMAIN:?}"

echo "▶ [$(date -Iseconds)] certbot renew..."

# 执行 certbot renew（在 certbot 容器内）
# --deploy-hook 在证书实际更新时触发
OUTPUT=$(docker compose -f "$COMPOSE_FILE" run --rm certbot renew \
  --webroot -w /var/www/certbot \
  --deploy-hook "echo CERT_RENEWED" 2>&1) || true

echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "CERT_RENEWED"; then
  echo "▶ 证书已更新，重启 nginx 加载新证书..."
  docker compose -f "$COMPOSE_FILE" exec nginx nginx -s reload || \
    docker compose -f "$COMPOSE_FILE" restart nginx
  echo "✓ nginx 已 reload"
else
  echo "  （证书未到续期窗口，无需 reload）"
fi
