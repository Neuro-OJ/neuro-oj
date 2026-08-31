# Tasks

> 详细 bite-sized 任务见 `docs/superpowers/plans/2026-08-31-noj-cli-p0-foundation.md` 至 `p5-server-build-migration.md`。本文件为 OpenSpec 层面的任务清单。

## P0: CLI 骨架 + 配置模型 + 状态机

- [ ] 初始化 Deno 项目（deno.json、依赖、目录结构）
- [ ] 实现 `src/cli.ts` 命令分发（doctor/deploy/maintain/run-server/version stub）
- [ ] 实现 `src/config/types.ts`、`load.ts`、`save.ts`、`validate.ts`、`merge.ts`
- [ ] 实现 `src/state/machine.ts`
- [ ] 实现 `src/util/find_deploy_dir.ts`
- [ ] 为上述模块写 Deno 单元测试

## P1: doctor + deploy init TUI

- [ ] 实现 `doctor` 环境检测（Linux/amd64、基础工具、Docker/Compose、资源、端口）
- [ ] 实现 `deploy init` TUI（dev/prod 模式引导）
- [ ] 生成 `noj-deploy.json` + `noj-secrets.json`
- [ ] 写 Deno 测试（fake 命令/环境变量模拟）

## P2: deploy up/down/restart/status

- [ ] 实现 Docker Compose 编排（生成/复用 Compose，合并 env，`up -d --wait` / `down` / `ps`）
- [ ] 实现 process 组件管理（spawn noj-server/UI，记录 PID，停止时终止）
- [ ] 接入状态机，更新 `noj-deploy.json` state
- [ ] 写 Deno 测试（fake docker/process）

## P3: maintain logs + config

- [ ] 实现 `maintain logs`（all/逗号分隔模块，彩色前缀，`--follow`）
- [ ] 实现 `maintain config check/show/set`
- [ ] 写 Deno 测试

## P4: maintain backup/restore/verify/reset

- [ ] 实现 `maintain backup create`（zstd level 15、SHA-256、GPG AES-256、`.nojbackup`）
- [ ] 实现 `maintain backup verify/restore/drill`
- [ ] 实现 `maintain reset`（默认只清数据，`--include-deploy-configs` 连配置一起清）
- [ ] 写 Deno 测试（fake docker/gpg/zstd）

## P5: noj-server 构建 + 镜像改名 + 文档迁移

- [ ] 添加 noj-server `deno compile` 构建脚本（linux/amd64）
- [ ] 更新 `docker-compose.prod.yml`：noj-core 镜像/服务改名 noj-server，内部引用同步
- [ ] 更新 `setup.sh` 为仅下载/校验 noj-cli 的薄引导
- [ ] 更新 README、deploy/README、noj-docs 生产部署文档
- [ ] 构建冒烟测试/文档链接检查

## 验证

- [ ] `deno task test` 全部通过
- [ ] `deno task check` 类型检查通过
- [ ] `deno fmt` / `deno lint` 通过
- [ ] 真实 Docker 环境 smoke test：`deploy up` / `maintain logs` / `maintain backup create` / `maintain reset`
