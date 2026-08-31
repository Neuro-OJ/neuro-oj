# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P3：实现 `maintain logs` 与
`maintain config`。`maintain logs [modules] [--follow]`
按模块输出彩色前缀日志：Docker 组件走
`docker compose logs --no-color [--follow]`， process 组件读/尾随
`<install_dir>/run/logs/<component>.log`（进程输出在 spawn 时
追加写入该文件）。`maintain config check/show/set` 分别做校验、脱敏显示、修改
JSON 配置（写入前校验、经 `saveDeployment`
保持权限）。`backup/restore/verify/reset` 留待后续计划。

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
- `src/runtime/` 命令/进程抽象（command/pidfile/process/logfile）
- `src/deploy/` 部署编排（compose/docker/state/deploy）
- `src/maintain/` 运维编排（logs/config）
- `src/util/fs.ts` 文件工具
- `src/util/color.ts` 彩色日志前缀工具
