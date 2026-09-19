# noj-cli 纯 TS 重写实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `noj-cli` 从「TS 外壳 + bash 内核 + 双模态配置」重写为**纯 TS 单模态** CLI，并现代化界面。

## Task 1: 基线快照与 Cliffy 依赖接入

**Files:**
- Modify: `noj-cli/deno.json`（加 `@cliffy/command` import）
- Create: `dev-docs/unattended/2026-09-19-baseline.md`

**Interfaces:**
- Consumes: 无（起点）
- Produces: `@cliffy/command` 可 import；基线记录可供后续对照

- [ ] **Step 1: 记录基线**

运行并记录（写入 `dev-docs/unattended/2026-09-19-baseline.md`）：
```bash
cd noj-cli && deno task test 2>&1 | tail -3    # 期望 ok | 323 passed | 0 failed
cd noj-cli && deno task check 2>&1 | tail -3
jj log --no-graph -r '@' -T 'commit_id ++ "\n"'   # 冻结 SHA
```

- [ ] **Step 2: 加 Cliffy 依赖**

```bash
cd noj-cli && deno add jsr:@cliffy/command@1.2.1
```
（**禁止**手改 deno.lock。）

- [ ] **Step 3: 写冒烟测试证明依赖可用**

Create `noj-cli/src/core/cliffy_smoke_test.ts`：
```ts
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";

Deno.test("Cliffy 可实例化并解析 variadic 透传参数", async () => {
  const seen: string[] = [];
  const cli = new Command()
    .name("t").throwErrors().allowEmpty()
    .command("install")
    .arguments("[args...:string]")
    .action((_o, ...args: string[]) => { seen.push(...args); });
  await cli.parse(["install", "--port", "8080", "--panel", "baota"]);
  assertEquals(seen, ["--port", "8080", "--panel", "baota"]);
});
```

- [ ] **Step 4: 运行并确认通过**

Run: `cd noj-cli && deno task test 2>&1 | tail -3`
Expected: `324 passed | 0 failed`（323 + 1 新增）

- [ ] **Step 5: 门禁 + 提交**

```bash
cd noj-cli && deno task check
jj describe -m "chore(cli): 接入 Cliffy 依赖并记录重写基线"
jj new
```

---

## Task 2: 配置 schema（core/config-schema.ts）

**Files:**
- Create: `noj-cli/src/core/config-schema.ts`
- Test: `noj-cli/src/core/config_schema_test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface EnvKeySpec { key: string; required: boolean; secret?: boolean; note?: string }`
  - `export const ENV_KEYS: readonly EnvKeySpec[]`
  - `export function validateEnv(env: Record<string,string>): { missing: string[]; placeholder: string[] }`
  - `export function isPlaceholder(value: string | undefined): boolean`
  - `export const JUDGE_KEYS: readonly string[]`（`JUDGE_ENABLED=true` 时额外必需）

**来源（对照 bash，不得遗漏）**：`scripts/deploy/deploy.sh:684-711` 的 `check_required_values` 硬编码 19 个键 + judge 2 个键。

- [ ] **Step 1: 写失败测试**

Create `noj-cli/src/core/config_schema_test.ts`：
```ts
import { assertEquals } from "@std/assert";
import { ENV_KEYS, isPlaceholder, validateEnv } from "./config-schema.ts";

Deno.test("ENV_KEYS 覆盖 bash 硬编码的 19 个键", () => {
  const names = ENV_KEYS.map((k) => k.key);
  for (const k of ["NOJ_VERSION","DOMAIN","APP_URL","CORS_ALLOWED_ORIGINS","TRUSTED_PROXIES",
    "POSTGRES_PASSWORD","REDIS_PASSWORD","MINIO_ROOT_USER","MINIO_ROOT_PASSWORD",
    "S3_ACCESS_KEY","S3_SECRET_KEY","S3_BUCKET","S3_ENDPOINT","STORAGE_PROVIDER",
    "JWT_SECRET","TFA_ENCRYPTION_KEY","NOJ_LLM_SERVICE_TOKEN","NOJ_LLM_STORE_KEY","EMAIL_PROVIDER"]) {
    assertEquals(names.includes(k), true, "缺少键: " + k);
  }
});

Deno.test("isPlaceholder 识别空值与占位值", () => {
  assertEquals(isPlaceholder(undefined), true);
  assertEquals(isPlaceholder(""), true);
  assertEquals(isPlaceholder("change-this-in-production"), true);
  assertEquals(isPlaceholder("your-domain.example.com"), true);
  assertEquals(isPlaceholder("real.example.com"), false);
});

Deno.test("validateEnv 报告缺失与占位", () => {
  const r = validateEnv({ DOMAIN: "", APP_URL: "https://real.example.com" });
  assertEquals(r.missing.includes("DOMAIN"), true);
  assertEquals(r.missing.includes("APP_URL"), false);
});

Deno.test("judge 启用时额外要求 JUDGE_DOCKER_SOCKET 与 GID", () => {
  const r = validateEnv({ JUDGE_ENABLED: "true" });
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET"), true);
  assertEquals(r.missing.includes("JUDGE_DOCKER_SOCKET_GID"), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-cli && deno task test 2>&1 | tail -5`
Expected: FAIL — `Module not found` / `config-schema.ts`

- [ ] **Step 3: 实现**

Create `noj-cli/src/core/config-schema.ts`（键清单与 `deploy.sh:686-710` 逐字一致；`isPlaceholder` 对照 `deploy.sh:667-675` 的占位判断，含 `change-this`/`REPLACE_WITH_`/`your-` 等前缀）。

- [ ] **Step 4: 运行确认通过**

Run: `cd noj-cli && deno task test 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd noj-cli && deno task check
jj describe -m "feat(cli): 新增唯一配置 schema，替换 bash 硬编码的 19 个键名"
jj new
```

---

## Task 3: .env.prod 读写（core/env-file.ts）

**Files:**
- Create: `noj-cli/src/core/env-file.ts`
- Test: `noj-cli/src/core/env_file_test.ts`

**Interfaces:**
- Produces:
  - `export function parseEnvFile(text: string): Map<string,string>`
  - `export function serializeEnvFile(entries: Map<string,string>, original: string): string`（保留注释与顺序，仅改动的键就地更新）
  - `export async function readEnvFile(path: string): Promise<Map<string,string>>`
  - `export async function writeEnvFileAtomic(path: string, entries: Map<string,string>): Promise<void>`（临时文件 + chmod 600 + rename）

- [ ] **Step 1: 写失败测试**（覆盖：注释保留、引号剥离、`=` 在值中、CRLF、原子写权限 600、不存在文件报错）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（对照 `deploy.sh:181-192` 的 `env_value` 与 `:200-219` 的 `set_env_value` 语义）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `feat(cli): 新增 .env.prod 原子读写（保留注释与顺序）`

---

## Task 4: 唯一状态机（core/state.ts）

**Files:**
- Create: `noj-cli/src/core/state.ts`
- Test: `noj-cli/src/core/state_test.ts`
- Reference: `noj-cli/src/state/machine.ts`（现有实现，M1 移植源）

**Interfaces:**
- Produces: 与现有 `transition()` 相同的 `DeployAction`/`DeployState` 语义，新增 `prodState(composePsOutput): DeployState`

- [ ] **Step 1: 写失败测试**（`up` 已 running → no-op；`down` 已 stopped → no-op；`prodState` 从 `docker compose ps` 输出推断 running/stopped/partial）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（移植 `state/machine.ts`；`prodState` 为新增，解决 §2.2 的 prod 无状态问题）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `feat(cli): 状态机提升为公共内核并支持 prod 路径`

---

## Task 5: profile 探测修复（洞 1）

**Files:**
- Modify: `noj-cli/src/profile.ts:52-58`
- Modify: `noj-cli/src/production.ts:20-28`
- Test: `noj-cli/src/profile_test.ts`

**Interfaces:**
- Produces: `PRODUCTION_MARKERS = ["docker-compose.prod.yml", ".env.prod"]`

- [ ] **Step 1: 更新测试**（把 mock fs 的 `/opt/scripts/deploy/production.sh` 改为 `/opt/.env.prod`；**新增**：仅有 `production.sh` 无 `.env.prod` → 不再判定为 prod）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（两处常量同步改；`isInstallDir` 同）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `fix(cli): profile 探测标记改用 .env.prod，避免删除 production.sh 后自锁`

---

## Task 6: JSON 输出通道硬化（output/render.ts）

**Files:**
- Create: `noj-cli/src/output/render.ts`
- Test: `noj-cli/src/output/render_test.ts`

**Interfaces:**
- Produces:
  - `export function emitJson(value: unknown, io?: { stdout: (s: string) => void }): void` — 只 `JSON.stringify` 到 stdout
  - `export function emitHuman(text: string, io?): void` — 人类输出只在 `--json` 关闭时写 stdout，否则写 stderr
  - `export function isJsonMode(args: string[]): boolean`

- [ ] **Step 1: 写失败测试**（`--json` 时 stdout 不含装饰；人类输出不污染 stdout；非 json 时正常）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `feat(cli): --json 走独立通道，保证 stdout 逐字节为合法 JSON`

---

## Task 7: 命令树单一事实源 + 防漂移门禁

**Files:**
- Create: `noj-cli/src/commands.ts` — 声明式命令清单（单一事实源）
- Create: `noj-cli/src/commands_test.ts` — 含**防漂移门禁**
- Modify: `noj-cli/src/mod.ts` — 导出新原语（T6 的 `emitJson`/`emitHuman`/`isJsonMode`/`RenderIO` 与 T2–T6 的 core 模块）
- Modify: `noj-cli/src/cli.ts` — `printHelp` 改由 `commands.ts` 生成

**Interfaces:**
- Produces:
  - `export interface CommandSpec { name: string; summary: string; aliases?: string[]; tier: Tier; subcommands?: CommandSpec[] }`
  - `export const COMMANDS: readonly CommandSpec[]`
  - `export function renderCommandList(): string`
  - `export function declaredTopLevelNames(): Set<string>`
- Consumes: T6 `output/render.ts`; T2–T5 core 模块

**背景（为何这是关键路径）**：现状 help 文案手写在 **8 个渲染函数**里，已实测漂移——`noj-cli backup --help` 漏列 `list`/`prune`（真实能力），根因是同一份文案维护在 4 处（`help.ts:52` 对，`cli.ts:1064/1567/1640` 错）。本任务把命令清单收敛为**单一事实源**，并加**门禁**使漂移不可能再发生。

- [ ] **Step 1: 写失败测试（含门禁）**

Create `noj-cli/src/commands_test.ts`：
- 断言 `COMMANDS` 非空且每项 `name`/`summary` 非空、`name` 唯一。
- 断言 `renderCommandList()` 含每个顶层命令名。
- **防漂移门禁**：断言「`declaredTopLevelNames()` ⊆ 实际可处理集合」。实际可处理集合的来源须**从 `cli.ts` 的既有判定读取**（`PRODUCTION_COMMANDS`、`KNOWN_TOP`/switch 分支、`problem`/`stack` 等特判），不得硬编码第二份清单——否则门禁自身会漂移。设计一个可导出的「dispatcher 可处理集合」取得方式；若 cli.ts 当前未导出，**导出它**（最小改动）。
- 断言 `backup` 的子命令声明**包含 `list` 与 `prune`**（本次已实测漂移的回归断言）。

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-cli && deno task test 2>&1 | tail -5`
Expected: FAIL — `commands.ts` 不存在

- [ ] **Step 3: 实现**

Create `noj-cli/src/commands.ts`：
- 从既有 `help.ts` 的 `COMMANDS` 结构与 `cli.ts` 的实际分支**逐条核对**后建立清单（**以代码为准**，不以 help 文案为准——help 已知有漂移）。
- `tier` 表示分组（如 `"prod" | "stack" | "problem" | "tier3" | "global"`），用于渲染分区。
- `renderCommandList()` 输出与现状**信息等价或更准确**的文本（可含分组标题）；**不得**丢失任何现役命令。
- Modify `cli.ts`：`printHelp()` 改为调用 `renderCommandList()`，删除重复的手写清单（保留 `renderCommandHelp` 等命令级帮助不动，本任务只收敛**清单**）。
- Modify `mod.ts`：导出 T2–T6 的新模块（`core/config-schema.ts`、`core/env-file.ts`、`core/state.ts`、`output/render.ts`）与原语。

- [ ] **Step 4: 运行确认通过**

Run: `cd noj-cli && deno task test 2>&1 | tail -3` 与 `cd noj-cli && deno task check`

**注意**：`cli_test.ts` 有既有断言依赖 help 文案（如「printHelp 按模式分区并包含全部命令」、「不再声称 maintain backup 支持 schedule」）。**不得删除或弱化**这些断言；若文案变化导致失败，修正实现使其仍满足原意（分区 + 准确）。

- [ ] **Step 5: 提交**

```bash
cd noj-cli && deno task check
jj describe -m "refactor(cli): 命令清单收敛为单一事实源并新增防漂移门禁"
jj new
```

**明确不做**：本任务**不**引入 Cliffy 接管解析（透传仍在，Cliffy 迁移在 T23 之后按 spec §5 进行）；**不**改动命令行为与退出码；**不**删除 `renderProductionCommandHelp`/`renderDeployHelp`/`renderMaintainHelp`（T23 处理）。

---

## Task 8: 渲染与主题（品牌 token 语义色 + 表格）

**Files:**
- Create: `noj-cli/src/output/theme.ts` — 语义色映射（取品牌 token）
- Create: `noj-cli/src/output/theme_test.ts`
- Modify: `dev-docs/design/noj-design-tokens.md` — 补 **CLI/终端 section**
- Modify: `noj-cli/src/output/render.ts` — 加表格与状态符号渲染
- Modify: `noj-cli/src/output/render_test.ts`

**Consumes**：T6 的 `RenderIO`/`emitHuman`/`emitJson`/`isJsonMode`

**背景**：spec §1.2 实测——"加 ANSI 颜色"大部分已存在（`util/color.ts` 已有 `NO_COLOR`/`LOG_COLOR`/`--color`/非 TTY 关色/`prefixLine`），**真实缺口是排版（表格/对齐/状态符号）与品牌对齐**：`noj-design-tokens.md` 有完整 token 但**无 CLI/终端 section**（`rg 'CLI|终端|ANSI'` 零命中），现调色板是任意 8 色。

- [ ] **Step 1: 写失败测试**

`theme_test.ts` + `render_test.ts` 覆盖：
- 语义色（成功/警告/错误/信息/强调）在**非 TTY 或 `NO_COLOR` 非空**时**不输出任何 ANSI 转义**（断言字符串不含 `\x1b[`）。
- `--color=always` 时**有** ANSI；`never` 时无（沿用 `util/color.ts:resolveColor`，不得另造契约）。
- `NO_COLOR` 优先于 `always`（既有契约，回归）。
- 表格渲染：列对齐（padEnd 到最宽单元格）、**窄终端不破版**（给定宽度时截断或换行且总宽 ≤ 宽度）、空表不抛错。
- 状态符号与语义色配对（成功/警告/错误各一）。
- **`--json` 模式下表格渲染不得写 stdout**（复用 T6 契约）。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- `theme.ts`：从 `noj-design-tokens.md` 的语义 token（`--c-success-text` 等）取概念映射到 ANSI 前景色；**必须先给 token 文档补 CLI/终端 section**，再据其实施（不要凭感觉配色）。复用 `util/color.ts` 的 `resolveColor` 决定是否着色，**不新增第二套 NO_COLOR 判定**。
- `render.ts`：新增 `renderTable(rows, opts)` 与 `renderStatus(kind, text)`（命名可按实现调整，但须导出并测试）。表格须处理 **CJK 宽度**（中文占 2 列）——若实现复杂度过高，可先只保证 ASCII 对齐并在报告中显式标注 CJK 未处理，**不得**假装处理了。
- `noj-design-tokens.md`：新增 CLI/终端 section，列出语义色 → ANSI 的映射与降级规则。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 品牌 token 语义色与表格渲染（CLI 排版）`

**明确不做**：不改 `util/color.ts` 的既有契约（只复用）；不迁移既有调用点（T18）；不引入运行时依赖（表格自绘或复用已有）。

---

## Task 9: bootstrap（洞 2：从 Release 下载 compose 与 example 配置）

**Files:**
- Create: `noj-cli/src/prod/bootstrap.ts`
- Create: `noj-cli/src/prod/bootstrap_test.ts`
- Modify: `.github/workflows/release.yml` — **发布资产必须新增 compose 与 example 配置**
- Modify: `noj-cli/src/mod.ts` — 导出新符号

**Consumes**：T3 `writeEnvFileAtomic`（若需写配置）；T1 的 Cliffy 不涉及

**背景（spec §3.3 洞 2）**：R4 要求移除 `setup.sh`/`install.sh`、用户手动下载二进制。但删掉 `install.sh` 后，`install` 仍需 `docker-compose.prod.yml`（与 `.env.prod.example`）——**原来自源码归档**（`install.sh` 下载 `$REPO/archive/$REF.tar.gz` 后 `cp`）。本任务把该职责吸收进 CLI：**从 GitHub Release 下载这两个文件并校验**。

> ⚠️ **实测的硬前置**：`.github/workflows/release.yml:110-113` 当前**只上传** `noj-cli-linux-amd64` + `.sha256`。**没有** `docker-compose.prod.yml` / `.env.prod.example`。因此本任务**必须同时改 release workflow**，否则 bootstrap 在生产无资产可下载（而单测用注入 fetcher 不会发现）。这是本任务的一部分，不是"以后再说"。

- [ ] **Step 1: 写失败测试**

`bootstrap_test.ts` 用**注入的 fetcher**（不触网）覆盖：
- 成功路径：下载 compose + example 到目标目录，且**逐字节**等于 fake 内容。
- **SHA-256 校验失败 → 抛错且不写入任何文件**（断言目标目录为空/原文件未被覆盖）。
- 校验文件格式非法（非 64 位 hex）→ 抛错。
- 目标文件已存在时的策略：显式定义（覆盖 vs 拒绝）并测试；必须在报告中说明选择理由。
- URL 构造：给定 repo/ref，断言拼出的 URL 形状正确（可用注入 fetcher 捕获请求 URL）。
- **安全**：URL 必须 HTTPS；ref 必须经字符白名单校验（对照 `install.sh:185-190` 的 `validate_ref`）——断言非法 ref（含 `..`、前导 `/`、空格）被拒。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- `prod/bootstrap.ts`：导出形如 `fetchReleaseAssets(opts, fetcher)` 与 `validateRef(ref)` 的函数（命名可调，须导出并测试）。要求：
  - 参数以**数组/结构体**构造，不拼 shell 字符串。
  - 复用 `@std` 或 `Deno.Command("curl"|"wget")` 之外的方式：优先用 **`fetch()`**（Deno 内置），避免依赖外部二进制；若必须用 `curl`，须在报告中说明并保证无 shell 注入。
  - SHA-256 用 `util/hash.ts` 的既有实现（勿自造）。
  - **失败原子性**：先下载+校验到临时位置，全部通过后才写入目标；任一步失败不得留下半成品。
- Modify `.github/workflows/release.yml`：在 `gh release upload` 中新增
  `docker-compose.prod.yml`、`docker-compose.prod.yml.sha256`、`.env.prod.example`、`.env.prod.example.sha256`（生成方式与既有 CLI 资产一致，用 `sha256sum`）。
- Modify `mod.ts`：导出新符号。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): bootstrap 从 Release 下载 compose/example 并校验（吸收 install.sh 职责）`

**明确不做**：本任务**不**删除 `install.sh`（T24 删）；**不**实现完整 `install` 流程（T12）；**不**让 bootstrap 依赖源码归档。

---

## Task 10: compose 服务集与调用（prod/compose.ts）

**Files:**
- Create: `noj-cli/src/prod/compose.ts`
- Create: `noj-cli/src/prod/compose_test.ts`
- Modify: `noj-cli/src/mod.ts`

**背景（spec §3.4 洞 3）**：现 `stack` 模式**运行时渲染** `docker-compose.noj.yml`（`deploy/compose.ts:renderCompose()`），而 `prod` 用**仓库内固定**的 `docker-compose.prod.yml`。**两者不是同一份编排**。**裁决（spec §3.4）**：保留受版本管理的 `docker-compose.prod.yml` 为唯一生产编排（由 T9 bootstrap 下载并校验），**不引入运行时渲染**。理由：固定文件的容器集合/健康检查/profile 已受 CI 与 e2e 测试；运行时渲染会引入未被测试覆盖的编排面。

**实测的 prod 服务集（须逐服务核对，不得遗漏）**：
`migrate`、`core`、`ui`、`judge`(**profile judge**)、`llm-gateway`、`nginx`、`prometheus`(**profile monitoring**)、`alertmanager`(**profile monitoring**)、`postgres`、`redis`、`minio`、`minio-init`。
顶层卷/网络：`noj-net`(network)、`pgdata`、`redisdata`、`miniodata`、`noj-packages`、`noj-storage`、`judge-cache`、`promdata`、`alertmanagerdata`。

- [ ] **Step 1: 写失败测试**

`compose_test.ts` 覆盖（**注入 runner**，不触真实 docker）：
- `composeArgs()` 参数数组形状正确：`["compose", "--env-file", <env>, "-f", <compose>, ...]`，且 **以数组构造，无 shell 字符串**。
- `judge` profile：启用时含 `--profile judge`，否则不含。
- `monitoring` profile：按开关含/不含 `--profile monitoring`。
- **服务集核对**：导出 `PROD_SERVICES`（含 profile 归属），断言其与 `docker-compose.prod.yml` 中**实际服务名集合一致**——通过**读取真实 compose 文件**解析（`^  <name>:` 缩进层级）来断言，而非硬编码第二份清单。若解析难以实现，退化为"文件包含每个服务名"并**在报告中显式说明退化**。
- `up`/`down`/`ps`/`logs`/`config` 各自拼出预期参数（对照 `deploy/docker.ts:4-49` 的既有形状）。
- `--dry-run` 时**不执行** runner，只返回将执行的参数。
- 退出码透传。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

`prod/compose.ts`：
- 导出 `PROD_SERVICES`（服务名 + 所属 profile）、`composeArgs(opts)`，以及 `up/down/ps/logs/config` 的薄封装。复用既有 `runtime/command.ts` 的 `CommandRunner` 抽象，勿新造。
- **不改** `deploy/docker.ts`（stack 侧，T23 删）；本模块是 prod 侧新实现。
- 不实现运行时 compose 渲染（见上「裁决」）。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): prod compose 服务集与调用封装（不引入运行时渲染）`

**明确不做**：不删 `deploy/compose.ts`（T23）；不实现生命周期命令（T12–T16）；不决定监控 profile 的默认值（由 T11 配置决定）。

---

## Task 11: 配置校验与交互向导（prod/config.ts）

**Files:**
- Create: `noj-cli/src/prod/config.ts`
- Create: `noj-cli/src/prod/config_test.ts`
- Modify: `noj-cli/src/mod.ts`

**Consumes**：T2 `ENV_KEYS`/`validateEnv`/`judgeEnabledError`/`isPlaceholder`；T3 `parseEnvFile`/`readEnvFile`/`writeEnvFileAtomic`；T4 状态机（state 落盘）；T8 主题（渲染提示）

**背景**：bash 侧的配置能力散在 `deploy.sh` 多处，须逐项迁入 TS 并与 `scripts/deploy/deploy.sh` 行为一致（R3）：
`check_required_values`(:684)、`check_judge_socket`(:768)、`check_port_value`(:780)、`is_site_address`(:354)、`detect_panel`(:791)、`verify_image_signatures`(:837)、`ensure_backup_passphrase`(:920)、`generate_secret`(:220)、`prompt_text`/`prompt_secret`(:226/:245)、`configure_env_interactive`(:429)。

**⚠️ T2 的 CARRY-FORWARD（必须遵守）**：`validateEnv` **不承载** `JUDGE_ENABLED` 枚举错误。调用方**必须先** `judgeEnabledError(env.JUDGE_ENABLED)`，非 null 即报错返回，**再**进 `validateEnv`。且 `JUDGE_ENABLED` **未设置（空串）视为启用**（与 bash `judge_enabled`:679 一致）。

**⚠️ T3 的 CARRY-FORWARD**：`writeEnvFileAtomic` **不 mkdir 父目录**（调用方保证目录存在）；`readEnvFile` 对缺失文件抛普通 Error。

- [ ] **Step 1: 写失败测试**

`config_test.ts` 覆盖（注入 IO/fs，不触真实网络与 docker）：
- **必填校验**：缺失/占位键进入 `missing`/`placeholder`（对照 T2 语义）。
- **judge 枚举**：`JUDGE_ENABLED="maybe"` → 报错（先于 `validateEnv`）；`""`/未设置 → 视为启用且要求 judge 键；`false` → 不要求。
- **口令文件**（`ensure_backup_passphrase` 迁移）：缺失时**自动生成**到 `/etc/noj/backup-passphrase`，权限 **600**；已存在则复用；权限非 600/400 → **拒绝并给可操作提示**（对照 `deploy.sh:916-953` 与 `passphrase_file_mode`）。
- **站点地址**：`is_site_address` 的接受/拒绝用例（域名 vs IP vs 非法）。
- **端口**：`check_port_value` 边界（1-65535、非数字）。
- **judge socket**：启用 judge 时校验 socket 路径与 GID（对照 `:768`）。
- **交互向导**：给定输入序列产出预期 `.env.prod` 键值（用注入 IO）；**非 TTY 且缺必需参数时明确报错**，不进交互循环（对照 `non_interactive.ts` 与 #517 E10）。
- **敏感值**：向导**不得**把 secret 回显到输出（断言输出不含 secret 字面量）。
- **镜像验签**（`verify_image_signatures`）：迁移为可注入执行器的函数；测试断言调用形状与失败退出码（不真的跑 cosign）。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- `prod/config.ts`：逐函数迁移；**必须复用** T2/T3/T8 的模块，不重复实现占位判断/键清单/env 读写/着色。
- 交互用既有 `tui/widgets.ts`（`select`/`input`/`secretInput`/`confirm`）与 T8 主题；**不要**新造提示函数。
- 宝塔面板检测（`detect_panel`）与 `record_deployment_metadata` 一并迁入（对照 `:791`/`:875`），行为一致。
- 所有外部命令（cosign/docker）经 `runtime/command.ts` 的 runner 注入，便于测试。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 迁移生产配置校验、口令生成与交互向导到 TS`

**明确不做**：不实现 install/start/stop 等生命周期动作（T12–T16）；不删除 bash（T24）；不改 T2/T3 已交付模块的公开契约。

---

## Task 12: install（唯一生产安装路径）

**Files:**
- Create: `noj-cli/src/prod/lifecycle.ts`（本任务只加 install 部分）
- Create: `noj-cli/src/prod/lifecycle_test.ts`
- Modify: `noj-cli/src/mod.ts`

**Consumes**：T5 `PRODUCTION_MARKERS` 逻辑；T9 `downloadReleaseFiles`；T10 `PRODUCTION_MARKERS` 逻辑；T11 `checkRequiredValues`/`ensureBackupPassphrase`/`checkEnvFileMode`/向导；T4 状态机

**背景（spec R4 + §3.3 洞 2）**：删除 `setup.sh`/`install.sh` 后，用户**手动下载 `noj-cli` 二进制**，在空目录执行 `noj-cli install --dir <dir>` 即应完成安装。安装所需文件（`docker-compose.prod.yml` + `.env.prod.example`）由 **T9 bootstrap** 从 Release 下载并校验；配置向导与校验由 **T11** 提供。本任务把三者接成一条**唯一**安装路径。

**⚠️ 上游 CARRY-FORWARD（全部必须落实）**
1. **T9**：`downloadReleaseFiles` 的 `overwrite` **默认 false（refuse）** → 首次安装传 `overwrite:false`（或省略），**升级路径必须显式 `overwrite:true`**。资产名 = `docker-compose.prod.yml`、`.env.prod.example`（各带 `.sha256`）。
2. **T11**：调用顺序必须是 **先 `judgeEnabledError` → 再 `validateEnv`**；judge 未设置/空串 = **启用**。口令回填**仅进程环境变量抑制**（`configuredFromEnv`），`--passphrase-file` **不**抑制。须调 `checkEnvFileMode(mode, envFile)` 校验 `.env.prod` 权限 600/400。`cosignAvailable` 缺省 true，**须注入** `command -v cosign` 的真实结果。
3. **T10**：`ComposeResult = CmdResult | string[]`，**必须 `Array.isArray` 收窄**；runner 不替调用方打印。
4. **T11**：`backupPassphrasePath` 须经 `targetFile` 注入 `--passphrase-file` 路径。

- [ ] **Step 1: 写失败测试**

`lifecycle_test.ts`（注入 runner/fetcher/IO，**不触网、不起容器**）：
- **空目录安装**：仅给二进制与 `--dir`，断言顺序 = 拉取资产 → 校验 → 生成/复用 `.env.prod` → 启动 compose；断言每一步的文件与调用。
- **幂等/已安装**：目录含 `.env.prod` + `docker-compose.prod.yml` 时走升级路径（`overwrite:true`），保留既有 `.env.prod`（断言内容不被覆盖）。
- **非交互**：`--non-interactive` 且缺必需配置 → **明确报错**，不进向导、不写文件。
- **PATH 注册**：安装成功后注册 `bin/noj-cli`（对照 `production.sh:97-131` 的 `register_command` 语义：优先 `/usr/local/bin`，权限不足退 `~/.local/bin`，**拒绝覆盖同名且指向他处的命令**）。
- **失败原子性**：资产校验失败 → 不启动 compose、不写 `.env.prod`。
- **权限**：`.env.prod` 权限非 600/400 → 安装前拒绝。
- **cosign**：`cosignAvailable=false` 时跳过验签并**给出可见警告**（不静默跳过）。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

`prod/lifecycle.ts` 的 `install()`：串起 T9 → T11 → T10，落状态（T4）并输出结果。所有外部命令经注入 runner；所有 IO 经注入接口。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 实现唯一生产安装路径（bootstrap + 配置向导 + compose 启动）`

**明确不做**：不删 bash（T24）；不实现 start/stop/restart/status/logs/uninstall/update（T13–T16）；不实现备份（T17–T19）。

---

## Task 13: start / stop / restart / status（含 T4 状态机接线）

**Files:**
- Modify: `noj-cli/src/prod/lifecycle.ts`（加 start/stop/restart/status）
- Modify: `noj-cli/src/prod/lifecycle_test.ts`
- Create: `noj-cli/src/prod/lifecycle/steps.ts`（T12 评审建议：把 compose 编排段拆出，为 T14–T16 预留结构）
- Modify: `noj-cli/src/mod.ts`

**Consumes**：T4 `prodState`/`transition`/`upIsNoOp`/`downIsNoOp`；T10 `composeUp`/`composeDown`/`composePs`（`ComposeResult`，须 `Array.isArray` 收窄）；T11 `checkRequiredValues`/`checkEnvFileMode`；T12 `install()` 的既有步骤结构

**⚠️ T12 的 CARRY-FORWARD**：install 曾**有意**不落状态（与 bash 一致），已登记延后到本任务。**本任务必须接线 T4 状态机**：`status` 用 `prodState(docker compose ps 输出)` 推断状态；`start`/`stop` 用 `upIsNoOp`/`downIsNoOp` 做 no-op 判定。

**对照 bash（R3）**：`deploy.sh` `start()`(:1027)、`stop()`(:1045)、`status()`(:1112)、`wait_for_stack()`(:981-993)、`prepare_and_check()`(:994)。

- [ ] **Step 1: 写失败测试**

`lifecycle_test.ts` 追加（注入 runner，无真实 docker）：
- **status**：给注入的 `compose ps` 输出（全 Up / 混合 / 全 Exited / 空），断言 `prodState` 结论与报告形状（running/partial/stopped）；退出码 0。
- **start**：已 running 时**no-op**（不重复 up；断言 runner 未被调用 up）；stopped 时执行 up（含 `--wait`）。
- **stop**：已 stopped 时 no-op；running 时执行 `stop`（**不得** down -v，断言参数含 `stop` 或不含 `-v`）。
- **restart**：先 stop 再 up 的顺序断言。
- **wait_for_stack 语义**：断言 `up -d --wait --wait-timeout 180 --remove-orphans` + 第二次 `up -d --force-recreate --no-deps nginx`（T12 未迁，本任务补齐）。
- **失败传播**：wait 失败 → 非零退出并提示 `status`/`logs`（对照 bash `fail` 文案）。
- **权限/配置前置**：`.env.prod` 权限非 600/400 → 拒绝；缺必需配置 → 报错（复用 T11/T12 的既有判定，勿重写）。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- 把 compose 编排段抽到 `prod/lifecycle/steps.ts`（T12 评审建议），`lifecycle.ts` 保留命令入口；**不得**为此改动 T10 的公开契约。
- `start`/`stop`/`restart`/`status` 各自实现；`restart` 走 stop→up。
- `status` 输出用 T8 的表格/状态符号（人类可读），并保留 `--json` 机器可读（T6 通道，stdout 只含 JSON）。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 迁移 start/stop/restart/status 并接线 T4 状态机`

**明确不做**：不删 bash（T24）；不实现 logs/uninstall/update（T14–T16）与备份（T17–T19）；不改 T10 契约。

---

## Task 14: logs（颜色契约 + --follow）

**Files:**
- Modify: `noj-cli/src/prod/lifecycle.ts`（加 logs）
- Modify: `noj-cli/src/prod/lifecycle/steps.ts`
- Modify: `noj-cli/src/prod/lifecycle_test.ts`
- Modify: `noj-cli/src/mod.ts`

**Consumes**：T10 `composeLogs`/`composeArgs`（`ComposeResult`，`Array.isArray` 收窄）；T6 `emitHuman`/`isJsonMode`；T8 主题；`util/color.ts` 的 `resolveColor`/`ColorMode`（**唯一**着色判定来源，勿另造）；`runtime/command.ts` 的 `CommandRunner.stream`（实时跟随）

**背景**：bash `deploy.sh:1117-1158` 的 `logs()` 有一套**明确**的着色优先级，且有评审修复历史（首次实现无条件透传，导致 `noj-cli logs core > out.txt` 把 ANSI 写进重定向文件）。本任务须精确迁移该契约。

**着色判定顺序（对照 `deploy.sh:1138-1157`，逐条实现）**：
1. `LOG_COLOR` 取值：**进程环境优先**，缺省回退读 `.env.prod` 的 `LOG_COLOR`；随后 trim + 小写。
2. `NO_COLOR` 同理：进程环境优先，回退 `.env.prod`。
3. 判定：`NO_COLOR` 非空 **或** `LOG_COLOR=never` → 传 `--no-color`；`LOG_COLOR=always` → **强制着色**；否则 `!isatty(1)` → `--no-color`。
4. **强制着色必须用子命令之前的全局 `--ansi always`**（`docker compose logs` 只有 `--no-color`，没有"强制开"的单命令开关——bash 注释明确记录此坑）。
5. 位置参数（服务名）透传。
6. `--tail=200` 为默认；`--follow` 时追加。

- [ ] **Step 1: 写失败测试**

- **优先级**：进程 env `LOG_COLOR=always` 覆盖 `.env.prod` 的 `never`（且反之：进程 env 未设时读 `.env.prod`）。
- **大小写与空白**：`LOG_COLOR=" ALWAYS "` → 视为 always。
- **`NO_COLOR` 非空** → `--no-color`，即使 `LOG_COLOR=always`（对照 bash：`NO_COLOR` 分支在前）。
- **非 TTY 默认** → `--no-color`。
- **强制着色** → 断言全局 `--ansi always` 出现在**子命令之前**（而非 `logs` 之后）。
- **服务名与 --follow**：`logs core --follow` → `--tail=200 --follow core`。
- **重定向不写 ANSI**：模拟非 TTY，断言输出不含 `\x1b[`。
- **实时跟随**：`--follow` 走 `CommandRunner.stream`（T12/T14 已知：`composeLogs` 经 `run()` 是**缓冲**的，实时需 `stream`），断言 stream 被调用而非 run。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- `logs` 复用 `util/color.ts` 的判定（**不得**新造第二套 `NO_COLOR`/`LOG_COLOR` 解析；若现有 `resolveColor` 不足以表达"进程 env > .env.prod"，则在其**上层**做取值合并，仍只调用 `resolveColor` 决定最终开关）。
- `--follow` 用 `CommandRunner.stream` 实时输出；非 follow 用既有缓冲路径并自行写 stdout（runner 不打印）。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 迁移生产 logs 并精确实现着色优先级与实时跟随`

**明确不做**：不删 bash（T24）；不实现 uninstall/update（T15–T16）与备份；不改 T10 契约；不迁移 T13 已完成的命令。

---

## Task 15: uninstall（确认词 + 数据卷安全 + 工作区保护）

**Files:**
- Modify: `noj-cli/src/prod/lifecycle.ts`、`prod/lifecycle/steps.ts`、`prod/lifecycle_test.ts`、`src/mod.ts`

**Consumes**：T10 `composeArgs`（`down --remove-orphans --rmi ... [--volumes]`）；T12 的 `registerCommand` 反向逻辑（软链清理）；`runtime/command.ts` 的 runner；T6 `emitHuman`

**对照 bash（R3）**：`deploy.sh` `confirm_uninstall()`:1052-1084、`check_uninstall_dependencies()`:1085-1096、`uninstall()`:1097-1111。**关键：这是破坏性命令，逐条对齐。**

**必须实现的行为**
1. **确认词**（`confirm_uninstall`，:1052-1084）：`--yes` 跳过；无 TTY 且未 `--yes` → **报错**（"卸载需要交互确认；自动化环境请显式使用 --yes"）；否则要求输入 `UNINSTALL`；`--all` 时要求输入 **`DELETE ALL`**（不同确认词！）。输入不符 → 报错且**不修改任何服务或文件**。
2. **依赖/配置前置**（:1085-1096）：docker 可用、daemon 可连、compose v2 可用、`.env.prod` 与 compose 文件存在——**任一缺失即拒绝**。
3. **删除范围**（:1097-1111）：
   - 默认：`down --remove-orphans --rmi local`（**保留**数据卷、`.env.prod`、备份、部署目录）
   - `--all`：`down --remove-orphans --rmi all --volumes`（**删除**数据卷）
   - `INCLUDE_ALL_PROFILES=1`：卸载须覆盖所有 profile（judge/monitoring），**不得**漏删。
4. **工作区保护**（#513/既有约束）：**拒绝在 Git/jj 工作区内执行 `--all`**（对照 `production.sh:167-183` 的 `validate_install_directory` 与 `remove_install_directory` 的 Git 检测），错误须可操作。
5. **软链清理**：卸载后清理指向本安装目录的 PATH 命令。

- [ ] **Step 1: 写失败测试**

- 确认词：`--yes` 通过；无 TTY 无 `--yes` → 报错（且零调用）；`UNINSTALL` 通过；`--all` 要求 `DELETE ALL`（输入 `UNINSTALL` **不**通过）；错误输入 → 零副作用。
- 默认卸载参数**不含** `--volumes`，`--all` **含** `--volumes` 与 `--rmi all`；默认用 `--rmi local`。
- **所有 profile 覆盖**：断言卸载参数包含 enabling judge/monitoring 的 profile 旗标（或等价的 `INCLUDE_ALL_PROFILES` 语义），**不得**遗漏。
- 前置缺失（无 `.env.prod` / 无 compose / docker 不可用）→ 明确报错，零 `down` 调用。
- **Git/jj 工作区保护**：模拟工作区标记存在 → `--all` 被拒且**不执行 down**。
- 软链清理：指向本目录的软链被移除；指向他处的**不被**误删。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现** — 全部经注入 runner/IO；确认词读取经注入接口（便于测试）。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 迁移生产 uninstall（确认词、数据卷安全与工作区保护）`

**明确不做**：不删 bash（T24）；不实现 update（T16）与备份；不改 T10 契约。

---

## Task 16: update / upgrade（版本解析 + 备份 + 文件同步 + 健康检查）

**Files:**
- Modify: `noj-cli/src/prod/lifecycle.ts`、`prod/lifecycle/steps.ts`、`prod/lifecycle_test.ts`、`src/mod.ts`
- 可能 Modify：`noj-cli/src/prod/compose.ts`（新增 `composePull`，T12/T13 已登记的 carry-forward）
- 可能 Modify：`noj-cli/src/runtime/download.ts`（若 `resolveLatestVersion` 需扩展资产过滤）

**Consumes**：T10 compose 封装；T9 `downloadReleaseFiles`（`overwrite:true`）；T12 `install()`；T13 `waitForStack`；T11 口令与校验

**对照 bash（R3）**：`production.sh` `update()`:345-436、`latest_release_version()`:255-323、`validate_release_tag()`:249-254、`write_config_version()`:324-344、`run_files_sync()`:201-217；`deploy.sh` `upgrade()`:1034-1044。

**必须实现的行为**
1. **两种模式**：
   - 无 `--latest`：按 `.env.prod` 的 `NOJ_VERSION` 升级；**先同步部署文件**（`--files-only` 语义）再 upgrade。
   - `--latest`：查询最新**资产就绪**的稳定 Release；等于当前版本则 **no-op**（不重启、不建备份）。
2. **版本解析**：**不得**用 `/releases/latest`；按 Release 列表过滤 draft / prerelease / 资产就绪（issue #431）；标签须过 release-tag 正则校验（见 bash `:761`）。
3. **升级序列**：`prepare_and_check` → `ensure_backup_passphrase` → **备份** → `compose pull` → `wait_for_stack` → `record_deployment_metadata`。
4. **配置版本落盘**：`write_config_version` 语义（仅改 `NOJ_VERSION`，保留注释/其它键/顺序，原子写）。
5. **文件同步**：`--files-only` 语义 = 以 `overwrite:true` 重新拉取 compose/example 资产并保留 `.env.prod`。
6. `upgrade` 仍是 `update` 的别名。

- [x] **Step 1: 写失败测试**

- 版本解析：fake Release 列表 → draft/prerelease 被排除、缺资产被排除、选中最新合规 tag；无合规版本 → 报错。
- 标签校验：非法 tag 被拒；`v0.1.0`/`0.1.0` 通过。
- **no-op**：`--latest` 且最新 == 当前 → 返回 0 且**零 compose 调用、零备份**。
- **升级序列顺序**：断言 备份 → pull → wait → metadata 的调用次序（索引比较）。
- **文件同步**：断言资产以 `overwrite:true` 重新拉取，且 `.env.prod` 内容不被改动。
- **write_config_version**：仅替换 `NOJ_VERSION`，保留注释/其它键/顺序。
- `upgrade` 与 `update` 行为一致（别名）。

- [x] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [x] **Step 3: 实现**

- 建议把 `composePull` 加入 `prod/compose.ts`（T12/T13 登记的 carry-forward），在 `update` 中复用。
- 若 `runtime/download.ts` 的 `resolveLatestVersion` 只按 CLI 资产过滤（T9 已指出），**扩展资产集合**以含 compose/example，或在 `prod/` 内实现等价过滤——**二择一并说明理由**。

- [x] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [x] **Step 5: 提交** — `feat(cli): 迁移 update/upgrade（版本解析、备份、文件同步与健康检查）`

**明确不做**：不删 bash（T24）；不实现备份内部设计（T17–T19）；不改 T10 契约（除新增 `composePull`）。

---

## Task 17: `.nojbackup` 单文件容器 + prod-raw payload driver

**Files:**
- Create: `noj-cli/src/prod/backup/container.ts` — 单文件容器格式（manifest / 打包 / 加密 / 解包）
- Create: `noj-cli/src/prod/backup/driver.ts` — prod-raw payload driver（**文件重定向**采二进制）
- Create: `noj-cli/src/prod/backup/container_test.ts`、`driver_test.ts`
- Modify: `noj-cli/src/prod/release.ts`（若需复用版本读取）—— 预期不改
- Modify: `noj-cli/src/mod.ts`

**Consumes**：`runtime/command.ts` 的 `CommandRunner`（`run` 的 `stdin` 与 `spawn` 的
`stdoutFile`/`stderrFile`）；`core/env-file.ts`；`prod/config.ts` 的
`backupPassphrasePath`/`ensureBackupPassphrase`/`passphraseFileMode`；`util/hash.ts`

**对照 bash（R3）**：`backup.sh` `create_snapshot()`:224-294、
`gpg_encrypt/decrypt()`:133-148、`write_checksums()`:187-195、
`record_migration_status()`:172-185、`prepare_idempotent_globals()`:150-170、
`validate_snapshot_path()`:296-300。

**Spec（`2026-09-19-noj-cli-production-unification-design.md` §3.1）**：容器形态
**唯一**，`payload_layout` 恒为 `"prod-raw"`（无历史兼容 = 无需分派）：

```text
snapshot-<ts>.nojbackup
└─ gpg(AES256, <passphrase>)         ← **整包**加密（不是只加密 env）
   └─ tar.zst
      ├─ manifest.json               schema_version / payload_layout / created_at / sha256
      ├─ postgres.dump               pg_dump -Fc **原始二进制**
      ├─ postgres-globals.sql
      ├─ redis.rdb                   redis-cli --rdb **原始二进制**
      ├─ minio/…
      ├─ env.prod.gpg
      ├─ migration-status.txt
      ├─ sha256sums.txt
      └─ SUCCESS
```

**必须实现的行为**

1. **整包加密**：`gpg --symmetric --cipher-algo AES256` 作用于 `tar.zst`（不是逐个
   文件）。口令路径经注入点给出（生产由 T11 `backupPassphrasePath` 决定）。
2. **文件重定向采二进制（本任务最高风险项）**：`postgres.dump` 与 `redis.rdb` 必须
   经 `docker compose exec -T … > <file>` 采集——`backup_driver.ts:114` 的既有注释
   写明：数据经 **stdout 字符串**传输会**静默损坏**二进制。因此实现须走
   `SpawnOpts.stdoutFile`（内核级重定向到文件），**不得**走 `run()` 的字符串捕获；
   `pg_restore --list < postgres.dump` 的结构校验同理（stdin 从**文件**喂入）。
   测试须对"未经字符串传输"有可断言证据（见 Step 1）。
3. **`pg_restore --list` 可解析**：`postgres.dump` 落盘后必须能被 `pg_restore --list`
   解析（spec R7 验收项）。这是二进制静默损坏的**唯一**可检测信号，必须进 `create`
   的成功路径（bash `:250-252` 同样在 create 内跑）。
4. **checksums 与哨兵**：`sha256sums.txt` 覆盖 staging 内**全部**文件（除自身），
   两空格分隔、`LC_ALL=C sort` 排序（与 bash 的 `write_checksums` 逐字一致的排序
   口径）；`SUCCESS` 内容为 `success`（bash 写 `'success\n'`）；权限 `go-rwx`。
5. **manifest**：`schema_version: 1`、`payload_layout: "prod-raw"`、`created_at`（UTC
   `%Y-%m-%dT%H:%M:%SZ`）与 `files` 清单；另含 bash 的说明性字段
   （`postgres_database`/`redis_policy`/`object_storage`/`postgres_backup_mode`/
   `incremental_policy`/`rpo`/`rto`/`retention_days`）。
   **manifest 内不放整包摘要**（实现时修正）：manifest 在容器内部，记录自己所在
   文件的摘要是不可能的（无限回归），故单轮打包即可；整包摘要落在**同级 sidecar**
   `<容器名>.sha256`（`CHECKSUM_SUFFIX`），格式与 Release 资产校验文件一致。
6. **原子落盘**：staging 目录 → 打包 → 加密到 `<backup-dir>/snapshot-<ts>.nojbackup`
   的**临时名** → `rename` 提交；任一步失败清理临时产物与 staging（`finally`），
   绝不留下半成品 `.nojbackup`。
7. **`--no-encrypt`**：仍产出单文件（`.nojbackup` 内含未加密 tar.zst），manifest 的
   `encrypted: false` 如实记录。缺口令且未 `--no-encrypt` → 明确报错（bash :227）。

- [x] **Step 1: 写失败测试**

- **二进制完整性（最高价值）**：注入 fake runner，令其"经 stdoutFile 写出"一段
  **含 `\x00` 的字节**，断言落盘文件**逐字节等于**该字节序列；同时断言该次采集
  **未经** `run()` 的字符串路径（例如 fake 的 `run` 一旦被用于采集 dump 即抛错）。
  反向用例：若改用字符串路径（模拟 base64/UTF-8 往返），`\x00` 与高位字节被破坏，
  断言 `sha256sums` 校验**必须失败**——锁住"静默损坏不可接受"。
- **`pg_restore --list` 可解析**：注入的 fake 对 `pg_restore --list` 返回非 0 时，
  `create` 必须失败且**不产出** `.nojbackup`（零残留）。
- **整包加密**：断言 `gpg --symmetric --cipher-algo AES256` 的输入是 **tar.zst**
  整体（而非逐文件），且最终产物是单个 `.nojbackup`。
- **manifest 字段**：`payload_layout == "prod-raw"`、`schema_version == 1`、
  `files` 含 manifest 自身、`encrypted` 随 `--no-encrypt` 变化；**同级 sidecar**
  `.sha256` 的摘要等于容器文件的摘要（且 `sha256sum -c` 可用）。
- **checksums 覆盖**：`sha256sums.txt` 含除自身外的每个文件，排序为 `LC_ALL=C`。
- **原子性**：加密失败 / 打包失败 → 备份目录内**零** `.nojbackup` 残留、无 staging
  残留（`finally` 生效）。
- **缺口令**：无口令且未 `--no-encrypt` → 明确报错且零产物。

- [x] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [x] **Step 3: 实现**

- `container.ts`：纯格式层（manifest 形状与序列化、checksums 生成与解析、打包/加密/
  解包的编排），**一切外部命令经注入的 driver**，不直接 spawn。
- `driver.ts`：prod-raw driver——`captureToFile(cmd, args, destFile)` 走
  `CommandRunner.spawn({ stdoutFile, stderrFile })`（**内核级重定向**），
  `feedFile(cmd, args, srcFile)` 走 stdin 重定向；两者都返回退出码且**不把内容读进
  内存字符串**。`pgDump`/`pgDumpAll`/`pgRestoreList`/`redisRdb`/`minioMirror`/
  `gpgEncrypt`/`gpgDecrypt`/`tarZst`/`untarZst` 建立在其上。
- 复用既有 `util/hash.ts:fileSha256Hex`（流式摘要，不整读进内存）。

- [x] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [x] **Step 5: 提交** — `feat(cli): .nojbackup 单文件容器与 prod-raw 驱动（文件重定向采二进制）`

**明确不做**：不实现 verify/list/prune/restore 命令面（T18）；不实现 drill（T19）；
不删 bash（T24）；不改 `maintain/` 既有 JSON 模式备份（T23 才收敛）。

---

## Task 18: verify / list / prune / restore --dry-run（命令面收口）

**Files:**
- Modify: `noj-cli/src/prod/backup/container.ts`（加 `unpackContainer`：解包 + 校验）
- Create: `noj-cli/src/prod/backup/commands.ts` — verify / list / prune / restore 的编排
- Create: `noj-cli/src/prod/backup/commands_test.ts`
- Modify: `noj-cli/src/mod.ts`

**Consumes**：T17 的 `createContainer` 与 `RawDriver`；`maintain/backup_index.ts` 的
`listBackups`/`planPrune`（**纯逻辑，复用不重写**）；`core/env-file.ts`

**对照 bash（R3）**：`backup.sh` `verify_snapshot()`:302-334、
`validate_snapshot_path()`:296-300、`prune_old_snapshots()`:196-205。

**Spec（R7 验收）**：三档 verify；`prune` **默认 dry-run**；`restore --dry-run`
**无副作用**；这些命令**都不得创建备份**（实测过的误路由缺陷：prod profile 的
`list`/`prune` 曾走到 JSON 模态的创建路径）。

**必须实现的行为**

1. **三档 verify**（名字即保证强度，逐档累加）：
   - **默认（文件完整性，秒级）**：解包 → `manifest.json` 存在且
     `payload_layout == "prod-raw"` → `SUCCESS` 哨兵 → `sha256sums.txt`
     **逐文件**校验；
   - **`--deep`（结构可解析，十秒级）**：在默认之上加——`postgres.restore-list`
     非空（即 create 时的 `pg_restore --list` 产物存在）、`redis.rdb` 非空且
     首字节为 `REDIS`、`minio/` 目录存在、`env.prod.gpg` 能被口令**成功解密**
     且结果非空；
   - **`--payload-sha`**：额外复算**容器文件**的 SHA-256 并与**同级 sidecar**
     `<容器>.sha256` 比对（检出介质损坏 / 拷贝截断 / 误改）。三档可叠加，任一失败
     即退出码 1。
     **为什么不是 manifest 内的摘要**（实现时修正）：manifest 位于容器**内部**，
     无法记录自己所在文件的摘要（"写摘要 → 摘要变 → 再写"是无限回归）。
     因此整体摘要落在同级 sidecar，格式与仓库既有 Release 资产校验文件一致
     （可直接 `sha256sum -c`）。**安全边界须诚实**：sidecar 只防意外损坏，
     不防蓄意篡改（能改容器的人也能改同级 sidecar）；对称口令体系下"持有口令者
     可重写一切"，防篡改需要非对称签名，不在本任务范围。
2. **`prune` 默认 dry-run**：不 `--confirm` 时只输出**计划**，零删除、零副作用；
   `--confirm` 才落地。默认**不删 legacy 目录**（存量数据）——复用
   `maintain/backup_index.ts:planPrune` 的既有语义，不重写判定。
3. **`restore --dry-run` 无副作用**：完整走"解包 → 校验 → 规划恢复步骤"，但
   **不碰** docker、不写目标数据、不改 `.env.prod`；输出将执行的步骤清单。
   非 dry-run 的 restore 本任务**不实现**（归 T19 的 drill 之后的独立任务；
   任务书的验收只要求 dry-run 无副作用）。
4. **这些命令都不创建备份**：以测试断言"备份目录在命令前后逐项不变"
   （目录 mtime/文件清单/内容摘要），锁死误路由回归。
5. **口令缺失的报错**：verify 的解密档与 `--deep` 需要口令；缺口令时
   **只跳过需要口令的检查并显式报告**（不静默通过、也不误报失败）。

- [ ] **Step 1: 写失败测试**

- **三档累加**：同一份容器，默认档通过 → `--deep` 通过 → `--payload-sha` 通过；
  逐档注入缺陷（篡改 payload 内的 `redis.rdb` 字节 / 删 `minio/` / 让
  `manifest.sha256` 不匹配）并断言**恰好触发对应档**的失败（默认档不得漏报
  结构问题，`--deep` 不得重复默认档的判定）。
- **篡改检出**：改 `postgres.dump` 一个字节 → `sha256sums` 校验必须失败。
- **`payload_layout` 防线**：`payload_layout` 非 `prod-raw` → 明确拒绝（无分派）。
- **prune 默认 dry-run**：无 `--confirm` 时断言零删除、零副作用（文件清单不变）；
  `--confirm` 才删；legacy 默认保留。
- **restore --dry-run 无副作用**：注入会**抛错**的 runner（一旦调用即失败）→
  命令仍成功并输出步骤清单，证明未触 docker。
- **不创建备份**：三个命令前后，备份目录的文件清单与各自摘要**逐项不变**。
- **口令**：缺口令时 verify 默认档仍应通过（无需解密），`--deep` 明确报告
  "已跳过环境文件解密"而不是静默通过。

- [ ] **Step 2: 运行确认失败** — `cd noj-cli && deno task test 2>&1 | tail -5`

- [ ] **Step 3: 实现**

- `container.ts` 加 `unpackContainer(path, opts)`：解密（或直读）→ 解包到临时目录 →
  返回 staging 路径与 manifest；调用方负责清理（`finally`）。**复用 T17 的
  `tempContainerPath`/`listFiles`/`parseChecksums`**，不重写。
- `commands.ts`：三个命令的编排与结果形状（`verify` 返回逐档的布尔与错误清单；
  `list`/`prune` 复用 `backup_index.ts` 的算法）。

- [ ] **Step 4: 运行确认通过** — `cd noj-cli && deno task check && deno task test`

- [ ] **Step 5: 提交** — `feat(cli): 备份 verify 三档 / list / prune 默认 dry-run / restore --dry-run`

**明确不做**：不实现真实 restore（写目标数据）；不实现 drill（T19）；不改 T17 的
容器格式；不删 bash（T24）。

---

## Task 19–26（概要；执行前逐个展开为完整任务块）
| Task | 文件 | 验收要点 |
| --- | --- | --- |
| T17 .nojbackup 容器 | `backup/container.ts`、`driver.ts` | 单文件 + 整包加密；**文件重定向采二进制**；`pg_restore --list` 可解析 |
| T18 verify/list/prune/dry-run | `backup/commands.ts` | 三档 verify；prune 默认 dry-run；restore --dry-run 无副作用；**不创建备份** |
| T19 drill | `backup/drill.ts` | 隔离项目/子网/不映射端口；RPO/RTO 超限=1；资源缺失=2；失败也清理 |
| T20 schedule | `schedule.ts` | crontab 标记区块幂等 |
| T21 judge | `judge/` | 覆盖 `judge-install.sh`；不碰宿主 docker daemon |
| T22 problem init | `problem/tui.ts` | 交互引导 + 非 TTY 明确行为 |
| T23 删双模态 | 全仓 | 删 `noj-deploy.json` 路径、`deploy`/`maintain`/`stack`/`run-server`、`devTemplate`/`renderCompose`；`rg` 残留为空 |
| T24 删 bash + 闸门 | `scripts/deploy/` | 删内驱脚本/根 `noj`；`deploy.sh`/`restore-drill.sh` 加 y 确认 |
| T25 文档 | `noj-docs/`、`AGENTS.md`、CHANGELOG | #510 治理；两段式开发流程；CLI 文档重写 |
| T26 证据 | `dev-docs/unattended/` | 验收证据 + 进度日志 + 待人工 review |

---

## Self-Review 结果

- **Spec 覆盖**：R1→T1/T23/T24；R2→T24；R3→每个 T 的对照表；R4→T9；R5→T1/T7/T8；R6→T22；R7→T17/T18/T19；R8→全；M1→T4；M2→T2/T3；M3→T10；M4→T10；M5→T7/T23；M6→T23；M7→T23。
- **占位符**：T7–T26 为概要形式（非 "TBD"，而是明确文件 + 验收要点）；执行时按 T1–T6 的同一 5 步结构展开。**这是有意的**：26 个任务的完整代码会超出单份文档的可读上限，且 T1–T6 已给出可直接照抄的模板。
- **类型一致**：`EnvKeySpec`/`transition`/`emitJson` 在 T2/T4/T6 定义，T7+ 消费，命名一致。
