# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。所有脚本以 `bash scripts/<dir>/<name>.sh`
方式调用。

## 目录结构

```
scripts/
├── README.md              # 本文件(索引)
│
├── dev/                   # 本地开发编排
│   ├── README.md          #   详细开发指南 + FAQ
│   ├── devtool.sh         #   单文件编排入口（install-deps / init-env / start / stop / status）
│   ├── env.example        #   noj-core 环境变量模板
│   ├── logs/              #   日志 + PID 文件目录
│   └── locks/             #   devtool 同工具防双开锁
│
├── deploy/                # 生产部署
│   ├── install.sh          #   可独立下载的源码获取与部署 bootstrap
│   ├── deploy.sh          #   生产安装、启动、升级、停止、备份入口
│   ├── backup.sh          #   PostgreSQL/Redis/MinIO/S3 全量快照、校验、恢复与演练
│   ├── test-deploy.sh     #   不依赖真实生产资源的部署脚本测试
│   └── test-backup.sh     #   不依赖真实 Docker 的备份与恢复安全边界测试
│
├── staging/               # 生产候选版本验收门禁
│   ├── acceptance.sh      #   构建、启动、边缘检查与业务 smoke test
│   ├── env.example        #   staging 验收环境变量模板
│   └── test-acceptance.sh #   不依赖真实 Docker 的脚本测试
│
└── e2e/                   # 跨模块 E2E 测试
    ├── setup.sh           #   启动 E2E 环境
    ├── check-setup.sh     #   检查 E2E SDK 镜像刷新与失败传播
    ├── teardown.sh        #   停止 E2E 环境
    ├── core.sh            #   运行 noj-core E2E
    ├── judge.sh           #   运行 noj-judge E2E
    └── run-all.sh         #   E2E 一键运行
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **首次启动整套开发环境**                 | `bash scripts/dev/devtool.sh install-deps && bash scripts/dev/devtool.sh init-env && bash scripts/dev/devtool.sh start` |
| **查看当前运行状态**                     | `bash scripts/dev/devtool.sh status`（加 `--json` 结构化输出）  |
| **停止所有模块**                         | `bash scripts/dev/devtool.sh stop`                              |
| **单模块启动**                           | `bash scripts/dev/devtool.sh start <core\|ui\|judge\|infra>`    |
| **单模块重启**                           | `bash scripts/dev/devtool.sh stop <core\|ui\|judge> && bash scripts/dev/devtool.sh start <core\|ui\|judge>` |
| **更新环境变量模板（保留自定义）**       | `bash scripts/dev/devtool.sh init-env --merge`                  |
| **首次生产部署**                         | `bash scripts/deploy/deploy.sh install`                          |
| **单脚本下载并部署**                     | `bash scripts/deploy/install.sh --ref v0.1.0 --dir /opt/neuro-oj` |
| **检测 Linux 部署环境**                  | `bash scripts/deploy/install.sh check`                           |
| **安装基础部署工具**                     | `sudo bash scripts/deploy/install.sh install-env`                |
| **启动/停止生产服务**                    | `bash scripts/deploy/deploy.sh start` / `stop`                   |
| **升级生产版本**                         | `bash scripts/deploy/deploy.sh upgrade`                          |
| **查看生产状态/日志**                    | `bash scripts/deploy/deploy.sh status` / `logs [service]`        |
| **创建完整生产备份**                     | `bash scripts/deploy/deploy.sh backup`                          |
| **校验/恢复演练快照**                    | `bash scripts/deploy/backup.sh verify <snapshot>` / `drill <snapshot>` |
| **执行 staging 验收**                    | `bash scripts/staging/acceptance.sh all --env-file .env.staging` |
| **仅检查 staging 配置**                  | `bash scripts/staging/acceptance.sh check --env-file .env.staging` |
| **手动初始化数据库**                     | `cd noj-core && deno task db:migrate`（初始化见 `deno task dev-setup`） |
| **手动构建题目包**                       | `cd noj-core && deno task problems:build`                              |
| **跑跨模块 E2E 测试**                    | `bash scripts/e2e/run-all.sh`                                   |

devtool.sh 子命令完整列表：`bash scripts/dev/devtool.sh help` 或 `devtool.sh <子命令> --help`。

## 与原 `deno task` / `cargo run` 的关系

`scripts/dev/devtool.sh` **不替代**原生命令,只是封装了"后台守护 + PID 管理 + 日志
归集"的运维能力。需要前台运行/调试时仍推荐直接使用:

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见 [`dev/README.md`](dev/README.md)。

生产部署脚本使用 `.env.prod` 和 `docker-compose.prod.yml`，备份工具使用 GPG 对称加密保存
环境文件，详细说明见
[`生产部署文档`](../noj-docs/docs/operators/production-deploy.md)。发布前必须先通过
`staging/acceptance.sh all`；失败时脚本会把 Compose、Docker 和服务日志保存到
`artifacts/staging/<版本>/`。

`deploy/install.sh` 可以从仓库中单独下载后执行。它只获取指定 ref 的源码并调用
下载后的 `deploy.sh`，目标目录非空时会拒绝覆盖；已有安装请直接进入目标目录执行
`deploy.sh upgrade`。

在单脚本模式下可先执行 `bash noj-install.sh check` 检查 Linux、架构、基础工具、Docker
Compose、内存、磁盘和端口。`sudo bash noj-install.sh install-env` 只会通过系统包管理器
安装 `ca-certificates`、`curl`、`tar` 和 `openssl`；Docker Engine、Compose plugin 和
Judge rootless Docker daemon 不由脚本自动安装。
