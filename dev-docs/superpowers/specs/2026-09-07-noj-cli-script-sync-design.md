# noj-cli 替代脚本侧（Deno 化）设计

- 日期：2026-09-07
- 状态：待评审
- 范围：运维向 shell 脚本 + 容器内服务端管理 CLI
- 结论：noj-cli 作为唯一对外入口，直接 Deno 化替代脚本侧；脚本保留一段时间作为兜底，不要求反向同步。

## 背景

当前仓库存在多个功能性脚本入口：

- `scripts/deploy/deploy.sh`、`install.sh`、`backup.sh`
- `scripts/deploy/judge-install.sh`
- `scripts/deploy/restore-drill.sh`
- `scripts/deploy/test-alert.sh`
- `scripts/monitoring/check-observability.sh`
- `noj-core/scripts/noj.ts`（容器内 `/app/bin/noj`）

`noj-cli` 目前已经覆盖生产主栈运维和 JSON 配置编排，但仍存在“脚本有而 CLI 没有”的能力缺口（见 `dev-docs/audit/2026-09-07-noj-cli-script-gap.md`）。本文档确定如何让 noj-cli 全面替代这些脚本，同时保留脚本作为过渡期兜底。

## 目标 / 非目标

### 目标

- noj-cli 成为运维和服务端管理的唯一对外入口。
- 将运维 shell 脚本和服务端管理 CLI 的能力直接移植为 Deno 模块。
- 统一命令树：新增顶层领域命令，旧命令保留为兼容别名。
- 内部同时支持 `.env.prod` 生产上下文和 `noj-deploy.json` 编排上下文。
- 脚本侧保留为兜底，但不再作为 noj-cli 的实现依赖。

### 非目标

- 不要求脚本侧反向同步 noj-cli 的新能力。
- 不在一开始删除脚本；脚本在过渡期继续可用。
- 暂不纳入 E2E、staging、release、CI 校验脚本。
- 不强制把 `.env.prod` 迁移到 `noj-deploy.json`；配置载体收敛留作后续决策。

## 决策

### 1. 统一命令树

```
noj-cli
├── doctor                       # 环境检测（兼容原 check）
├── deploy                       # 部署生命周期
│   ├── install
│   ├── install-env              # 安装基础工具（移植 install.sh install-env）
│   ├── download                 # 下载源码/CLI 资产（移植 install.sh --download-only）
│   ├── init                     # JSON 模式初始化
│   ├── up / down / restart / status
│   ├── update [--latest]        # upgrade 为别名
│   ├── uninstall [--all] [--yes]
│   └── verify
├── maintain                     # 运维
│   ├── logs
│   ├── config check|show|set
│   ├── backup create|verify|restore|drill
│   ├── reset
│   └── verify
├── judge                        # 独立 Judge Worker
│   ├── install / install-env / check
│   ├── start / stop / status / logs / upgrade
│   └── download
├── observability                # 观测与告警演练
│   ├── check
│   └── alert-drill
├── restore-drill                # 隔离恢复演练
├── server                       # 容器内 /app/bin/noj 服务端管理命令
│   ├── db migrate
│   ├── init system
│   ├── bootstrap first-admin|admin
│   ├── problems build|import
│   └── dev-setup
├── config                       # 配置
│   ├── check / show / set
├── run-server                   # 前台运行 noj-server（保留）
└── version
```

兼容别名（内部路由到统一实现，不单独维护逻辑）：

| 旧命令 | 统一命令 |
|---|---|
| `check` | `doctor` |
| `install` | `deploy install` |
| `start` | `deploy up` |
| `stop` | `deploy down` |
| `restart` | `deploy restart` |
| `status` | `deploy status` |
| `logs` | `maintain logs` |
| `update` / `upgrade` | `deploy update` |
| `backup` | `maintain backup` |
| `verify` | `deploy verify` |
| `uninstall` | `deploy uninstall` |
| `config check` | `config check` |
| `run-server` | `run-server` |

### 2. 脚本能力到 noj-cli 命令的映射

| 脚本入口 | 脚本能力 | noj-cli 命令 |
|---|---|---|
| `install.sh` | `check` | `doctor` / `check` |
| `install.sh` | `install-env` | `deploy install-env` |
| `install.sh` | `install --download-only --dry-run` | `deploy download` / `deploy install --dry-run` |
| `install.sh` | `--files-only` | `deploy update` 内部同步逻辑 |
| `deploy.sh` | 生命周期/升级/卸载/校验 | `deploy ...` |
| `backup.sh` | create/verify/restore/drill | `maintain backup ...` |
| `judge-install.sh` | 完整独立 Judge 生命周期 | `judge ...` |
| `restore-drill.sh` | 隔离恢复演练 + 业务验收 | `restore-drill <snapshot>` |
| `check-observability.sh` | liveness/readiness/metrics/通知前置 | `observability check` |
| `test-alert.sh` | Alertmanager 告警投递演练 | `observability alert-drill` |
| `noj.ts` | db/init/bootstrap/problems/dev-setup | `server ...` |

### 3. 部署上下文解析

新增 `src/context/` 模块统一识别当前操作上下文：

| 目录特征 | 上下文 | 适用命令 |
|---|---|---|
| `.env.prod` + `docker-compose.prod.yml` | production | deploy/maintain/config/observability/server/restore-drill |
| `noj-deploy.json` + `noj-secrets.json` | json | deploy/maintain/config/run-server |
| `.env.judge` + `docker-compose.judge.yml` | judge | judge |

规则：

- 支持 `--dir` 显式指定。
- 未指定时沿当前目录向上查找。
- 同一目录存在多种上下文时，支持 `--mode prod|json|judge` 显式选择；未指定时按默认优先级并给出可读提示。
- 配置损坏时，`status`、`logs`、`down` 等只做最小检查的命令仍应可用。

**上下文感知命令**：

- `maintain backup` 在 production 上下文使用目录快照格式（`snapshot-*`，与 `backup.sh` 一致）；在 json 上下文使用单文件 `.nojbackup` 格式（与现有 `maintain backup` 一致）。
- `config` 在 production 上下文读写 `.env.prod`；在 json 上下文读写 `noj-deploy.json` / `noj-secrets.json`。
- `deploy` 在 production 上下文调用生产实现；在 json 上下文调用 JSON 编排实现。

### 4. 模块划分

```
noj-cli/src/
├── cli.ts                 # 统一命令树分发 + 兼容别名
├── context/               # 部署上下文识别/解析（新增）
├── deploy/                # 现有 JSON 部署（保留）
├── maintain/              # 现有 JSON 运维（保留）
├── production/            # 生产 .env.prod 运维（由 deploy.sh/install.sh 移植，新增）
├── judge/                 # 独立 Judge Worker（由 judge-install.sh 移植，新增）
├── observability/         # 观测检查 + 告警演练（新增）
├── restore_drill/         # 隔离恢复演练（由 restore-drill.sh 移植，新增）
├── server_cmd/            # 容器内 /app/bin/noj 命令封装（新增）
└── runtime/               # 进程/Docker/HTTP 命令抽象（扩展）
```

- 所有迁移逻辑用 Deno TypeScript 实现，直接调用 `docker`、`docker compose`、`deno task`、HTTP API。
- `scripts/deploy/*.sh`、`scripts/monitoring/*.sh` 保留在仓库和安装目录，标记为“兜底/弃用”，不再被 noj-cli 调用。
- `setup.sh` 保留为一次性引导入口，只负责获取并校验 `noj-cli`；后续部署逻辑由 noj-cli 完成。

### 5. 服务端管理命令执行方式

`server` 命令按上下文选择执行方式：

- **production 上下文**：执行
  `docker compose --env-file <...> run --rm --entrypoint /app/bin/noj core <子命令>`
- **json / 源码上下文**：在 `noj-core/` 下执行对应 `deno task`（如 `db:migrate`、`problems:build`、`dev-setup`）
- **judge 上下文**：`server` 不适用，明确报错

`bootstrap first-admin` 等交互命令必须保留 TTY 和密码隐藏语义，不接受密码作为命令行参数。

### 6. 迁移顺序建议

按依赖和风险从低到高：

1. **上下文解析骨架**：`src/context/` + 统一命令树 + 兼容别名。
2. **低风险脚本移植**：`observability`（check/alert-drill）、`server` 命令包装。
3. **独立 Judge**：`judge` 模块，移植 `judge-install.sh`。
4. **隔离恢复演练**：`restore_drill` 模块，移植 `restore-drill.sh`。
5. **生产运维 Deno 化**：`production` 模块，移植 `deploy.sh` / `install.sh` / `backup.sh` 的生产路径。
6. **收敛清理**：脚本标记弃用，更新文档，逐步移除不再需要的脚本测试依赖。

### 7. 测试策略

- **单元测试**：命令树解析、上下文识别、配置解析、参数解析。
- **集成测试**：fake docker / fake HTTP 模拟 `judge`、`restore-drill`、`observability`、`server`。
- **回归基线**：现有 `scripts/deploy/test-*.sh` 继续验证脚本兜底可用；每个 Deno 移植模块提供等价场景测试。
- **安全测试**：保留并迁移现有安全边界用例（rootless socket、GPG 口令权限、备份篡改、卸载确认、敏感信息不回显）。

### 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 直接 Deno 化工作量大 | 按迁移顺序分阶段实施，每个阶段可独立交付 |
| Deno 实现与旧脚本行为漂移 | 以现有脚本测试为对照基线，关键场景双跑 |
| 双配置载体短期增加维护成本 | 统一命令树内部通过 context 抽象隔离，不暴露给用户 |
| 服务端交互命令包装复杂 | 保留 TTY/密码隐藏语义，用集成测试覆盖 |
| 脚本兜底与 CLI 并存可能造成文档混乱 | 文档明确标记脚本为弃用/过渡，最终以 noj-cli 为准 |

## 后续待定项

- `.env.prod` 与 `noj-deploy.json` 是否最终收敛为单一配置载体（当前不收敛）。
- 根目录 `noj` shell 是否在 CLI 完全替代后移除或仅作软链别名。
- 脚本侧正式废弃的时间点与移除条件。
