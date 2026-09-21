# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。

> **T24 起：生产运维不再经本目录的 bash 脚本**。`setup.sh`、`install.sh`、
> `production.sh`、`backup-schedule.sh`、`judge-install.sh` 等自举/运维脚本
> 已删除——能力全部迁入 `noj-cli`（纯 TS，见 `noj-cli/src/prod/`）。
> 首次安装改为**手动下载 Release 二进制**后执行 `install`（不再有自举脚本）。
> `deploy.sh` 与 `restore-drill.sh` 仍在过渡期保留，但已加**弃用闸门**。
> 注意：`scripts/release/test-supply-chain.sh`、`scripts/staging/test-acceptance.sh`
>、`scripts/deploy/test-deprecation-gate.sh` 等**门禁/回归测试**脚本仍然保留
>（被删除的是旧的自举与运维入口脚本，不含这些测试）。

## 安装、部署与运维入口

```bash
# 首次安装（先下载并校验二进制，见 noj-cli/README.md）
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
├── README.md              # 本文件(索引)
├── check-all.ts           # 本地全量检查入口
├── check-ci.ts            # CI 仓库级门禁入口
├── gate-list.ts           # 仓库级门禁清单（单一事实源，两入口共用）
├── gate-runner.ts         # 门禁执行器
├── check-*.ts / verify-*.ts / gen-*.ts  # 各专项静态门禁
├── coverage-report.ts     # 覆盖率报告与阈值门禁
├── silent-skip-report.ts  # 静默跳过棘轮
├── deploy/                # 过渡期脚本 + 仓库级校验
│   ├── deprecation-gate.sh      # R2 弃用闸门（被 deploy.sh/restore-drill.sh source）
│   ├── deploy.sh                # 已废弃（过渡期保留，运行时需 y 确认）
│   ├── restore-drill.sh         # 已废弃（同上）
│   ├── backup.sh                # 上两者的依赖（随它们一起保留）
│   ├── test-deprecation-gate.sh # 闸门行为回归
│   ├── verify-build-server.ts
│   ├── verify-compose-server.ts
│   ├── restore-drill-verify.ts  # 演练验收辅助
│   └── restore-drill-verify_test.ts
├── monitoring/            # 观测/告警快速检查
├── staging/               # 生产候选版本验收门禁
├── e2e/                   # 跨模块 E2E 测试
└── release/               # 发布供应链检查
```

## 按使用场景速查

| 我想...                 | 使用                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **首次安装**            | 手动下载 Release 二进制 → `./noj-cli-linux-amd64 install --dir <目录>`（见 `noj-cli/README.md`） |
| **环境检测**            | `noj-cli check`                                                                        |
| **启动/停止/重启/状态** | `noj-cli start\|stop\|restart\|status`                                                 |
| **查看日志**            | `noj-cli logs [core,ui,...] [--follow]`                                                |
| **升级**                | `noj-cli update [--latest]`                                                            |
| **创建/校验备份**       | `noj-cli backup create` / `noj-cli backup verify <快照>`                               |
| **源码运行 noj-cli**    | `cd noj-cli && deno run -A src/cli.ts --help`                                          |
| **执行 staging 验收**   | `bash scripts/staging/acceptance.sh all --env-file .env.staging`                       |
| **跑跨模块 E2E 测试**   | `bash scripts/e2e/run-all.sh`                                                          |

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
