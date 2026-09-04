# noj-cli

Neuro OJ 部署与运维 CLI（Deno + TypeScript；生产二进制支持 Linux amd64）。

## 一键安装与生产运维

`setup.sh → install.sh → noj-cli install`。安装器下载同版本源码和
`noj-cli-linux-amd64`，SHA-256 校验通过后安装到 `<安装目录>/bin/noj-cli`。
生产主机无需 Deno。Release 必须包含 CLI
二进制及校验文件；旧版本缺少资产时明确报错， 不会混用不同版本的程序。

```bash
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- --dir /opt/neuro-oj

noj-cli check
noj-cli status
noj-cli logs core --follow
noj-cli restart
noj-cli stop
noj-cli start
noj-cli config check
noj-cli verify
noj-cli update
noj-cli update --latest
noj-cli backup
noj-cli backup verify <快照目录>
noj-cli backup restore <快照目录> --confirm
noj-cli backup drill <快照目录> --report /tmp/drill.json
noj-cli uninstall
noj-cli uninstall --all --yes
```

以上生产命令复用 `scripts/deploy/production.sh`、`deploy.sh`、`backup.sh`，
继续使用 `.env.prod`、`docker-compose.prod.yml` 及现有服务名和数据卷。
初始化仍提供网站地址、HTTP/HTTPS、邮件和 Judge 引导。 `upgrade` 是 `update`
的别名；升级前同步部署文件、创建并校验备份，再拉取镜像并等待健康检查。
`config check` 只读校验本地配置，`verify` 还按配置执行镜像签名验证。

CLI 查找目录的顺序是 `--dir`、当前目录及祖先、安装后二进制所在目录。 未加入 PATH
时可直接运行 `/opt/neuro-oj/bin/noj-cli status`。 管理多个安装时显式指定目录：

```bash
noj-cli status --dir /opt/neuro-oj
noj-cli logs core --dir /opt/neuro-oj --follow
```

普通卸载保留配置、备份和数据卷；`--all` 同时删除数据和安装目录，需明确确认。
完全卸载在删除容器/数据前拒绝 Git/jj 工作区。 生产备份恢复要求目标 Compose
服务已停止，并提供 `--confirm`。

## JSON 配置部署

`deploy/maintain/run-server` 使用 `noj-deploy.json` 和
`noj-secrets.json`，保留作为独立源码编排工具。 这些命令不直接管理 `.env.prod`
生产安装，不会自动转换其数据。

```bash
cd noj-cli
deno run -A src/cli.ts doctor
deno run -A src/cli.ts deploy init --mode dev --dir /opt/noj-dev
deno run -A src/cli.ts deploy up --dir /opt/noj-dev
deno run -A src/cli.ts deploy status --dir /opt/noj-dev
deno run -A src/cli.ts deploy down --dir /opt/noj-dev
deno run -A src/cli.ts maintain config check --dir /opt/noj-dev
deno run -A src/cli.ts maintain logs --dir /opt/noj-dev
```

JSON 模式支持配置 check/show/set、备份 create/verify/restore/drill、reset 和
run-server。备份使用单文件 `.nojbackup`（zstd + SHA-256，可选 GPG AES-256），
与生产 Compose 的快照目录格式不同，不能交叉恢复。 `maintain restore` 是
`maintain backup restore` 的别名。

## 开发与验证

```bash
cd noj-cli
deno run -A src/cli.ts status --dir /opt/neuro-oj
deno task check
deno task test
deno task test:production
deno task build:cli
```

`build:cli` 显式交叉编译 Linux amd64，产出 `bin/noj-cli-linux-amd64`。 Release
workflow 在生产镜像验证通过后发布二进制和 `.sha256` 文件。
生产命令需要完整安装目录中的脚本，不能仅复制二进制。

## 目录

- `src/cli.ts`：命令分发
- `src/production.ts`：生产目录定位和内部驱动调用
- `src/config/`、`src/state/`：JSON 配置与状态机
- `src/init/`、`src/doctor/`、`src/tui/`：JSON 初始化与环境检测
- `src/deploy/`、`src/runtime/`：JSON 部署与进程管理
- `src/maintain/`：JSON 配置、日志和备份恢复
