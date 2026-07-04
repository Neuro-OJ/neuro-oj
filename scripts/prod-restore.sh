#!/usr/bin/env bash
# scripts/prod-restore.sh（issue #103）
#
# 从 /var/backups/noj-backup-*.tar.gz 恢复 PostgreSQL。
#
# 用法（宿主机执行）：
#   ./scripts/prod-restore.sh /var/backups/noj-backup-20260101-120000.tar.gz
#
# 警告：会覆盖当前 DB！脚本会强制停止 core / judge 容器防止写入。

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "用法: $0 <backup.tar.gz>" >&2
  echo "  例如: $0 /var/backups/noj-backup-20260101-120000.tar.gz" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "❌ 备份文件不存在：$BACKUP_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"

if [[ ! -f "$ROOT_DIR/env.prod.sh" ]]; then
  echo "❌ $ROOT_DIR/env.prod.sh 不存在" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ROOT_DIR/env.prod.sh"

: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"

echo "▶ 准备恢复：$BACKUP_FILE"
echo "  目标 DB：${POSTGRES_DB}"
echo

# ─── 警告 ───
echo "⚠ 此操作会覆盖当前数据库 '$(POSTGRES_DB)'！"
echo "  建议：先 dump 当前 DB（防止误操作）"
read -rp "确认继续？输入 yes 继续： " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "已取消"
  exit 0
fi

# ─── 停 core / judge 防写入 ───
echo "▶ 停止 core / judge（防止写入）..."
docker compose -f "$COMPOSE_FILE" stop core judge || true

# ─── 解压备份 ───
TMP_DIR=$(mktemp -d)
trap "rm -rf '$TMP_DIR'" EXIT

echo "▶ 解压备份..."
tar -xzf "$BACKUP_FILE" -C "$TMP_DIR"

BACKUP_DIR_NAME=$(ls "$TMP_DIR" | head -1)
DUMP_FILE="$TMP_DIR/$BACKUP_DIR_NAME/db.dump"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "❌ 备份格式错误，找不到 db.dump" >&2
  exit 1
fi

# 显示元数据
if [[ -f "$TMP_DIR/$BACKUP_DIR_NAME/meta.env" ]]; then
  echo "▶ 备份元数据："
  cat "$TMP_DIR/$BACKUP_DIR_NAME/meta.env" | sed 's/^/  /'
  echo
fi

# ─── 恢复 DB ───
echo "▶ 恢复数据库..."
# 用 pg_restore --clean --if-exists 清掉现有对象再 restore
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  < "$DUMP_FILE" || {
    echo "❌ pg_restore 失败" >&2
    exit 1
  }

echo "✓ 恢复完成"

# ─── 重启 core / judge ───
echo "▶ 启动 core / judge..."
docker compose -f "$COMPOSE_FILE" start core judge

echo
echo "═══════════════════════════════════════════════════════"
echo "✓ 恢复完成"
echo "  下一步："
echo "    curl https://${YOUR_DOMAIN}/health   # 验证健康"
echo "    docker compose -f $COMPOSE_FILE logs --tail=20 core"
echo "═══════════════════════════════════════════════════════"
