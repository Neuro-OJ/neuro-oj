# noj-evaluator-python: 双容器模式下 Evaluator 容器运行时
#
# 设计稿 §5：
# - 默认 network_mode=none（评测时由 noj-judge 双容器运行时加参数）
# - 不挂载支持包（运行时由 noj-judge 注入）
# - 内置 noj_evaluator_sdk（SolutionRunner + result.accept / wrong_answer）
#
# 入口：noj-judge 启动时通过 docker exec 在容器内跑 <runtime_config.evaluator.command>
# （如 `python3 /workspace/evaluate.py`）。容器默认 cmd 设为 sleep infinity，
# 因为容器是通过 exec 启动评测脚本而非 docker run。

FROM python:3.12-slim@sha256:a249c9f47e05708dd367f3fe8ada03cf347390fad66fb8b0518c0ef55ae3cb84
LABEL org.opencontainers.image.description="Neuro OJ Dual-container Evaluator (Python 3.12, noj_evaluator_sdk)"
LABEL com.noj.judge.kind="evaluator"

# 在固定 digest 的基础镜像上统一安装 Debian 和 Python 工具安全更新。
RUN apt-get update \
    && apt-get upgrade -y \
    && python3 -m pip install --no-cache-dir --upgrade \
      "setuptools>=78.1.1" \
      "wheel>=0.46.2" \
      "jaraco.context>=6.1.0" \
    && rm -rf /var/lib/apt/lists/*

# 安装 SDK 源码
# 注：noj-judge/sdk/evaluator/noj_evaluator_sdk/ 是包目录
# COPY 时跳过外层 noj_evaluator_sdk/，让其内容直接落在 site-packages/noj_evaluator_sdk/
COPY sdk/common/noj_sdk_common/ /usr/local/lib/python3.12/site-packages/noj_sdk_common/
COPY sdk/evaluator/noj_evaluator_sdk/ /usr/local/lib/python3.12/site-packages/noj_evaluator_sdk/

# 权限归一化（纵深防御）：容器以非 root（USER noj）运行，而 COPY 会**原样保留**
# 构建上下文中的文件模式。若开发者工作副本里的 SDK 源码权限异常收紧
# （例如 600），文件会以 root:root 0600 落进镜像，noj 用户随即无法读取，
# 表现为评测容器 import 失败：PermissionError: [Errno 13] ... __init__.py。
# 该故障会一次性打挂整个双容器 E2E 套件，且报错指向 Python 而非权限根因，难以定位。
# 注意：git 只跟踪可执行位，600 属于本地环境漂移，CI 全新检出为 644 因而正常——
# 也正因如此该问题只在本地复现。此处显式归一化，使镜像不再受源码模式影响。
RUN chmod -R a+rX /usr/local/lib/python3.12/site-packages/noj_sdk_common \
    /usr/local/lib/python3.12/site-packages/noj_evaluator_sdk

# 验证 SDK 可导入（构建期 sanity check）
RUN python3 -c "import noj_evaluator_sdk; from noj_evaluator_sdk.runner import SolutionRunner; from noj_evaluator_sdk.result import Result; print('noj_evaluator_sdk OK')"

# 默认 cmd 为 sleep infinity —— 容器通过 docker exec 启动评测脚本

# NOJ-168/NOJ-171/NOJ-187：固定 base digest、非 root 运行、禁止 pycache 写 rootfs。
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj \
    && mkdir -p /workspace \
    && chown noj:noj /workspace
USER noj
WORKDIR /workspace

CMD ["sleep", "infinity"]
