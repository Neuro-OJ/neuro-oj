# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。`setup.sh` 调用 `install.sh`，下载并校验同版本 `noj-cli`，
由 CLI 调用内部 `production.sh` 和 `deploy.sh` 完成生产安装及运维。

## 安装、部署与运维入口

首次部署使用 `setup.sh`，日常运维使用安装目录中的 `bin/noj-cli`：

```bash
# 一键安装
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash

# 日常运维
noj-cli status
noj-cli logs core
noj-cli update --latest
noj-cli backup
```

从源码运行（开发/测试）：

```bash
cd noj-cli
deno run -A src/cli.ts doctor
```

## 目录结构

```
scripts/
├── README.md              # 本文件(索引)
├── check-all.ts           # 本地全量检查入口
├── check-ci.ts            # CI 仓库级门禁入口
├── deploy/                # 生产部署、备份、Judge 与回归测试脚本
│   ├── verify-build-server.ts
│   └── verify-compose-server.ts
├── staging/               # 生产候选版本验收门禁
├── e2e/                   # 跨模块 E2E 测试
└── release/               # 发布供应链检查
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **一键安装**                            | `curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh \| bash` |
| **环境检测**                            | `noj-cli check`                                                      |
| **启动/停止/重启/状态**                  | `noj-cli start\|stop\|restart\|status`                              |
| **查看日志**                            | `noj-cli logs [core,ui,...] [--follow]`                              |
| **升级**                                | `noj-cli update [--latest]`                                         |
| **创建/校验备份**                        | `noj-cli backup` / `noj-cli backup verify <快照>`                                     |
| **源码运行 noj-cli**                    | `cd noj-cli && deno run -A src/cli.ts --help`                    |
| **执行 staging 验收**                    | `bash scripts/staging/acceptance.sh all --env-file .env.staging` |
| **跑跨模块 E2E 测试**                    | `bash scripts/e2e/run-all.sh`                                   |

## 与原 `deno task` / `cargo run` 的关系

需要前台运行/调试单个模块时仍推荐直接使用：

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见 [`dev-docs/engineering/development.md`](../dev-docs/engineering/development.md)。

生产部署与备份的详细说明见
[`生产部署文档`](../noj-docs/docs/operators/production-deploy.md)。
