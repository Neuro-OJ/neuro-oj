#!/usr/bin/env bash
#
# 一键停止整套 NOJ 开发环境
#
# 停止顺序(反向依赖):
#   1. noj-judge(先停 worker,避免接新任务)
#   2. noj-ui
#   3. noj-core
#   4. 基础设施(保留数据卷)
#
# 使用: bash scripts/dev/stop-all.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo " Neuro OJ — 一键停止"
echo "=========================================="
echo ""

echo ">>> [1/4] 停止 noj-judge..."
bash "$SCRIPT_DIR/stop-judge.sh" || true

echo ""
echo ">>> [2/4] 停止 noj-ui..."
bash "$SCRIPT_DIR/stop-ui.sh" || true

echo ""
echo ">>> [3/4] 停止 noj-core..."
bash "$SCRIPT_DIR/stop-core.sh" || true

echo ""
echo ">>> [4/4] 停止基础设施..."
bash "$SCRIPT_DIR/stop-infra.sh" || true

echo ""
echo "=========================================="
echo " ✓ 全部模块已停止"
echo "=========================================="
echo ""
echo "数据卷未删除,数据库和 Redis 数据保留"
echo "重启:  bash scripts/dev/start-all.sh"