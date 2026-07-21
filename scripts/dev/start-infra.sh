#!/usr/bin/env bash
#
# 启动基础设施(PostgreSQL + Redis)
#
# 使用: bash scripts/dev/start-infra.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "错误: 找不到 $COMPOSE_FILE"
  exit 1
fi

cd "$REPO_ROOT"

echo ">>> 启动基础设施(PostgreSQL + Redis)..."
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo ">>> 等待服务就绪..."

# 等待 PostgreSQL
for i in {1..30}; do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U noj >/dev/null 2>&1; then
    echo "✓ PostgreSQL 已就绪"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo "✗ PostgreSQL 启动超时"
    exit 1
  fi
done

# 等待 Redis
for i in {1..15}; do
  if docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo "✓ Redis 已就绪"
    break
  fi
  sleep 1
  if [[ $i -eq 15 ]]; then
    echo "✗ Redis 启动超时"
    exit 1
  fi
done

echo ""
echo ">>> 基础设施已启动"
echo "PostgreSQL: localhost:5432 (noj / noj / 数据库 noj)"
echo "Redis:      localhost:6379 (无认证)"