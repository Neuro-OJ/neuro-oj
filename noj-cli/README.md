# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P1：实现 `doctor`（只读环境检测）与 `deploy init`（dev/prod TUI 引导生成
`noj-deploy.json` + `noj-secrets.json`）。doctor 不安装、不写文件；init 不提供
`--non-interactive`。up/down/restart/status 与 maintain 系列留待后续计划。

## 用法

```bash
cd noj-cli
deno run -A src/cli.ts doctor --port 8080
deno run -A src/cli.ts deploy init --mode dev --dir /opt/neuro-oj
deno run -A src/cli.ts deploy init --mode prod --dir /opt/neuro-oj
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
