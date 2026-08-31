# scripts/ — 脚本总览

Neuro OJ 仓库根目录的脚本统一存放点。部署与运维入口已统一为 `noj-cli`，
旧版 `setup.sh`、`scripts/deploy/*.sh`、`scripts/dev/devtool.sh` 与根目录
`noj` 命令已移除。

## 唯一安装/部署/运维入口

`noj-cli` 是唯一入口：直接下载二进制，然后由它完成 doctor、deploy、maintain 等。

```bash
# 下载并运行 noj-cli（生产/安装）
curl -fsSL -o noj-cli \
  https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/noj-cli-linux-amd64
chmod +x noj-cli
./noj-cli doctor
./noj-cli deploy init --mode prod --dir /opt/neuro-oj
./noj-cli deploy up --dir /opt/neuro-oj
./noj-cli maintain logs
./noj-cli maintain backup create
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
├── deploy/                # 仅保留 noj-cli 相关校验门禁（TypeScript）
│   ├── verify-build-server.ts
│   └── verify-compose-server.ts
├── staging/               # 生产候选版本验收门禁
├── e2e/                   # 跨模块 E2E 测试
└── release/               # 发布供应链检查
```

## 按使用场景速查

| 我想...                                  | 使用                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **下载 noj-cli（唯一安装入口）**          | `curl -fsSL -o noj-cli https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/noj-cli-linux-amd64 && chmod +x noj-cli` |
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
