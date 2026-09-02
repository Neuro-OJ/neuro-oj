# 服务端 CLI 初始化

这里的 CLI 是 `noj-server` 镜像内置的服务端管理命令（`/app/bin/noj`），用于数据库迁移、系统初始化、管理员引导与题目包操作。
它与仓库中的 `noj-cli` 源码工具相互独立；`noj-cli` 不作为 GitHub Release 二进制发布。

## 生产环境执行方式

生产环境不直接使用源码或 `deno task`，而是通过部署目录中的 Docker Compose，在 `noj-server` 镜像内执行 CLI：

```bash
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj <子命令>
```

常用子命令：

```bash
# 数据库迁移
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj db migrate

# 系统基础数据：root + RBAC + 评测镜像白名单 + 标签
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj init system

# 管理员引导（从部署配置或环境变量读取 ADMIN_EMAIL / ADMIN_PASS）
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj bootstrap admin

# 构建统一题目包（需要在镜像内包含 data/problems-src）
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj problems build

# 导入统一题目包
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj problems import
```

> 说明：`migrate` 服务本身已按顺序执行 `db migrate → init system → bootstrap admin`。
> 上面的 `run --rm` 方式用于需要单独执行某个子命令的场景。

## 开发环境

开发环境仍可使用源码目录下的 CLI：

```bash
cd noj-core
deno task db:migrate
deno task init:system
deno task bootstrap:admin
deno task problems:build
deno task problems:import
deno task dev-setup   # 仅开发/测试使用，包含 dev 专用数据
```

`dev-setup` 是开发环境一键初始化，**不用于生产部署**。

## 管理员初始化

`bootstrap admin` 支持环境变量或 CLI 参数：

```bash
# 环境变量（推荐）
ADMIN_EMAIL=admin@example.com ADMIN_PASS='...' deno task bootstrap:admin

# 或 CLI 参数
deno task bootstrap:admin -- --email admin@example.com --password '...'
```

- 设置了 `ADMIN_EMAIL` / `ADMIN_PASS`：创建或提升对应管理员，强制首次登录后修改密码。
- 未设置：在无任何可登录管理员时创建临时引导管理员（`admin@noj.local`，随机密码打印到终端）。

## 样例题同步

`data/problems-src/1001/` 中的 A+B 样例题通过 `problems:build` + `problems:import`
同步（manifest 带固定 `number`，id 一律由服务端生成 UUID；重复导入按
(type, number) 幂等更新，不会产生重复题目）。

正式出题建议：在 Web 管理界面创建题目，或打包统一题目包（见"出题人"文档）
后通过管理界面上传 / `problems:import` 导入。
