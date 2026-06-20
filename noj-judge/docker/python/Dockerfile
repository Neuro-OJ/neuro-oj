# noj-judge-python: Python 3 评测环境
#
# 评测容器仅提供 Python 运行时，评测脚本 (evaluate.py) 和用户代码
# 由 noj-judge 在运行时通过绑定挂载注入到 /tmp 目录。
# 容器内的入口是 judge_command（如 python3 /tmp/evaluate.py）。

FROM python:3.12-slim
LABEL org.opencontainers.image.description="Neuro OJ Python 3 Judge Environment"

# 评测脚本不需要额外依赖——所有依赖由 evaluate.py 自行管理。
# 后续可在需要时在这里安装通用依赖包。
