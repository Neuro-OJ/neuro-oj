FROM denoland/deno:alpine-2.9.5@sha256:7ef8943fede9b4ec021465dcadb98c9cefeef7121ae7eb2369fbd5bd354d27f8
LABEL org.opencontainers.image.description="Neuro OJ LLM Gateway (Deno + Hono)"

WORKDIR /app
COPY deno.json .
COPY deno.lock .
COPY src/ ./src/

# 构建期缓存依赖，保证可复现；运行时仍以 lock 为准
RUN deno cache --lock=deno.lock src/main.ts

ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8001

CMD ["deno", "run", "-A", "src/main.ts"]
