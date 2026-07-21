#!/usr/bin/env bash
#
# 停止基础设施(保留数据卷)
#
# 使用: bash scripts/dev/stop-infra.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

cd "$REPO_ROOT"

echo ">>> 停止基础设施(数据卷保留)..."
docker compose -f "$COMPOSE_FILE" down

echo ""
echo ">>> 已停止。可使用 bash scripts/dev/start-infra.sh 重启"
echo "    数据卷未删除,持久化数据(PostgreSQL / Redis)保留"
echo ""
echo "    若要彻底清理数据卷(包括所有评测历史):"
echo "      docker compose -f $COMPOSE_FILE down -v"