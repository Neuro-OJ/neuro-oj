# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P0-P5 已完成；代码评审后补齐 `maintain verify` 与 `run-server` 前台运行，
并修复备份/恢复的真实 stdin/base64 通道、Compose 文件权限与凭据注入问题。

P4：实现 `maintain backup create/verify/restore/drill` 与 `maintain reset`。
备份仅面向 prod：zstd level 15 压缩（可用 `--zstd-level` 调整）、SHA-256 校验、
GPG 对称 AES-256 加密（口令来自 `--passphrase-file` 或
`NOJ_BACKUP_PASSPHRASE_FILE`， `--no-encrypt` 可跳过加密），产物为单个
`snapshot-<timestamp>.nojbackup`。 `verify` 解密解包后校验
SUCCESS/manifest/sha256sums；`restore` 默认只恢复数据、
`--include-deploy-configs` 连同配置恢复（要求目标已停止且 `--confirm`）；
`drill` 执行 verify 并可选写 `--report` 文件。`reset` 默认只清数据并置
`stopped`， `--include-deploy-configs` 连 `noj-deploy.json`/`noj-secrets.json`
一起清并置 `uninitialized`，均需 `--confirm`。

P5：新增 `noj-server`（linux/amd64）的 `deno compile` 构建脚本与
`deno task
build:server`；`docker-compose.prod.yml` 中镜像/服务改名为
`noj-server`/`server`； `setup.sh` 改为仅下载/校验 `noj-cli-linux-amd64`
的薄引导；README / deploy/README / noj-docs
生产部署文档已迁移到新命名与薄引导流程。

P5 补充：`deploy up` 与 `run-server` 在 process 模式且未配置 `dev_command`
时，会自动从 GitHub Releases 下载并校验 `noj-server-linux-amd64`
（SHA-256），缓存到 `<install_dir>/bin/`；`deploy init` 会尝试解析最新版本号，
网络不可用时回退到内置默认版本。

## 用法

```bash
cd noj-cli
deno run -A src/cli.ts doctor --port 8080
deno run -A src/cli.ts deploy init --mode dev --dir /opt/neuro-oj
deno run -A src/cli.ts deploy init --mode prod --dir /opt/neuro-oj
deno run -A src/cli.ts deploy up --dir /opt/neuro-oj
deno run -A src/cli.ts deploy restart --dir /opt/neuro-oj
deno run -A src/cli.ts deploy status --dir /opt/neuro-oj
deno run -A src/cli.ts deploy down --dir /opt/neuro-oj
deno run -A src/cli.ts maintain logs
deno run -A src/cli.ts maintain logs server,ui --follow
deno run -A src/cli.ts maintain config check
deno run -A src/cli.ts maintain config show
deno run -A src/cli.ts maintain config set env.DOMAIN example.com
deno run -A src/cli.ts maintain verify
deno run -A src/cli.ts maintain backup create [--backup-dir DIR] [--passphrase-file FILE] [--zstd-level N] [--no-encrypt]
deno run -A src/cli.ts maintain backup verify <snapshot> [--passphrase-file FILE]
deno run -A src/cli.ts maintain backup restore <snapshot> [--confirm] [--passphrase-file FILE] [--include-deploy-configs]
deno run -A src/cli.ts maintain backup drill <snapshot> [--passphrase-file FILE] [--report FILE]
deno run -A src/cli.ts maintain reset [--confirm] [--include-deploy-configs]
deno run -A src/cli.ts run-server [--dir /opt/neuro-oj]
```

## 测试

```bash
cd noj-cli
deno task test
deno task check
```

## 目录

- `src/cli.ts` 命令分发入口
- `src/config/` 配置模型（types/load/save/validate/merge/io）
- `src/state/machine.ts` 部署状态机
- `src/util/find_deploy_dir.ts` 部署目录查找
- `src/doctor/` 环境检测（probe/checks/doctor/report）
- `src/tui/` 交互抽象与表单控件（io/widgets）
- `src/init/` deploy init 引导（templates/secrets/wizard）
- `src/runtime/` 命令/进程抽象（command/pidfile/process/logfile/download）
- `src/deploy/` 部署编排（compose/docker/state/deploy）
- `src/maintain/` 运维编排（logs/config/backup/reset）
- `src/util/fs.ts` 文件工具
- `src/util/color.ts` 彩色日志前缀工具
