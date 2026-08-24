FROM denoland/deno:alpine-2.2.2
LABEL org.opencontainers.image.description="Neuro OJ LLM Gateway (Deno + Hono)"

WORKDIR /app
COPY deno.json .
COPY src/ ./src/

ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8001

CMD ["deno", "run", "-A", "src/main.ts"]
