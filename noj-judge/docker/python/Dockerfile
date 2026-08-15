# noj-judge-python: Python 3 评测环境
#
# 评测容器仅提供 Python 运行时，评测脚本 (evaluate.py) 和用户代码
# 由 noj-judge 在运行时通过绑定挂载注入到 /tmp 目录。
# 容器内的入口是 judge_command（如 python3 /tmp/evaluate.py）。

FROM python:3.12-slim@sha256:d764629ce0ddd8c71fd371e9901efb324a95789d2315a47db7e4d27e78f1b0e9
LABEL org.opencontainers.image.description="Neuro OJ Python 3 Judge Environment"

# 评测脚本不需要额外依赖——所有依赖由 evaluate.py 自行管理。
# 后续可在需要时在这里安装通用依赖包。


# NOJ-168/NOJ-171/NOJ-187：固定 base digest、非 root 运行、禁止 pycache 写 rootfs。
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj \
    && mkdir -p /workspace \
    && chown noj:noj /workspace
USER noj
WORKDIR /workspace
