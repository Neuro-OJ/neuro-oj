# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P2：实现 `deploy up/down/restart/status`。根据 `noj-deploy.json` 生成/复用
`docker-compose.noj.yml` 并调用 `docker compose up -d --wait / down / ps`；
`method: process` 组件（开发模式的 noj-server/UI 等）以本地进程 spawn，PID
记录于 `<install_dir>/run/<component>.pid`，停止时 `kill -TERM`；命令执行 前后经
P0 状态机更新 `noj-deploy.json` 的 `state`。`down` 保留数据卷。 `maintain`
系列与 `doctor`/`init` 见 P1/P3 计划。

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
- `src/runtime/` 命令/进程抽象（command/pidfile/process）
- `src/deploy/` 部署编排（compose/docker/state/deploy）
- `src/util/fs.ts` 文件工具
