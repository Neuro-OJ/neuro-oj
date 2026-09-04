# noj-cli 统一部署与运维 CLI 设计

Status: proposed

## 背景

当前部署/运维脚本分散在多个入口：`setup.sh`、`scripts/deploy/install.sh`、`scripts/deploy/deploy.sh`、`scripts/deploy/backup.sh`、`scripts/deploy/judge-install.sh`、`noj`、`scripts/dev/devtool.sh`。命令入口多、职责边界不清晰，且配置同时存在于 `.env.prod`、`.env.dev`、`.env.judge` 等文件中，与部署元数据职责重叠。

本设计将服务器检测、开发部署、生产部署、生产运维统一到一个 `noj-cli` 命令，并引入 `noj-server` 二进制作为 noj-core 的统一服务端产物。

## 目标

- 统一命令入口：`doctor`、`deploy`、`maintain`、`run-server`、`version`
- 用两个 JSON 文件承载部署配置：`noj-deploy.json`（非敏感）+ `noj-secrets.json`（敏感）
- 引入状态机，避免重复启动/重复关闭
- 生产仍以 Docker Compose 为主，开发采用“依赖 Docker + 本地进程”的混合模式
- 提供 TUI 引导配置，降低使用门槛
- 提供混合日志、备份/恢复/校验、重置等运维能力
- 仅支持 `linux/amd64`

## 非目标

- 不做升级流程（无 `upgrade` / `update`）
- 不自动安装 Docker Engine / Docker daemon
- 不支持 ARM64
- 不兼容旧脚本/旧命令
- 不保留独立 `.env` 文件作为配置载体

## 架构

两个二进制：

- `noj-cli`：Deno + TypeScript 编译的运维/编排 CLI，不含业务服务逻辑。
- `noj-server`：由 noj-core 编译出的 API 服务二进制；开发时由 `noj-cli` 直接启动，生产时内嵌进 Docker 镜像。

生产镜像重命名：`ghcr.io/neuro-oj/noj-core` → `ghcr.io/neuro-oj/noj-server`。

生产运行模型：Docker Compose 编排 `postgres`、`redis`、`minio`、`minio-init`、`migrate`、`server`、`ui`、`llm-gateway`、`judge`、`nginx`。

开发运行模型：PostgreSQL/Redis/MinIO 用 Docker Compose，`noj-server` 和 UI 以本地进程运行。

## 命令树

```text
noj-cli
├── doctor
├── deploy
│   ├── init
│   ├── up
│   ├── down
│   ├── restart
│   └── status
├── maintain
│   ├── logs
│   ├── backup
│   │   ├── create
│   │   ├── verify
│   │   ├── restore
│   │   └── drill
│   ├── verify
│   ├── reset
│   └── config
│       ├── check
│       ├── show
│       └── set
├── run-server
└── version
```

### doctor

- 只读环境检测，不安装任何东西、不写文件。
- 检测项：
  - Linux、CPU 架构（仅 `x86_64` / `amd64`）
  - 基础工具：`bash`、`tar`、`openssl`、`curl` 或 `wget`
  - Docker CLI、Docker daemon、Docker Compose v2
  - 内存、Swap、目标目录磁盘、Docker 存储磁盘
  - 端口占用（默认 8080，可用 `--port` 指定）
- 输出通过/失败清单，失败时返回非零退出码。

### deploy

#### deploy init

- TUI 引导生成/编辑 `noj-deploy.json` + `noj-secrets.json`。
- 支持 `--mode dev|prod`；未指定时 TUI 先选择模式。
- 不提供 `--non-interactive`；非交互场景由用户直接编辑 JSON。
- 流程：
  1. 欢迎页 + 模式选择
  2. 自动运行 `doctor` 环境检测，彩色清单展示（不阻断）
  3. prod 模式引导：网站地址、HTTPS、端口、Judge、邮件、反向代理
  4. dev 模式引导：组件选择、端口、数据目录
  5. 摘要确认后写入 JSON
- 敏感输入不回显；随机密钥直接写入 `noj-secrets.json`。

#### deploy up

- 按元数据启动/创建部署。
- 流程：
  1. 读取 `noj-deploy.json` + `noj-secrets.json`
  2. 对每个启用组件合并环境变量（全局 env + 组件 env，解析 `${KEY}` 占位符）
  3. `method: docker` 的组件：生成/复用 Compose 文件，通过临时 env 文件或子进程环境变量传入，执行 `docker compose up -d --wait`
  4. `method: process` 的组件：spawn 进程并传入环境变量，记录 PID，日志接入统一日志流
  5. 更新状态为 `running` 或 `partial`
- 状态机避免重复启动：当前 `running` 时直接提示，不重复执行。

#### deploy down

- 停止部署，保留数据。
- 当前 `stopped` 时提示已停止，不重复关闭。
- 停止所有启用组件，更新状态为 `stopped`。

#### deploy restart

- 当前 `running` / `partial`：先 down 再 up。
- 当前 `stopped`：直接 up。

#### deploy status

- 显示部署状态、各组件运行状态和健康情况。
- 只做最小检查，配置损坏时仍可查看。

### maintain

#### maintain logs

- 命令：`maintain logs [modules] [--follow]`
- `modules`：`all`（默认）或英文逗号分隔，如 `server,ui,judge`
- 每个模块一行流，行首加 `[模块名]` 前缀，不同模块使用不同颜色（类似 `docker compose logs`）。
- Docker 组件用 `docker compose logs --no-color` 拉流；进程组件读其 stdout/stderr。
- 不带 `--follow` 时只输出最近日志。

#### maintain backup

- 仅面向 prod。
- 算法：
  - 压缩：仅 `zstd`，默认 level 15，可用 `--zstd-level` 调整
  - 校验：SHA-256
  - 加密：GPG 对称 AES-256，口令来自 `--passphrase-file` 或 `NOJ_BACKUP_PASSPHRASE_FILE`；无 TTY 且未提供时报错
  - `--no-encrypt`：整个归档不加密（含 secrets，用户自行承担风险）
- 快照产物：单个加密归档文件 `snapshot-<timestamp>.nojbackup`
- 内部结构（先 `tar --zstd` 打包，再 GPG 加密）：
  - `manifest.json`
  - `sha256sums.txt`
  - `noj-deploy.json`
  - `noj-secrets.json`
  - `postgres.dump`、`postgres-globals.sql`
  - `redis.rdb`、`redis-persistence.txt`
  - `minio/`
  - `SUCCESS`
- 命令：
  - `maintain backup create [--backup-dir DIR] [--passphrase-file FILE] [--zstd-level N] [--no-encrypt]`
  - `maintain backup verify <snapshot> [--passphrase-file FILE]`
  - `maintain backup restore <snapshot> [--confirm] [--passphrase-file FILE] [--include-deploy-configs]`
  - `maintain backup drill <snapshot> [--passphrase-file FILE] [--report FILE]`

#### maintain restore

- 默认只恢复数据；加 `--include-deploy-configs` 才恢复 `noj-deploy.json` / `noj-secrets.json`。
- 要求目标部署已停止，需 `--confirm`。

#### maintain verify

- 校验配置完整性、JSON schema、密钥长度、Compose 可解析、镜像存在/签名（如启用）。

#### maintain reset

- 默认只清理数据（数据库、Redis、MinIO、缓存），保留配置 JSON，状态置为 `stopped`。
- 加 `--include-deploy-configs` 时连 `noj-deploy.json` / `noj-secrets.json` 一起清掉。
- 需二次确认。

#### maintain config

- `config check`：只检查配置，不改变服务状态。
- `config show`：显示当前配置，敏感字段脱敏。
- `config set <key> <value>`：修改单个配置项，写入前校验，写入后保持权限。

### run-server

- 公开命令，直接运行 `noj-server` 二进制。
- 读取当前目录或 `--env-file` 指定配置，监听指定端口。
- 不启动 Docker、不启动 UI。

### version

- 显示 `noj-cli` 和 `noj-server` 版本、构建信息、支持的 Compose 版本。

## 配置 Schema

### noj-deploy.json（非敏感，权限 644）

```json
{
  "schema_version": 1,
  "type": "prod",
  "state": "stopped",
  "created_at": "2026-08-31T00:00:00Z",
  "updated_at": "2026-08-31T00:00:00Z",
  "install_dir": "/opt/neuro-oj",
  "version": {
    "noj_cli": "0.1.0",
    "noj_server": "0.1.0"
  },
  "env": {
    "DOMAIN": "oj.example.com",
    "APP_URL": "https://oj.example.com",
    "CORS_ALLOWED_ORIGINS": "https://oj.example.com",
    "TRUSTED_PROXIES": "172.28.0.0/16",
    "NOJ_ALLOW_INSECURE_HTTP": false,
    "NGINX_PORT": 8080,
    "STORAGE_PROVIDER": "s3",
    "S3_ENDPOINT": "http://minio:9000",
    "S3_BUCKET": "noj-support-packages",
    "S3_REGION": "us-east-1",
    "S3_FORCE_PATH_STYLE": true,
    "EMAIL_PROVIDER": "disabled",
    "JUDGE_IMAGE_BASE": "ghcr.io/neuro-oj/",
    "JUDGE_ALLOW_EVALUATOR_NETWORK": false,
    "JUDGE_EVALUATOR_NETWORK": "noj-net",
    "JUDGE_ALLOW_HTTP_S3": true,
    "LOG_LEVEL": "info",
    "LOG_FORMAT": "json"
  },
  "components": {
    "postgres": {
      "enabled": true,
      "method": "docker",
      "image": "postgres:16-alpine@sha256:...",
      "internal_port": 5432,
      "host_port": null,
      "env": {
        "POSTGRES_USER": "noj",
        "POSTGRES_DB": "noj"
      }
    },
    "redis": {
      "enabled": true,
      "method": "docker",
      "image": "redis:7-alpine@sha256:...",
      "internal_port": 6379,
      "host_port": null,
      "env": {}
    },
    "minio": {
      "enabled": true,
      "method": "docker",
      "image": "minio/minio:...@sha256:...",
      "api_port": 9000,
      "console_port": 9001,
      "host_api_port": null,
      "host_console_port": null,
      "env": {}
    },
    "server": {
      "enabled": true,
      "method": "docker",
      "image": "ghcr.io/neuro-oj/noj-server:0.1.0",
      "binary": null,
      "port": 8000,
      "host_port": null,
      "env": {
        "NOJ_ENV": "production",
        "PORT": "8000",
        "DATABASE_URL": "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}",
        "REDIS_URL": "redis://:${REDIS_PASSWORD}@redis:6379/0",
        "NOJ_LLM_GATEWAY_URL": "http://llm-gateway:8001",
        "JWT_EXPIRES_IN": "24h",
        "JWT_SECRET": "${JWT_SECRET}",
        "TFA_ENCRYPTION_KEY": "${TFA_ENCRYPTION_KEY}",
        "NOJ_LLM_SERVICE_TOKEN": "${NOJ_LLM_SERVICE_TOKEN}",
        "S3_ACCESS_KEY": "${S3_ACCESS_KEY}",
        "S3_SECRET_KEY": "${S3_SECRET_KEY}"
      }
    },
    "ui": {
      "enabled": true,
      "method": "docker",
      "image": "ghcr.io/neuro-oj/noj-ui:0.1.0",
      "dev_command": null,
      "port": 3000,
      "host_port": null,
      "env": {
        "NUXT_API_BASE": "http://server:8000",
        "NUXT_NOJ_ENV": "production",
        "NODE_ENV": "production",
        "PORT": "3000"
      }
    },
    "llm_gateway": {
      "enabled": true,
      "method": "docker",
      "image": "ghcr.io/neuro-oj/noj-llm-gateway:0.1.0",
      "port": 8001,
      "host_port": null,
      "env": {
        "NOJ_LLM_PORT": "8001",
        "DATABASE_URL": "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}",
        "REDIS_URL": "redis://:${REDIS_PASSWORD}@redis:6379/0",
        "NOJ_LLM_BYOK_ALLOWED_HOSTS": "api.openai.com",
        "NOJ_LLM_SERVICE_TOKEN": "${NOJ_LLM_SERVICE_TOKEN}",
        "NOJ_LLM_STORE_KEY": "${NOJ_LLM_STORE_KEY}"
      }
    },
    "judge": {
      "enabled": false,
      "method": "docker",
      "image": "ghcr.io/neuro-oj/noj-judge:0.1.0",
      "docker_socket": "/run/noj-judge/docker.sock",
      "docker_socket_gid": 10001,
      "queue": "noj:judge:queue",
      "result_queue": "noj:judge:results",
      "max_concurrent": 2,
      "env": {
        "REDIS_URL": "redis://:${REDIS_PASSWORD}@redis:6379/0",
        "JUDGE_QUEUE": "noj:judge:queue",
        "RESULT_QUEUE": "noj:judge:results",
        "WORK_DIR": "/tmp/noj-judge",
        "JUDGE_MAX_CONCURRENT_JUDGES": 2,
        "JUDGE_CPU_LIMIT_MILLICORES": 1000,
        "JUDGE_MAX_EVALUATOR_TIME_MS": 300000,
        "JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS": 60000,
        "JUDGE_IMAGE_PREFIX": "noj-",
        "JUDGE_COMMAND_WHITELIST": "python3,deno,node,bash,sh",
        "JUDGE_ALLOW_EVALUATOR_NETWORK": false,
        "JUDGE_EVALUATOR_NETWORK": "noj-net",
        "JUDGE_ALLOW_HTTP_S3": true,
        "JUDGE_DOCKER_HOST": "unix:///run/noj-judge/docker.sock",
        "JUDGE_REQUIRE_ISOLATED_DOCKER": true
      }
    },
    "nginx": {
      "enabled": true,
      "method": "docker",
      "image": "nginx:1.27-alpine@sha256:...",
      "port": 8080,
      "host_port": 8080,
      "env": {}
    }
  },
  "reverse_proxy": {
    "type": "nginx",
    "config_dir": "/etc/nginx/conf.d",
    "domain": "oj.example.com",
    "upstream_port": 8080
  }
}
```

### noj-secrets.json（敏感，权限 600）

```json
{
  "schema_version": 1,
  "created_at": "2026-08-31T00:00:00Z",
  "updated_at": "2026-08-31T00:00:00Z",
  "secrets": {
    "POSTGRES_PASSWORD": "...",
    "REDIS_PASSWORD": "...",
    "MINIO_ROOT_USER": "...",
    "MINIO_ROOT_PASSWORD": "...",
    "S3_ACCESS_KEY": "...",
    "S3_SECRET_KEY": "...",
    "JWT_SECRET": "...",
    "TFA_ENCRYPTION_KEY": "...",
    "NOJ_LLM_SERVICE_TOKEN": "...",
    "NOJ_LLM_STORE_KEY": "...",
    "ALIBABA_ACCESS_KEY_ID": "...",
    "ALIBABA_ACCESS_KEY_SECRET": "...",
    "TENCENT_SECRET_ID": "...",
    "TENCENT_SECRET_KEY": "...",
    "OAUTH_GITHUB_CLIENT_ID": "...",
    "OAUTH_GITHUB_CLIENT_SECRET": "...",
    "OAUTH_OIDC_CLIENT_ID": "...",
    "OAUTH_OIDC_CLIENT_SECRET": "..."
  }
}
```

### 环境变量合并规则

- 每个组件最终环境变量 = 顶层 `env` + 组件 `env`（组件覆盖全局）。
- 组件 `env` 中的 `${KEY}` 从合并后的配置（全局 env + secrets）解析。
- 未被引用的 secrets 不会传给该组件。

## 状态机

状态：

- `uninitialized`：尚未初始化或元数据缺失
- `stopped`：已配置，所有组件已停止
- `running`：所有启用组件正常运行
- `partial`：部分组件运行（异常/降级）
- `error`：上次操作失败，需要人工介入

转换：

- `deploy init` → `stopped`
- `deploy up`：`running` 时 no-op；`stopped` / `partial` / `error` 时启动缺失组件 → `running` 或 `partial`
- `deploy down`：`stopped` 时 no-op；`running` / `partial` / `error` 时停止全部 → `stopped`
- `deploy restart`：`running` / `partial` 时先 down 再 up；`stopped` 时直接 up
- `maintain reset`：先确保 down，清数据后 → `stopped`（或 `uninitialized`，当 `--include-deploy-configs`）

状态写入 `noj-deploy.json`，命令执行前读取、执行后更新。

## 部署定位

- 默认从当前目录向上查找 `noj-deploy.json`。
- 支持 `--dir` 显式指定部署目录。

## 安全设计

- 所有下载走 HTTPS；二进制/镜像下载带 SHA-256 校验，可选 Cosign/GPG 签名验证。
- `noj-secrets.json` 权限 600，`noj-deploy.json` 权限 644。
- 配置写入先暂存，确认后再落盘。
- 不 source 环境文件，避免特殊字符触发 shell 解析。
- 不执行 `down -v`，卸载/停止默认保留数据卷。
- Judge socket 检查解析真实路径，防止 symlink 指向 `/var/run/docker.sock`。
- `stop` / `status` / `logs` / `backup` 只做最小检查，配置损坏时仍可运维。
- 配置校验补齐：密钥长度、`JUDGE_UID/GID` 非 0、socket 绝对路径、`APP_URL`/`DOMAIN`/`CORS`/`TRUSTED_PROXIES` 一致性。
- 若未来引入升级流程，默认只选 stable Release，过滤 RC/预发布。

## 测试策略

- Deno 单元测试：CLI 解析、配置校验、状态机、env 合并。
- 集成测试：fake docker/process 模拟 `deploy up/down`、`maintain logs`、`maintain backup`。
- E2E 测试：真实 Docker 环境验证 prod install/backup/restore。
- 安全边界测试：symlink 绕过、secret 长度、配置损坏时运维命令可用性。

## 迁移与兼容

- 旧脚本（`setup.sh`、`scripts/deploy/*.sh`、`noj`、`scripts/dev/devtool.sh`）废弃，不兼容。
- 文档同步更新：README、deploy/README、noj-docs 生产部署文档。
- 镜像名 `noj-core` → `noj-server` 全局替换。

## 实现要点

- TUI 使用 Deno 生态的交互库（如 Cliffy）实现命令解析与表单引导，ANSI 颜色用于状态和日志展示。
- `noj-server` 通过 `deno compile` 产出 `linux/amd64` 单文件二进制；Release 流程同时发布二进制和 `ghcr.io/neuro-oj/noj-server` 镜像。
- `noj-cli` 通过 `deno compile` 产出 `linux/amd64` 单文件二进制；`setup.sh` 仅负责下载/校验 `noj-cli`。
