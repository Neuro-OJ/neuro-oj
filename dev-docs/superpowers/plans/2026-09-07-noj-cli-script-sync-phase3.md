# noj-cli restore-drill 命令（Phase 3）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development (if subagents available).

**Goal:** 在 noj-cli 中新增 `restore-drill` 命令，Deno 化移植 `scripts/deploy/restore-drill.sh`，提供生产备份的隔离恢复演练（独立 Compose 项目、真实数据恢复与业务验收）。

**Architecture:** 新增 `noj-cli/src/restore_drill/` 模块。`options.ts` 解析参数；`snapshot.ts` 负责快照路径/元数据/文件校验；`compose.ts` 负责演练 Compose 覆盖与 docker compose 调用；`drill.ts` 聚合执行 restore → verify data → seed admin → start services → business verify → report → cleanup。业务验收继续复用 `scripts/deploy/restore-drill-verify.ts`（作为只读资产在 verifier 容器内运行）。

**Tech Stack:** Deno 2 + TypeScript、`@std/assert`、`@std/path`、现有 `CommandRunner`、`HttpClient`/HTTP 可选，不新增第三方运行时依赖。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-noj-cli-script-sync-design.md`

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行环境：仅 Deno 2 + TypeScript 标准环境；不新增第三方运行时依赖。
- 提交：使用 jj；提交信息格式 `<type>(<scope>): <中文描述>`，scope 使用 `cli`。
- 测试：通过 `cd noj-cli && deno task test` 运行；代码通过 `deno fmt` 与 `deno lint`。
- 所有改动必须位于当前 worktree（`.worktrees/noj-cli-improves/`）内，禁止修改主仓库。
- 不修改 `scripts/deploy/*.sh`；脚本保留为兜底。
- 行为基线：`scripts/deploy/restore-drill.sh` 是权威行为来源；安全边界（口令文件 600/400、禁止 prod 项目名、快照路径校验、RPO/RTO）必须保留。

## 文件结构

```
noj-cli/src/restore_drill/
├── options.ts          # RestoreDrillOptions + parseRestoreDrillArgs
├── options_test.ts
├── snapshot.ts         # 快照校验、元数据、RPO/RTO 计算
├── snapshot_test.ts
├── compose.ts          # 演练 Compose 覆盖生成与 docker compose 执行
├── compose_test.ts
└── drill.ts            # runRestoreDrill 编排
└── drill_test.ts
```

## Task 1: restore-drill 参数解析

**Files:** `options.ts`, `options_test.ts`

**Interfaces:**
- `export interface RestoreDrillOptions { snapshot: string; envFile: string; composeFile: string; passphraseFile: string; projectName: string; drillDir?: string; report?: string; subnet: string; rpoMaxHours: number; rtoMaxMinutes: number; waitTimeout: number; skipJudge: boolean; keep: boolean }`
- `export function parseRestoreDrillArgs(args: string[]): RestoreDrillOptions`

实现要点：按 `scripts/deploy/restore-drill.sh` `parse_args` 解析，默认值与脚本一致；校验 `projectName` 不含 `prod` 且只含小写字母数字 `-_`；RPO/RTO 为非负整数；`skipJudge`/`keep` 为布尔。

测试覆盖：缺省值、选项解析、非法 project name、非法 RPO/RTO。

## Task 2: 快照校验与元数据

**Files:** `snapshot.ts`, `snapshot_test.ts`

**Interfaces:**
- `export function validateSnapshotPath(snapshot: string): string`（规范化绝对路径，校验 `snapshot-*`、无 `..`）
- `export function checkSnapshotFiles(snapshot: string): string[]`（SUCCESS/manifest.json/env.prod.gpg 等缺失问题）
- `export function checkSecretFile(file: string): string[]`（存在且权限 600/400）
- `export function snapshotCreatedAt(snapshot: string): string`
- `export function hoursSinceSnapshot(createdAt: string): number`
- `export async function verifySnapshot(opts: { snapshot: string; envFile: string; composeFile: string; passphraseFile: string; runner?: CommandRunner }): Promise<string[]>`（移植 `backup.sh verify_snapshot`：SHA-256、GPG 解密、必要文件检查）

测试覆盖：合法/非法快照路径、成功标记缺失、RPO/RTO 解析。

## Task 3: 演练 Compose 管理

**Files:** `compose.ts`, `compose_test.ts`

**Interfaces:**
- `export interface DrillComposePaths { envFile: string; overrideFile: string; }
- `export function renderDrillOverride(subnet: string): string`（与脚本 `compose.drill-override.yml` 相同）
- `export function composeArgs(opts: RestoreDrillOptions, paths: DrillComposePaths, extra: string[]): string[]`
- `export async function runDrillCompose(opts, paths, args, runner?): Promise<number>`

测试覆盖：override 内容、compose args 顺序、dry-run 由上层处理。

## Task 4: 数据恢复与核对

**Files:** `drill.ts` 内部函数或单独 `restore.ts`；测试 `drill_test.ts`

实现函数（可放在 `drill.ts`）：
- `restoreDataServices(opts, ctx, runner)`
- `verifyData(opts, ctx, runner)`
- `seedDrillAdmin(opts, ctx, runner)`
- `startBusinessServices(opts, ctx, runner)`

这些函数按 `scripts/deploy/restore-drill.sh` 对应函数移植，使用 `ComposeContext`（envFile/override/report/tempDir）传递状态。使用 `CommandRunner` 注入 fake，避免真实 Docker。

测试覆盖：restore 顺序、verify 数据、seed admin、start business 的成功/失败路径。

## Task 5: runRestoreDrill 编排

**Files:** `drill.ts`, `drill_test.ts`

**Interfaces:**
- `export interface DrillContext { startAt: string; tempDir: string; report: string; composeEnvFile: string; overrideFile: string; keep: boolean; }`
- `export async function runRestoreDrill(opts: RestoreDrillOptions, runner?: CommandRunner): Promise<number>`
- 返回 `0` 成功、`1` 失败；失败时尽力清理并写失败报告。

实现流程（按脚本 `main` 顺序）：
1. `parse` 已由 CLI 完成
2. preflight（snapshot/passphrase/env/compose/docker/project name）
3. prepare dirs/env/override
4. restore + verify data
5. seed admin + start business services
6. run business verification
7. write report + metrics
8. cleanup (unless keep)

测试覆盖：`--skip-judge`、失败报告、dry-run 不真实执行（如有）。

## Task 6: CLI 挂载与文档

**Files:** `noj-cli/src/cli.ts`, `noj-cli/src/cli_test.ts`, `noj-cli/README.md`

- `KNOWN_TOP` 增加 `"restore-drill"`
- `case "restore-drill"` 调用 `parseRestoreDrillArgs` 和 `runRestoreDrill`
- `printHelp()` 增加 `restore-drill`
- README 增加命令说明

测试：help 包含 restore-drill，无 snapshot 参数返回非零。

---

## 后续

- Phase 4：production Deno 化与旧命令别名统一
- Phase 5：脚本弃用与清理
