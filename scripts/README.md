# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。

> **生产运维入口已统一收口至 `noj-cli`**（纯 TS，见 `noj-cli/src/prod/`）。
> 首次安装使用官方自举脚本 [`deploy/install.sh`](../deploy/install.sh)（下载并校验 Release 二进制后调用 `noj-cli install`），或手动下载 Release 二进制执行 `install`。
> 本目录仅保留仓库级静态门禁、代码生成校验、E2E/staging 回归与发布供应链脚本。

## 安装、部署与运维入口

```bash
# 首次安装（官方自举脚本，见 deploy/README.md 与 noj-cli/README.md）
curl -fsSL https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/install.sh | bash

# 或手动下载并校验二进制后安装
./noj-cli-linux-amd64 install --dir /opt/neuro-oj

# 日常运维
noj-cli status
noj-cli logs core
noj-cli update --latest
noj-cli backup create
```

从源码运行（**仅用于开发 noj-cli 自身**，不是部署入口）：

```bash
cd noj-cli
deno run -A src/cli.ts --help
```

## 目录结构

```
scripts/
├── README.md              # 本文件（索引）
├── check-all.ts           # 本地全量检查入口
├── check-ci.ts            # CI 仓库级门禁入口
├── gate-list.ts           # 仓库级门禁清单（单一事实源，两入口共用）
├── gate-runner.ts         # 门禁执行器
├── check-module-boundaries.ts      # 模块边界与依赖诊断
├── check-feature-boundaries.ts     # feature 切片边界检查
├── module-test-metadata.ts         # module/legacy 测试根与 CI 映射的共享解析点
├── check-*.ts / verify-*.ts / gen-*.ts  # 仓库级静态门禁与契约生成检查
├── coverage-report.ts     # 覆盖率报告与阈值门禁
├── deploy/                # 仓库级部署校验脚本
│   ├── verify-build-server.ts
│   ├── verify-compose-server.ts
│   └── install-sh_test.ts   # 官方一键部署脚本 deploy/install.sh 的回归测试
├── monitoring/            # 观测/告警快速检查
├── staging/               # 生产候选版本验收门禁
├── e2e/                   # 跨模块 E2E 测试
└── release/               # 发布供应链检查
```

## 按使用场景速查

| 我想...                  | 使用                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| **首次安装**             | 运行 [`deploy/install.sh`](../deploy/install.sh)，或手动下载 Release 二进制 → `./noj-cli-linux-amd64 install --dir <目录>` |
| **环境检测**             | `noj-cli check`                                                                                  |
| **启动/停止/重启/状态**  | `noj-cli start\|stop\|restart\|status`                                                           |
| **查看日志**             | `noj-cli logs [core,ui,...] [--follow]`                                                          |
| **升级**                 | `noj-cli update [--latest]`                                                                      |
| **创建/校验备份**        | `noj-cli backup create` / `noj-cli backup verify <快照>`                                         |
| **源码运行 noj-cli**     | `cd noj-cli && deno run -A src/cli.ts --help`                                                    |
| **执行 staging 验收**    | `bash scripts/staging/acceptance.sh all --env-file .env.staging`                                 |
| **跑跨模块 E2E 测试**    | `bash scripts/e2e/run-all.sh`                                                                    |
| **查看 P3 模块依赖诊断** | `deno run -A scripts/check-module-boundaries.ts`                                                 |
| **验证 P3 诊断器负例**   | `deno run -A scripts/check-ci.ts`（其中包含正式 gate 自测）                                      |

## 与原 `deno task` / `cargo run` 的关系

需要前台运行/调试单个模块时仍推荐直接使用：

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见
[`dev-docs/engineering/development.md`](../dev-docs/engineering/development.md)。

生产部署与备份的详细说明见
[`生产部署文档`](../noj-docs/docs/operators/production-deploy.md)。
