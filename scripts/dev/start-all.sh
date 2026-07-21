#!/usr/bin/env bash
#
# 一键启动整套 NOJ 开发环境
#
# 启动顺序(依赖关系):
#   1. 基础设施(PostgreSQL + Redis)
#   2. noj-core(后端) —— 等待 health 检查通过
#   3. noj-ui(前端) —— 等待端口就绪
#   4. noj-judge(评测 Worker) —— 等待队列监听
#
# 使用: bash scripts/dev/start-all.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo " Neuro OJ — 一键启动"
echo "=========================================="
echo ""

echo ">>> [1/4] 启动基础设施..."
bash "$SCRIPT_DIR/start-infra.sh"

echo ""
echo ">>> [2/4] 启动 noj-core..."
bash "$SCRIPT_DIR/start-core.sh"

echo ""
echo ">>> [3/4] 启动 noj-ui..."
bash "$SCRIPT_DIR/start-ui.sh"

echo ""
echo ">>> [4/4] 启动 noj-judge..."
bash "$SCRIPT_DIR/start-judge.sh"

echo ""
echo "=========================================="
echo " ✓ 全部模块已启动"
echo "=========================================="
echo ""
echo "访问入口:"
echo "  前端:     http://localhost:3000"
echo "  后端 API: http://localhost:8000"
echo "  健康检查: curl http://localhost:8000/health"
echo ""
echo "查看状态: bash scripts/dev/status.sh"
echo "停止全部: bash scripts/dev/stop-all.sh"