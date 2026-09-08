# noj-cli production Deno 化与旧命令别名统一（Phase 4）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development (if subagents available).

**Goal:** 将 `scripts/deploy/deploy.sh`、`install.sh`、`backup.sh`、`production.sh` 的生产运维逻辑 Deno 化到 noj-cli，并让旧的顶层命令（`install/start/stop/restart/status/logs/update/backup/verify/config/uninstall`）作为兼容别名路由到统一实现。

**Architecture:** 新增 `noj-cli/src/production/` 模块，按职责拆分为 `env.ts`、`compose.ts`、`lifecycle.ts`、`install.ts`、`backup.ts`、`config.ts`。`src/cli.ts` 的旧生产命令不再直接 `runProduction`，而是走 `src/production/dispatch.ts` 的统一分发。现有 JSON 模式 `deploy/maintain` 保持不变。

**Tech Stack:** Deno 2 + TypeScript、`@std/assert`、`@std/path`、现有 `CommandRunner`/`PromptIO`/context 模块，不新增第三方运行时依赖。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-noj-cli-script-sync-design.md`

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行环境：仅 Deno 2 + TypeScript 标准环境；不新增第三方运行时依赖。
- 提交：使用 jj；提交信息格式 `<type>(<scope>): <中文描述>`，scope 使用 `cli`。
- 测试：通过 `cd noj-cli && deno task test` 运行；代码通过 `deno fmt` 与 `deno lint`。
- 所有改动必须位于当前 worktree（`.worktrees/noj-cli-improves/`）内，禁止修改主仓库。
- 不修改 `scripts/deploy/*.sh`；脚本保留为兜底。
- 行为基线：`scripts/deploy/deploy.sh`、`install.sh`、`backup.sh`、`production.sh` 是权威行为来源；安全边界（GPG 口令权限、卸载确认、根目录删除保护、镜像签名、备份原子性）必须保留。

## 文件结构

```
noj-cli/src/production/
├── env.ts               # .env.prod 读取/写入/校验
├── env_test.ts
├── compose.ts           # docker compose 通用执行/健康等待
├── compose_test.ts
├── lifecycle.ts         # start/stop/restart/status/logs
├── lifecycle_test.ts
├── install.ts           # install/install-env/update/uninstall
├── install_test.ts
├── backup.ts            # backup create/verify/restore/drill
├── backup_test.ts
├── config.ts            # config check/show/set
├── config_test.ts
└── dispatch.ts          # 旧命令别名到统一实现的映射
└── dispatch_test.ts
```

## Task 1: 生产 env 模块

**Files:** `env.ts`, `env_test.ts`

**Interfaces:**
- `export function loadProdEnv(file: string): Record<string, string>`
- `export function saveProdEnv(file: string, values: Record<string, string>): void`
- `export function setProdEnv(file: string, key: string, value: string): void`
- `export function validateProdEnv(file: string, opts?: { requireSecrets?: boolean }): string[]`（移植 `deploy.sh` `check_required_values` / `check_file_permissions`）

实现要点：KEY=VALUE 解析、引号去除、权限 600/400 校验、必填项与占位值检查、`NOJ_VERSION` 格式校验。复用 `src/judge/env.ts` 的读写风格，但保持独立。

## Task 2: 生产 compose 执行

**Files:** `compose.ts`, `compose_test.ts`

**Interfaces:**
- `export function prodComposeArgs(opts: { envFile: string; composeFile: string }, args: string[]): string[]`
- `export async function runProdCompose(opts, args, runner?): Promise<number>`
- `export async function waitForHealthy(opts, runner?): Promise<void>`（`docker compose up -d --wait`）

实现要点：与 `deploy.sh` 的 `run_compose` 一致；dry-run 由上层控制。

## Task 3: 生产生命周期

**Files:** `lifecycle.ts`, `lifecycle_test.ts`

**Interfaces:**
- `export interface ProdLifecycleOptions { dir: string; envFile: string; composeFile: string; dryRun?: boolean; follow?: boolean; services?: string[] }`
- `export async function prodStart(opts, runner?): Promise<number>`
- `export async function prodStop(opts, runner?): Promise<number>`
- `export async function prodRestart(opts, runner?): Promise<number>`
- `export async function prodStatus(opts, runner?): Promise<number>`
- `export async function prodLogs(opts, runner?): Promise<number>`

实现要点：移植 `deploy.sh` `start/stop/restart/status/logs`；status 输出 Compose ps 摘要；logs 支持 `--follow`。

## Task 4: 生产安装/升级/卸载

**Files:** `install.ts`, `install_test.ts`

**Interfaces:**
- `export interface ProdInstallOptions { dir: string; envFile: string; composeFile: string; nonInteractive?: boolean; dryRun?: boolean; panel?: "auto"|"baota"|"none" }`
- `export async function prodInstall(opts, runner?): Promise<number>`
- `export async function prodUpdate(opts, runner?): Promise<number>`（含 `--latest`）
- `export async function prodUninstall(opts, runner?): Promise<number>`

实现要点：移植 `deploy.sh` install/upgrade/uninstall 与 `install.sh` 文件同步；交互配置用 `PromptIO`；卸载确认词 `UNINSTALL` / `DELETE ALL`；`--all` 删除前校验 Git/jj 工作区拒绝逻辑。

## Task 5: 生产备份

**Files:** `backup.ts`, `backup_test.ts`

**Interfaces:**
- `export interface ProdBackupOptions { envFile: string; composeFile: string; backupDir: string; passphraseFile: string; snapshot?: string; confirm?: boolean; report?: string; }`
- `export async function prodBackupCreate(opts, runner?): Promise<string>`
- `export async function prodBackupVerify(opts, runner?): Promise<number>`
- `export async function prodBackupRestore(opts, runner?): Promise<number>`
- `export async function prodBackupDrill(opts, runner?): Promise<number>`

实现要点：移植 `backup.sh` create/verify/restore/drill；快照目录 `snapshot-*`、SHA-256、GPG AES256、Redis RDB、MinIO mirror、保留策略、Prometheus textfile 指标。

## Task 6: 生产 config

**Files:** `config.ts`, `config_test.ts`

**Interfaces:**
- `export async function prodConfigCheck(opts, runner?): Promise<number>`
- `export async function prodConfigShow(opts): Promise<string>`
- `export async function prodConfigSet(opts, key, value): Promise<number>`

实现要点：`check` 复用 `validateProdEnv` + Compose config；`show` 脱敏显示；`set` 写入前校验并保持权限 600。

## Task 7: 统一别名分发

**Files:** `dispatch.ts`, `dispatch_test.ts`, 修改 `src/cli.ts`

**Interfaces:**
- `export function isProdAlias(command: string): boolean`
- `export async function dispatchProdAlias(command: string, args: string[], ctx: { cwd: string }): Promise<number>`

在 `src/cli.ts` 中：保留 `PRODUCTION_COMMANDS` 兼容集合，但改为调用 `dispatchProdAlias`；`start/stop/...` 等别名映射到 `deploy`/`maintain`/`config` 统一模块或 production 模块。所有旧命令必须保持退出码和参数透传行为。

## Task 8: 文档与帮助

- `printHelp()` 增加统一命令树说明，保留旧命令兼容别名列表。
- `noj-cli/README.md` 更新 Phase 4 说明。
- 运行 `deno task test`、`deno task check`、`verify-md-links.ts`。

## 风险

- 直接移植 `deploy.sh`/`backup.sh` 工作量大，需分段实施。
- 行为漂移风险高：以现有 shell 测试为对照基线。
- 旧生产命令是现有用户入口，必须保持兼容。

## 后续

- Phase 5：脚本弃用与清理。
