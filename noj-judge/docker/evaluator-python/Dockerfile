# noj-evaluator-python: 双容器模式下 Evaluator 容器运行时
#
# 设计稿 §5：
# - 默认 network_mode=none（评测时由 docker run / pool 加参数）
# - 不挂载支持包（运行时由 noj-judge 注入）
# - 内置 noj_evaluator_sdk（SolutionRunner + result.accept / wrong_answer）
#
# 入口：noj-judge 启动时通过 docker exec 在容器内跑 <runtime_config.evaluator.command>
# （如 `python3 /workspace/evaluate.py`）。容器默认 cmd 设为 sleep infinity，
# 因为容器是通过 exec 启动评测脚本而非 docker run。

FROM python:3.12-slim
LABEL org.opencontainers.image.description="Neuro OJ Dual-container Evaluator (Python 3.12, noj_evaluator_sdk)"
LABEL com.noj.judge.kind="evaluator"

# 安装 SDK 源码
# 注：noj-judge/sdk/evaluator/noj_evaluator_sdk/ 是包目录
# COPY 时跳过外层 noj_evaluator_sdk/，让其内容直接落在 site-packages/noj_evaluator_sdk/
COPY sdk/evaluator/noj_evaluator_sdk/ /usr/local/lib/python3.12/site-packages/noj_evaluator_sdk/

# 验证 SDK 可导入（构建期 sanity check）
RUN python3 -c "import noj_evaluator_sdk; from noj_evaluator_sdk.runner import SolutionRunner; from noj_evaluator_sdk.result import Result; print('noj_evaluator_sdk OK')"

# 默认 cmd 为 sleep infinity —— 容器通过 docker exec 启动评测脚本
CMD ["sleep", "infinity"]