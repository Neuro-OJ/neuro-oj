# noj-cli 与部署/功能性脚本差距分析

- 日期：2026-09-07
- 状态：分析记录（非实施计划）
- 范围：运维向脚本 + 文档/设计中已承诺但 CLI 未暴露的能力；不讨论 E2E、staging、release、CI 门禁等研发/发布工具的收编。

## 背景

`noj-cli` 是 Neuro OJ 的统一部署与运维 CLI，但当前仓库仍存在多个功能性脚本入口：
`scripts/deploy/deploy.sh`、`install.sh`、`backup.sh`、`judge-install.sh`、
`restore-drill.sh`、`test-alert.sh`、`check-observability.sh`，以及服务端管理 CLI
`noj-core/scripts/noj.ts`（容器内 `/app/bin/noj`）。

本文档记录这些脚本能力与 `noj-cli` 当前命令面的差距，并给出优先补齐建议，供后续设计/计划参考。

## 当前 noj-cli 能力地图

noj-cli 目前包含两套并存的命令族：

| 命令族 | 配置载体 | 覆盖能力 |
|---|---|---|
| 生产命令（`install/check/start/stop/restart/status/logs/update/backup/verify/config/uninstall`） | `.env.prod` + `docker-compose.prod.yml` + `scripts/deploy/*.sh` | 生产安装、生命周期、升级、备份、校验、卸载 |
| JSON 部署命令（`doctor/deploy/maintain/run-server/version`） | `noj-deploy.json` + `noj-secrets.json` | 源码/JSON 编排、环境检测、进程/Docker 混合启动、备份恢复、重置、配置管理 |

因此 noj-cli 并非“没有部署能力”，而是已经覆盖主栈运维 + 一套 JSON 编排方案；差距主要体现在**独立运维脚本**和**服务端管理命令**没有统一入口。

## 功能差距清单

### 1. 独立 Judge Worker 管理没有入口

`scripts/deploy/judge-install.sh` 已具备：

- `install` / `install-env` / `check`
- `start` / `stop` / `status` / `logs` / `upgrade`
- `download`
- rootless Docker socket 安全校验
- Redis 配置引导

noj-cli 没有 `judge` / `worker` 子命令。生产 `install` 只处理主栈内的 judge 组件；独立 Judge 主机/Worker 的部署者仍需手动执行 `bash scripts/deploy/judge-install.sh ...`。

### 2. 隔离恢复演练（restore-drill）没有暴露

- `noj backup drill` 目前只调用 `backup.sh drill`，是**纯文件校验**（SHA-256、GPG、dump 结构）。
- `scripts/deploy/restore-drill.sh` 才是真正的隔离恢复演练：独立 Compose 项目、独立子网/数据卷、恢复后真实 API 验收（登录、题目、附件、评测），支持 RPO/RTO、`--skip-judge`、`--keep`。

CLI 没有 `restore-drill` 或 `backup drill --isolated` 入口，运维人员无法用统一入口完成“备份可恢复性”验收。

### 3. 生产观测与告警演练没有入口

- `scripts/monitoring/check-observability.sh`：检查 liveness/readiness/metrics/Alertmanager 前置条件。
- `scripts/deploy/test-alert.sh`：向 Alertmanager 注入测试告警，验证通知链路。

这两个是明确的日常/演练运维动作，但 noj-cli 没有 `observability` / `alert` 子命令。

### 4. 服务端管理命令需要长命令手动拼接

`noj-core/scripts/noj.ts`（容器内 `/app/bin/noj`）提供：

- `db migrate`
- `init system`
- `bootstrap first-admin` / `bootstrap admin`
- `problems build` / `problems import`
- `dev-setup`

生产执行方式目前是：

```bash
docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml \
  run --rm --entrypoint /app/bin/noj core <子命令>
```

noj-cli 没有将这些命令包装为 `noj-cli server ...` 或 `noj-cli shell ...` 之类的短命令。文档虽说明两个 CLI 相互独立，但日常操作体验存在断裂。

### 5. 安装器高级子命令没有用户入口

`scripts/deploy/install.sh` 支持：

- `install-env`
- `--download-only`
- `--files-only`
- `--dry-run`

noj-cli 仅暴露 `check` / `install`；`files-only` 只在 `update` 内部使用，`install-env` 与 `download-only` 没有暴露给用户。

### 6. 生产配置管理能力弱于 JSON 模式

- JSON 模式：`maintain config check/show/set`。
- 生产模式：只有 `config check`，没有 `config show` / `config set`。

对 `.env.prod` 的日常查看/修改仍要直接编辑文件，缺少“脱敏显示、校验后写入”的统一入口。

### 7. 双配置载体、双命令族没有融合

当前 noj-cli 本质上是两个 CLI 拼在一起：

- `.env.prod` + shell 脚本的生产线；
- `noj-deploy.json` + Deno 的 JSON 编排线。

两者之间没有自动转换/迁移，命令树也不统一。设计文档 `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md` 的最初目标是统一入口，但现状是“生产命令 + JSON 命令”并行。这个结构性差距影响长期可维护性和用户心智。

### 8. 命令命名/入口混淆

仓库里至少存在三个“noj/noj-cli”：

- 根目录 `noj`（生产运维 shell 入口）；
- `noj-cli`（Deno 部署/运维 CLI，安装后 `bin/noj-cli`）；
- `noj-core/scripts/noj.ts` / 容器内 `/app/bin/noj`（服务端管理 CLI）。

它们职责不同但有命名重叠，帮助信息和文档需要额外解释边界。这不算纯功能缺失，但属于“功能性脚本被看见/被使用的差距”。

## 不建议收编进 noj-cli 的脚本

以下脚本建议保持独立或走 CI/研发入口：

- `scripts/e2e/*`：跨模块测试，开发/CI 用途。
- `scripts/staging/acceptance.sh`：候选版本发布门禁。
- `scripts/release/*`、`scripts/check-*.ts`、`scripts/deploy/verify-*.ts`、`scripts/deploy/test-*.sh`：CI 门禁和回归测试。

把测试/发布工具塞进运维 CLI 会使其定位模糊，不建议纳入。

## 优先补齐建议

按运维价值排序：

| 优先级 | 建议 | 说明 |
|---|---|---|
| P0 | 新增 `noj-cli judge ...` 子命令族 | 包装 `judge-install.sh` 的 install/install-env/check/start/stop/status/logs/upgrade/download |
| P0 | 新增 `noj-cli restore-drill ...` 或 `backup drill --isolated` | 包装 `restore-drill.sh`，让真实恢复演练成为 CLI 一等公民 |
| P0 | 新增 `noj-cli observability check` 和 `noj-cli observability alert-drill` | 包装 `check-observability.sh` 和 `test-alert.sh` |
| P1 | 新增 `noj-cli server <cmd>` | 包装容器内 `/app/bin/noj`，覆盖 db/init/bootstrap/problems |
| P1 | 生产模式补 `config show/set` | 对齐 JSON 模式的 `maintain config` |
| P1 | 暴露安装器高级选项 | `install-env`、`download-only`、`files-only`、`dry-run` 至少部分进入 CLI |
| P2 | 统一命令树/配置载体 | 至少明确“生产模式 vs JSON 模式”的边界，提供双向转换或迁移工具 |
| P2 | 文档和帮助统一“noj/noj-cli/服务端 noj”的命名说明 | 降低入口混淆 |

## 后续方向

- 选择 P0 之一进入具体设计（例如 `noj-cli judge` 或 `noj-cli restore-drill` 的命令树、参数、测试方式）。
- 或先补充更细的逐项能力对照矩阵（每个脚本子命令/选项 vs noj-cli 现状）。
