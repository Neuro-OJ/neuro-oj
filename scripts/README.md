# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。部署与运维入口已统一为 `noj-cli`，
旧版 `scripts/deploy/*.sh`、`scripts/dev/devtool.sh` 与根目录 `noj` 命令已移除。

## 唯一部署/运维入口

- 首次安装：`setup.sh`（薄引导，只下载/校验 `noj-cli-linux-amd64`）
- 日常部署与运维：`noj-cli`（`doctor` / `deploy` / `maintain` / `run-server` / `version`）

```bash
# 从源码运行 noj-cli（开发/测试）
cd noj-cli
deno run -A src/cli.ts doctor
deno run -A src/cli.ts deploy init --mode dev --dir /opt/neuro-oj
deno run -A src/cli.ts deploy up --dir /opt/neuro-oj
deno run -A src/cli.ts maintain logs
deno run -A src/cli.ts maintain backup create
```

## 目录结构

```
scripts/
├── README.md              # 本文件(索引)
├── check-all.ts           # 本地全量检查入口
├── check-ci.ts            # CI 仓库级门禁入口
├── deploy/                # 仅保留 noj-cli 相关校验门禁（TypeScript）
│   ├── verify-build-server.ts
│   ├── verify-compose-server.ts
│   └── verify-setup-thin.ts
├── staging/               # 生产候选版本验收门禁
├── e2e/                   # 跨模块 E2E 测试
└── release/               # 发布供应链检查
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **一条命令安装整套 NOJ**                  | `curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh \| bash` |
| **环境检测**                             | `cd noj-cli && deno run -A src/cli.ts doctor`                   |
| **初始化部署配置**                       | `cd noj-cli && deno run -A src/cli.ts deploy init --mode dev\|prod --dir /opt/neuro-oj` |
| **启动/停止/重启/状态**                  | `noj-cli deploy up\|down\|restart\|status --dir /opt/neuro-oj`   |
| **查看日志**                             | `noj-cli maintain logs [server,ui,...] [--follow]`               |
| **创建/校验/恢复备份**                   | `noj-cli maintain backup create\|verify\|restore\|drill`         |
| **重置部署**                             | `noj-cli maintain reset --confirm`                               |
| **直接运行 noj-server**                  | `noj-cli run-server --dir /opt/neuro-oj`                         |
| **执行 staging 验收**                    | `bash scripts/staging/acceptance.sh all --env-file .env.staging` |
| **跑跨模块 E2E 测试**                    | `bash scripts/e2e/run-all.sh`                                   |

## 与原 `deno task` / `cargo run` 的关系

`noj-cli` 负责部署编排与运维；需要前台运行/调试单个模块时仍推荐直接使用：

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

详细开发指南见 [`docs/engineering/development.md`](../docs/engineering/development.md)。

生产部署与备份的详细说明见
[`生产部署文档`](../noj-docs/docs/operators/production-deploy.md)。
