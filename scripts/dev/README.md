# Neuro OJ — 本地开发运行脚本

> 本目录包含 Neuro OJ **本地开发**的完整启动/停止/状态脚本。所有脚本以
> `bash scripts/dev/<name>.sh` 形式调用。

---

## 快速开始(3 条命令)

```bash
# 1. 检测环境(可选,首次运行强烈推荐)
bash scripts/dev/install-deps.sh

# 2. 复制环境变量模板并填写必填项
cp scripts/dev/env.example noj-core/.env
# 编辑 noj-core/.env,至少填 DATABASE_URL 和 JWT_SECRET

# 3. 一键启动全部模块
bash scripts/dev/start-all.sh
```

启动完成后访问:

- **前端**: <http://localhost:3000>
- **后端 API**: <http://localhost:8000>
- **健康检查**: `curl http://localhost:8000/health`

---

## 脚本清单

| 脚本                   | 用途                              | 是否后台 | PID 文件               |
| ---------------------- | --------------------------------- | -------- | ---------------------- |
| `install-deps.sh`      | 检测/安装前置依赖                  | 否       | —                      |
| `env.example`          | `noj-core/.env` 模板              | —        | —                      |
| `start-infra.sh`       | 启动 PostgreSQL + Redis           | 否       | —                      |
| `stop-infra.sh`        | 停止基础设施(保留数据卷)           | 否       | —                      |
| `start-core.sh`        | 启动 noj-core(后端)               | 是       | `logs/core.pid`        |
| `stop-core.sh`         | 停止 noj-core                     | —        | —                      |
| `start-ui.sh`          | 启动 noj-ui(前端)                 | 是       | `logs/ui.pid`          |
| `stop-ui.sh`           | 停止 noj-ui                       | —        | —                      |
| `start-judge.sh`       | 启动 noj-judge(评测 Worker)        | 是       | `logs/judge.pid`       |
| `stop-judge.sh`        | 停止 noj-judge                    | —        | —                      |
| `start-all.sh`         | **一键启动** infra → core → ui → judge | —   | —                      |
| `stop-all.sh`          | **一键停止** judge → ui → core → infra | —   | —                      |
| `status.sh`            | 查看所有模块运行状态               | 否       | —                      |

所有后台运行的日志写入 `scripts/dev/logs/<module>.log`。

---

## 推荐启动顺序(手工分步)

需要单独控制某个模块的启动/重启时使用:

```bash
bash scripts/dev/start-infra.sh    # 1. 启动 PostgreSQL + Redis
bash scripts/dev/start-core.sh     # 2. 启动后端(等待 health OK)
bash scripts/dev/start-ui.sh       # 3. 启动前端(等待端口 3000)
bash scripts/dev/start-judge.sh    # 4. 启动评测 Worker(连接 Redis 队列)
```

查看运行状态:`bash scripts/dev/status.sh`

---

## 首次部署清单

### 1. 安装系统工具

```bash
sudo apt update && sudo apt install -y zip unzip curl
```

### 2. 安装 Deno(noj-core / noj-ui 运行时)

```bash
curl -fsSL https://deno.land/install.sh | sh
# 将 ~/.deno/bin 加入 PATH(临时)
export PATH="$HOME/.deno/bin:$PATH"
# 或写入 ~/.bashrc / ~/.zshrc 持久化
```

### 3. 安装 Rust(noj-judge 编译)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 4. 安装 Docker

参考 <https://docs.docker.com/engine/install/>,然后:

```bash
sudo systemctl start docker
sudo usermod -aG docker $USER  # 避免每次 sudo
# 重新登录后生效
```

### 5. 验证

```bash
bash scripts/dev/install-deps.sh
# 应该输出 4 个 ✓
```

---

## 配置文件

### `noj-core/.env`(必需)

```bash
cp scripts/dev/env.example noj-core/.env
```

| 变量              | 是否必填 | 说明                                          |
| ----------------- | -------- | --------------------------------------------- |
| `DATABASE_URL`    | ✅       | PostgreSQL 连接串                              |
| `JWT_SECRET`      | ✅       | ≥32 字符随机串,启动时会校验长度               |
| `ADMIN_EMAIL`     | 推荐     | 引导管理员邮箱(不设则自动生成临时密码)         |
| `ADMIN_PASS`      | 推荐     | 引导管理员密码(与 ADMIN_EMAIL 配合)            |
| `REDIS_URL`       | 否       | 默认 `redis://127.0.0.1:6379`                  |
| `PORT`            | 否       | 默认 `8000`                                    |
| `STORAGE_PROVIDER`| 否       | `local`(开发)/ `s3`(生产)                     |

> ⚠️ **记忆提示**:`deno task seed` 会忽略 `.env`,必须用
> `deno run --env-file=.env scripts/seed.ts` 或在 `deno task dev` 中启动
> (会自动加载 `.env`)。

### 生成 JWT_SECRET

```bash
openssl rand -base64 48
```

---

## 端口总览

| 模块       | 端口 | 验证                                              |
| ---------- | ---- | ------------------------------------------------- |
| PostgreSQL | 5432 | `psql -h localhost -U noj noj`                    |
| Redis      | 6379 | `redis-cli ping`                                  |
| noj-core   | 8000 | `curl http://localhost:8000/health`               |
| noj-ui     | 3000 | 浏览器 <http://localhost:3000>                    |
| noj-judge  | —    | 无 HTTP,通过 Redis `noj:judge:queue` 接收任务     |

---

## 常见故障排查(FAQ)

### ❌ `deno: command not found`

Deno 未安装或未加入 PATH。重新安装:

```bash
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"
```

### ❌ `cargo: command not found`

Rust 未安装:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### ❌ `zip: command not found`

`build-packages` 调用系统 `zip` 命令(非 JS 库):

```bash
sudo apt install -y zip unzip   # Debian/Ubuntu
brew install zip                 # macOS
```

### ❌ `noj-core 启动超时` / `health 不可达`

按顺序检查:

1. **`.env` 是否存在且字段完整**:
   ```bash
   ls -la noj-core/.env
   ```
2. **基础设施是否启动**:
   ```bash
   docker compose ps
   ```
3. **查看错误日志**:
   ```bash
   tail -50 scripts/dev/logs/core.log
   ```
   常见错误:
   - `JWT_SECRET must be at least 32 characters` → 修改 `.env` 中的
     `JWT_SECRET`
   - `connection refused postgres:5432` → 启动基础设施
   - `ECONNREFUSED redis:6379` → 启动基础设施

### ❌ `noj-core` 启动时报 `seed` 加载不到 `.env`

> 这是已知陷阱:`deno task seed` **不会**自动加载 `.env`,即使 `deno.json`
> 中配置了 `--env-file=.env` 也只在直接调用 `deno task seed` 时生效。

**解决方法** —— 直接调用:

```bash
cd noj-core
deno run --env-file=.env scripts/seed.ts
```

或在 `start-core.sh` 启动后通过 `bash scripts/db/seed.sh` 单独 seed。

### ❌ 首次登录 admin 账号

`scripts/db/seed.sh` 完成后,**若未在 `.env` 配置 `ADMIN_EMAIL` /
`ADMIN_PASS`**,seed 会输出类似:

```
⚠ 已创建临时引导管理员(首次登录后必须修改密码)
  username: admin
  email:    admin@noj.local
  password: <24 字符 base64url 随机>
```

记录此密码登录后,系统会**强制跳转** `/change-password` 修改密码才能继续
访问其他页面。

**推荐做法** —— 在 `.env` 中预置:

```bash
echo 'ADMIN_EMAIL=admin@example.com' >> noj-core/.env
echo 'ADMIN_PASS=YourSecurePass123!' >> noj-core/.env
bash scripts/db/seed.sh
```

详见 [issue #75](https://github.com/Neuro-OJ/neuro-oj/issues/75)。

### ❌ `noj-judge` 启动后立即退出

检查日志:

```bash
tail -50 scripts/dev/logs/judge.log
```

常见原因:

- **Docker daemon 未运行**:`Cannot connect to Docker daemon` →
  `sudo systemctl start docker`
- **Redis 未启动**:noj-judge 通过 Redis RPC 从 core 拉取镜像白名单,Redis
  不可用会 fail-fast
- **编译失败**:`cargo build` 单独跑一次看错误输出

### ❌ 评测提交后一直 `pending`

按顺序排查:

1. **noj-judge 是否运行**:`bash scripts/dev/status.sh`
2. **Redis 队列是否有积压**:
   ```bash
   docker compose exec redis redis-cli LLEN noj:judge:queue
   ```
3. **judge 日志是否有错误**:
   ```bash
   tail -f scripts/dev/logs/judge.log
   ```
4. **是否在管理后台启用了对应镜像**:`/admin/judge-images` 页面

### ❌ `docker compose` 命令找不到(Docker v1)

本项目使用 Docker Compose v2(`docker compose` 子命令,无连字符)。
若只有 `docker-compose` v1,升级到 v2:

```bash
# Debian/Ubuntu
sudo apt update && sudo apt install -y docker-compose-plugin
```

### ❌ 端口 8000/3000 已被占用

```bash
# 查看占用进程
sudo lsof -i :8000
sudo lsof -i :3000

# 或直接杀掉占用进程
sudo fuser -k 8000/tcp
sudo fuser -k 3000/tcp
```

### ❌ 数据库迁移失败

单独运行迁移看错误:

```bash
cd noj-core
deno run -A scripts/migrate.ts --env-file=.env
```

### ❌ 彻底清理所有数据(包括评测历史)

```bash
bash scripts/dev/stop-infra.sh
docker compose down -v           # -v 删除数据卷
rm -rf noj-core/data/packages/   # 清理支持包
bash scripts/dev/start-all.sh
```

---

## 调试技巧

### 实时查看某个模块日志

```bash
tail -f scripts/dev/logs/core.log    # 后端
tail -f scripts/dev/logs/ui.log      # 前端
tail -f scripts/dev/logs/judge.log   # 评测机
```

### 查看 Redis 队列状态

```bash
docker compose exec redis redis-cli LLEN noj:judge:queue
docker compose exec redis redis-cli LRANGE noj:judge:queue 0 5
```

### 查看数据库内容

```bash
docker compose exec postgres psql -U noj noj
# \dt 列出所有表
# SELECT * FROM submissions LIMIT 10;
```

### 单独重启某个模块

```bash
bash scripts/dev/stop-judge.sh && bash scripts/dev/start-judge.sh
```

---

## 进阶:单独使用对应模块的 deno/cargo 命令

这些脚本只是**封装**了原始命令,直接调用也行:

```bash
cd noj-core
deno task dev                  # 后端热重载
deno task seed                 # 种子数据(注意 .env 陷阱)
deno task migrate              # 单独迁移

cd ../noj-ui
deno task dev                  # 前端 HMR

cd ../noj-judge
cargo run                      # 评测 Worker
```

优势:前台运行能看到实时输出;劣势:占一个终端、进程不守护。