FROM denoland/deno:alpine-2.9.5@sha256:7ef8943fede9b4ec021465dcadb98c9cefeef7121ae7eb2369fbd5bd354d27f8
LABEL org.opencontainers.image.description="Neuro OJ LLM Gateway (Deno + Hono)"

WORKDIR /app
COPY deno.json .
COPY deno.lock .
COPY src/ ./src/

# 使用固定 UID 的非 root 用户运行服务。
RUN addgroup -S -g 10001 noj \
    && adduser -S -D -H -u 10001 -G noj noj \
    && mkdir -p /deno-dir \
    && chown -R noj:noj /deno-dir

# 在固定 digest 的基础镜像上安装 Alpine 安全更新。
RUN apk upgrade --no-cache

# 构建期缓存依赖，保证可复现；运行时仍以 lock 为准
ENV DENO_DIR=/deno-dir
RUN deno cache --lock=deno.lock src/main.ts

RUN chown -R noj:noj /app /deno-dir

ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8001

USER noj

CMD ["deno", "run", "-A", "src/main.ts"]
