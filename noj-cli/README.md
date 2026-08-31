# noj-cli

Neuro OJ 统一部署与运维 CLI（Deno + TypeScript，仅支持 linux/amd64）。

## 状态

P0 骨架：命令分发（doctor/deploy/maintain/run-server/version stub）、配置模型
（load/save/validate/merge）、状态机（transition）、部署目录查找（findDeployDir）。
具体业务命令（doctor 检测、init/up/logs/backup 等）留待后续计划。

## 运行

```bash
cd noj-cli
deno run -A src/cli.ts --help
deno run -A src/cli.ts version
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
