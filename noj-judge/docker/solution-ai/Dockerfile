# noj-solution-ai: 双容器模式下 Solution AI 推理容器
#
# 面向 IOAI / NOAI / LMCC 的 CV/ML 小模型题：
# - CPU 版 torch/torchvision（当前无 GPU 需求）
# - 预装 CV/ML 常用库
# - 内置 noj_solution_sdk（register + host 模块）
#
# 入口：noj-judge 通过 docker exec 启动 `python3 -m noj_solution_sdk.host --entry <file>`
# 容器默认 cmd 设为 sleep infinity（容器本身不主动跑东西，由 exec 注入 host 进程）。

FROM python:3.12-slim@sha256:d764629ce0ddd8c71fd371e9901efb324a95789d2315a47db7e4d27e78f1b0e9
LABEL org.opencontainers.image.description="Neuro OJ Dual-container Solution AI (Python 3.12, CPU torch, noj_solution_sdk)"
LABEL com.noj.judge.kind="solution"

# 安装 CPU 版 PyTorch 与 CV/ML 常用库
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch torchvision \
 && pip install --no-cache-dir \
    numpy scipy pandas scikit-learn \
    opencv-python-headless \
    Pillow matplotlib \
    safetensors

# 安装 SDK 源码
COPY sdk/solution/noj_solution_sdk/ /usr/local/lib/python3.12/site-packages/noj_solution_sdk/

# 验证 SDK 可导入（构建期 sanity check）
RUN python3 -c "import noj_solution_sdk; from noj_solution_sdk.host import main; from noj_solution_sdk.registry import register; import torch, torchvision; print('noj_solution_sdk OK', torch.__version__)"

# NOJ-168/NOJ-171/NOJ-187：固定 base digest、非 root 运行、禁止 pycache 写 rootfs。
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=1
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj \
    && mkdir -p /workspace \
    && chown noj:noj /workspace
USER noj
WORKDIR /workspace

CMD ["sleep", "infinity"]
