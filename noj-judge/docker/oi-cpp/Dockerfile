# noj-oi-cpp: 传统 OI C/C++ 编译与运行环境。
#
# noj-judge 通过 docker exec 注入 main.c/main.cpp，并在容器内编译；容器本身
# 只运行 sleep infinity。题包输入/输出由 worker 读取，用户代码只获得当前测试点
# 的 stdin，因此不会看到隐藏测试文件。

FROM gcc:13-bookworm
LABEL org.opencontainers.image.description="Neuro OJ native OI C/C++ runtime"
LABEL com.noj.judge.kind="oi"

# 与双容器运行时保持相同的非 root UID。运行时 /workspace 是受限 tmpfs，
# rootfs 保持只读，容器默认 network_mode=none。
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj \
    && mkdir -p /workspace \
    && chown noj:noj /workspace
USER noj
WORKDIR /workspace

CMD ["sleep", "infinity"]
