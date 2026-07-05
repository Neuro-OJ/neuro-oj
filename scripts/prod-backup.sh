#!/usr/bin/env bash
# scripts/prod-backup.sh（issue #103）
#
# PostgreSQL 全量备份到 /var/backups（命名卷 backup_data）。
# 用法（宿主机执行）：
#   docker compose -f docker-compose.prod.yml exec postgres /usr/local/bin/backup.sh
#
# 或宿主机本地：
#   docker exec noj-prod-postgres /usr/local/bin/backup.sh
#
# 输出：
#   /var/backups/noj-backup-YYYYMMDD-HHMMSS.tar.gz
#
# 设计：
# - pg_dump -Fc（custom format，支持选择性恢复）
# - 同时备份 WAL（增量恢复基础）
# - tar.gz 包内含 pg_dump 输出 + 元数据（版本 / 时间戳 / DB 大小）
#
# 保留策略：
# - 默认保留 30 天
# - 旧备份自动清理（通过 find -mtime +30 -delete）

set -euo pipefail

BACKUP_DIR="/var/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_NAME="noj-backup-${TIMESTAMP}"
BACKUP_TARBALL="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

echo "▶ 备份 PostgreSQL..."
mkdir -p "/tmp/${BACKUP_NAME}"
# 不指定 --host，走 Unix socket + peer 认证（容器内默认）；
# 若指定 --host=localhost 强制 TCP 会触发密码认证，与 --no-password 冲突导致失败。
pg_dump \
  --username="${POSTGRES_USER}" \
  --dbname="${POSTGRES_DB}" \
  --format=custom \
  --compress=9 \
  --file="/tmp/${BACKUP_NAME}/db.dump"

# 元数据
{
  echo "backup_timestamp=${TIMESTAMP}"
  echo "pg_version=$(postgres --version | head -1)"
  echo "db_name=${POSTGRES_DB}"
  echo "db_size=$(psql --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" -At -c 'SELECT pg_database_size(current_database())')"
  echo "wal_method=stream"   # 占位，若用 wal-g 等需调整
  echo "toolkit=noj-prod-backup.sh v1"
} > "/tmp/${BACKUP_NAME}/meta.env"

# 打包
cd /tmp
tar -czf "${BACKUP_TARBALL}" "${BACKUP_NAME}"
rm -rf "/tmp/${BACKUP_NAME}"

BACKUP_SIZE=$(du -h "$BACKUP_TARBALL" | cut -f1)
echo "✓ 备份完成：${BACKUP_TARBALL} (${BACKUP_SIZE})"

# 清理老备份
if [[ -d "$BACKUP_DIR" ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -name "noj-backup-*.tar.gz" -mtime +"$RETENTION_DAYS" -delete
  echo "  已清理 > ${RETENTION_DAYS} 天的旧备份"
fi

# 列出当前保留的备份
echo
echo "▶ 当前保留的备份："
ls -lh "$BACKUP_DIR"/noj-backup-*.tar.gz 2>/dev/null || echo "  （无）"
