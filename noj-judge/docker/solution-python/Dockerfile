# noj-solution-python: 双容器模式下 Solution 容器运行时
#
# 设计稿 §5 + §6：
# - 默认 network_mode=none
# - 不挂载支持包
# - 不读取 Evaluator 环境变量
# - 内置 noj_solution_sdk（register + host 模块）
#
# 入口：noj-judge 通过 docker exec 启动 `python3 -m noj_solution_sdk.host --entry <file>`
# 容器默认 cmd 设为 sleep infinity（容器本身不主动跑东西，由 exec 注入 host 进程）。

FROM python:3.12-slim
LABEL org.opencontainers.image.description="Neuro OJ Dual-container Solution (Python 3.12, noj_solution_sdk)"
LABEL com.noj.judge.kind="solution"

# 安装 SDK 源码
# 跳过外层 noj_solution_sdk/，让其内容直接落在 site-packages/noj_solution_sdk/
COPY sdk/solution/noj_solution_sdk/ /usr/local/lib/python3.12/site-packages/noj_solution_sdk/

# 验证 SDK 可导入（构建期 sanity check）
RUN python3 -c "import noj_solution_sdk; from noj_solution_sdk.host import main; from noj_solution_sdk.registry import register; print('noj_solution_sdk OK')"

# 默认 cmd 为 sleep infinity —— 容器通过 docker exec 启动 host
CMD ["sleep", "infinity"]