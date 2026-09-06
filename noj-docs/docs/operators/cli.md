# 服务端 CLI 初始化

这里的 CLI 是 `noj-server`
镜像内置的服务端管理命令（`/app/bin/noj`），用于数据库迁移、系统初始化、管理员引导与题目包操作。
它与宿主机的 `noj-cli` 相互独立；后者由一键安装器从 Release
下载，负责生产部署和运维。

## 生产环境执行方式

生产环境不直接使用源码或 `deno task`，而是通过部署目录中的 Docker Compose，在
`noj-server` 镜像内执行 CLI：

```bash
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core <子命令>
```

常用子命令：

```bash
# 数据库迁移
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core db migrate

# 系统基础数据：root + RBAC + 评测镜像白名单 + 标签
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core init system

# 首次管理员初始化（交互输入密码，仅空站）
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core bootstrap first-admin --username site_admin --email admin@example.com

# 构建统一题目包（需要在镜像内包含 data/problems-src）
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core problems build

# 导入统一题目包
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core problems import
```

> 说明：`migrate` 服务本身已按顺序执行
> `db migrate → init system`，不会自动创建或提升管理员。 上面的 `run --rm`
> 方式用于需要单独执行某个子命令的场景。

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

新站在开放注册前，由拥有服务器终端权限的部署者执行：

```bash
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \
  --entrypoint /app/bin/noj core bootstrap first-admin --username site_admin --email admin@example.com
```

命令会隐藏输入并确认密码，不接受密码命令行参数，也不将密码打印到服务日志。首次登录必须修改密码。
源码环境可执行
`deno run --env-file=.env -A scripts/noj.ts bootstrap first-admin --username site_admin --email admin@example.com`。

- 仅空站（除系统 root 外无用户）可成功执行，并发执行只有一次成功。
- 成功后持久关闭初始化；删除管理员或重启也不会重新开放。已有用户的升级站点同样关闭。
- 无需网页认领凭证，不提供 HTTP
  初始化入口，因此无认领令牌的有效期或重复使用问题。
- 公开注册始终创建普通用户；如果已有普通用户，首次初始化会拒绝，不会提升该用户。
- 已有站点需要恢复管理员时，由部署者人工核实用户身份后使用维护命令
  `bootstrap admin`（通过 `ADMIN_EMAIL`
  指定目标）。该命令可以提升已有用户，只用于明确授权的本机维护，不应加入启动或升级流程。
- `dev-setup` 与旧 `bootstrap admin` 保留开发/维护用途；未指定 `ADMIN_EMAIL`
  时旧命令仍会打印开发引导密码，生产首次初始化应使用 `bootstrap first-admin`。

## 样例题同步

`data/problems-src/1001/` 中的 A+B 样例题通过 `problems:build` +
`problems:import` 同步（manifest 带固定 `number`，id 一律由服务端生成
UUID；重复导入按 (type, number) 幂等更新，不会产生重复题目）。

正式出题建议：在 Web 管理界面创建题目，或打包统一题目包（见"出题人"文档）
后通过管理界面上传 / `problems:import` 导入。
