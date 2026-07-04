#!/usr/bin/env bash
# scripts/prod-renew-cert.sh（issue #103）
#
# 手动触发证书续期 + nginx reload。
# 推荐用法：宿主机每 12h cron 调用：
#   0 */12 * * * /opt/noj/scripts/prod-renew-cert.sh >> /var/log/noj-cert-renew.log 2>&1
#
# 实现：
#   1. 在 certbot 容器内运行 certbot renew
#   2. 若有证书被更新（exit 0 + stdout 含 'renewed'），通过 docker compose 重启 nginx
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
