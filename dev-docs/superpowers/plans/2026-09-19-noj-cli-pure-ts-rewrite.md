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

## Task 7–26（概要；每个 Task 执行时按同一 5 步 TDD 循环展开）

| Task | 文件 | 验收要点 |
| --- | --- | --- |
| T7 Cliffy 命令树 | `cli.ts` 重写 | 命令树即 help 单一事实源；防漂移门禁：help 声明集合 == 实际可处理集合 |
| T8 渲染与主题 | `output/theme.ts`、`render.ts` | token 语义色；`NO_COLOR`/`LOG_COLOR`/`--color` 契约回归；表格与窄终端 |
| T9 bootstrap | `prod/bootstrap.ts` | 下载 compose/example + SHA-256 校验；失败拒绝写入 |
| T10 compose | `prod/compose.ts` | 服务集与 `docker-compose.prod.yml` 逐服务核对无遗漏 |
| T11 config/向导 | `prod/config.ts` | 19 键校验；交互向导；口令自动生成 600；cosign；宝塔检测 |
| T12 install | `prod/lifecycle.ts` | 空目录仅凭二进制可完成；PATH 注册 |
| T13 start/stop/restart/status | 同上 | 状态机 no-op 判定；退出码 |
| T14 logs | 同上 | 着色契约；`--follow` |
| T15 uninstall | 同上 | 确认词；`--all`；拒绝 Git/jj 工作区 |
| T16 update | 同上 | 版本解析（资产就绪过滤）；备份；健康检查 |
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
