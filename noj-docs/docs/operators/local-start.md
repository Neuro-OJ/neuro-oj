# 本地启动

## 环境要求

- Deno 2.x
- Rust
- Docker
- 系统 `zip` 命令

## 启动基础设施

在仓库根目录运行：

```bash
docker compose up -d
```

默认会启动 PostgreSQL 和 Redis。

## 启动 noj-core

```bash
cd noj-core
deno task setup
deno task dev
```

`deno task setup` 会构建支持包并运行 seed。`deno task dev` 启动后端开发服务。

## 启动 noj-ui

```bash
cd noj-ui
deno install
deno task dev
```

默认前端地址为 `http://localhost:3000`。

## 启动 noj-judge

```bash
cd noj-judge
cargo run
```

Judge Worker 需要能访问 Docker daemon，并且 Redis 地址要与 noj-core 使用的 Redis 一致。

## 推荐启动顺序

1. PostgreSQL 和 Redis。
2. `noj-core`，让数据库迁移、seed 和结果消费者先启动。
3. `noj-ui`。
4. `noj-judge`。
