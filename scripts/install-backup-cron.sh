#!/usr/bin/env bash
# scripts/install-backup-cron.sh（issue #103 修订）
#
# 为生产部署安装定时任务：每日自动 DB 备份 +（可选）证书续期检查。
#
# 设计：
#   - 优先用 systemd timer（现代 Linux 标配，可见性 / 日志 / 失败告警好）
#   - 若 systemd 不可用（容器 / 旧系统），降级到 crontab
#   - 备份任务每天 03:00 触发
#   - 续期任务每天 03:30 触发（避免与备份同时跑导致 IO 抖动）
#
# 用法（宿主机执行，需 root 或 sudo）：
#   sudo ./scripts/install-backup-cron.sh                    # 仅安装备份
#   sudo ./scripts/install-backup-cron.sh --with-cert-renew # 同时安装续期
#   sudo ./scripts/install-backup-cron.sh --uninstall        # 卸载两个
#   sudo ./scripts/install-backup-cron.sh --status           # 查看状态

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/env.prod.sh"

SYSTEMD_DIR="/etc/systemd/system"
CRON_FILE="/etc/cron.d/noj-backup-and-cert"

WITH_CERT=0
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-cert-renew) WITH_CERT=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --status) ACTION="status"; shift ;;
    -h|--help)
      sed -n '3,20p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "❌ 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ─── 校验前置 ───
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ $ENV_FILE 不存在" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker 未安装" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "❌ docker compose v2 未安装" >&2
  exit 1
fi

# ─── 检测 systemd 可用性 ───
HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
  HAS_SYSTEMD=1
fi

# ─── 检测是否 root ───
if [[ $EUID -ne 0 ]]; then
  echo "⚠ 此脚本需要 root 权限（写 systemd unit / /etc/cron.d）" >&2
  echo "  请用：sudo $0 $*" >&2
  exit 1
fi

# ─── uninstall ───
if [[ "$ACTION" == "uninstall" ]]; then
  echo "▶ 卸载..."

  if [[ $HAS_SYSTEMD -eq 1 ]]; then
    if systemctl list-unit-files noj-backup.timer >/dev/null 2>&1; then
      systemctl disable --now noj-backup.timer 2>/dev/null || true
      rm -f "$SYSTEMD_DIR/noj-backup.service" "$SYSTEMD_DIR/noj-backup.timer"
      echo "  ✓ noj-backup.timer 已卸载"
    fi
    if [[ $WITH_CERT -eq 1 ]] || systemctl list-unit-files noj-cert-renew.timer >/dev/null 2>&1; then
      systemctl disable --now noj-cert-renew.timer 2>/dev/null || true
      rm -f "$SYSTEMD_DIR/noj-cert-renew.service" "$SYSTEMD_DIR/noj-cert-renew.timer"
      echo "  ✓ noj-cert-renew.timer 已卸载"
    fi
    systemctl daemon-reload
  fi

  if [[ -f "$CRON_FILE" ]]; then
    rm -f "$CRON_FILE"
    echo "  ✓ $CRON_FILE 已移除"
  fi

  echo "✓ 卸载完成"
  exit 0
fi

# ─── status ───
if [[ "$ACTION" == "status" ]]; then
  echo "▶ 当前定时任务状态："
  if [[ $HAS_SYSTEMD -eq 1 ]]; then
    for unit in noj-backup.timer noj-cert-renew.timer; do
      if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
        echo
        echo "[systemd: $unit]"
        systemctl status "$unit" --no-pager 2>&1 | head -10 || true
        echo "---"
        systemctl list-timers "$unit" --no-pager 2>&1 | head -5 || true
      else
        echo
        echo "[systemd: $unit] 未安装"
      fi
    done
  fi
  if [[ -f "$CRON_FILE" ]]; then
    echo
    echo "[crontab: $CRON_FILE]"
    cat "$CRON_FILE"
  fi
  exit 0
fi

# ─── install ───
echo "▶ 安装定时任务..."
echo "  systemd 可用: $HAS_SYSTEMD"
echo "  同时安装证书续期: $WITH_CERT"
echo

# 备份 / 续期调用的 docker compose 命令（cd 到 ROOT_DIR 以解析 env.prod.sh）
BACKUP_CMD="/usr/bin/docker compose -f $COMPOSE_FILE exec -T postgres /usr/local/bin/backup.sh"
CERT_CMD="/usr/bin/docker compose -f $COMPOSE_FILE run --rm certbot renew --webroot -w /var/www/certbot --deploy-hook 'echo CERT_RENEWED' && /usr/bin/docker compose -f $COMPOSE_FILE exec nginx nginx -s reload 2>/dev/null || /usr/bin/docker compose -f $COMPOSE_FILE restart nginx"

if [[ $HAS_SYSTEMD -eq 1 ]]; then
  echo "▶ 安装 systemd units..."

  # ── backup service + timer ──
  cat > "$SYSTEMD_DIR/noj-backup.service" <<EOF
[Unit]
Description=Neuro OJ PostgreSQL backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$BACKUP_CMD
StandardOutput=append:/var/log/noj-backup.log
StandardError=append:/var/log/noj-backup.log
EOF

  cat > "$SYSTEMD_DIR/noj-backup.timer" <<'EOF'
[Unit]
Description=Daily Neuro OJ backup at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now noj-backup.timer
  echo "  ✓ noj-backup.timer 已启用（每日 03:00 ± 5min 随机延迟）"

  # ── cert-renew service + timer ──
  if [[ $WITH_CERT -eq 1 ]]; then
    cat > "$SYSTEMD_DIR/noj-cert-renew.service" <<EOF
[Unit]
Description=Neuro OJ Let's Encrypt renewal check
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/bin/bash -c '$CERT_CMD'
StandardOutput=append:/var/log/noj-cert-renew.log
StandardError=append:/var/log/noj-cert-renew.log
EOF

    cat > "$SYSTEMD_DIR/noj-cert-renew.timer" <<'EOF'
[Unit]
Description=Daily Neuro OJ cert renewal check at 03:30

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

    systemctl enable --now noj-cert-renew.timer
    echo "  ✓ noj-cert-renew.timer 已启用（每日 03:30 ± 5min）"
  fi

  echo
  echo "✓ 安装完成。可用："
  echo "    systemctl status noj-backup.timer"
  echo "    systemctl list-timers"
else
  # ── crontab fallback ──
  echo "▶ 安装 crontab..."

  cat > "$CRON_FILE" <<EOF
# Neuro OJ 自动备份与证书续期（由 scripts/install-backup-cron.sh 生成）
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$ROOT_DIR

# 每日 03:00 备份 PostgreSQL
0 3 * * * root $BACKUP_CMD >> /var/log/noj-backup.log 2>&1
EOF

  if [[ $WITH_CERT -eq 1 ]]; then
    cat >> "$CRON_FILE" <<EOF

# 每日 03:30 检查证书续期（仅实际续期时 reload nginx）
30 3 * * * root /bin/bash -c '$CERT_CMD' >> /var/log/noj-cert-renew.log 2>&1
EOF
  fi

  chmod 0644 "$CRON_FILE"
  echo "  ✓ $CRON_FILE 已写入"
fi

echo
echo "▶ 验证（手动跑一次）："
echo "    docker compose -f $COMPOSE_FILE exec -T postgres /usr/local/bin/backup.sh"