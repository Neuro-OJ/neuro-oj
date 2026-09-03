# noj-core 配置分层语义治理实施计划

> **给 agentic worker:** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 为 noj-core 配置建立"生命周期两分法"语义（runtime=DB-owned 可热改 / bootstrap=env-owned 只读），统一配置注册表消除多份手写副本，后台配置页全元数据驱动，check-env 与注册表对齐。

**架构：** 在现有 `settings-registry.ts` 上把 `SETTING_DEFINITIONS` 与 `ENV_ONLY_DEFINITIONS` 合并为单一 `CONFIG_DEFINITIONS` 注册表，每项声明 `scope: "runtime" | "bootstrap"`。`getSetting()` 按 scope 分支：runtime 走 `DB Map → env 兜底 → default`，bootstrap 走 `env 快照 → default`（不读 DB）。管理 API/UI 由注册表元数据驱动，删除前端硬编码键白名单。check-env 读取注册表校验 `.env.example` 键覆盖。

**技术栈：** Deno 2（noj-core）、Hono、Nuxt 4 / Vue 3（noj-ui）、Drizzle ORM、PGlite 测试。

**Spec:** `dev-docs/superpowers/specs/2026-09-02-config-layering-semantics-design.md`

## 全局约束

- 提交信息：`<type>(<scope>): <中文描述>`（scope: core/ui/root），GPG 签名强制；
- Deno 代码：`deno fmt` + `deno lint`（CI 强制），中文注释 + 英文标识符；
- 测试必须通过 `deno task` 运行（`test:parallel` 优先 / `test` / `test:smoke`）；
- 搜索必须用 `rg`（ripgrep），不用 `grep`；
- 禁止手动修改 `deno.lock`；
- 非平凡变更需在 `.agents/notes/implemented/` 新增 Agent Note（格式见 AGENTS.md §9.3，`deno run -A scripts/verify-agent-note-format.ts` 校验）；
- 版本控制：仓库本地工作流使用 jj（Jujutsu，见 AGENTS.md §7.1/7.2），任务内 `git commit` 步骤可按团队惯例等价替换为 `jj describe` + `jj git push`（若当前环境实际使用 git 则按 git）；提交信息须符合 Conventional Commits 且 GPG 签名；禁止直接推 `main`，日常开发在 `dev` 分支或功能分支。
- 划归项：storage(7) + email(9) + audit_log_retention_days(1) = **17 项** bootstrap；其余 **49 项** runtime；
- **不迁移 DB 存量数据**（bootstrap 项忽略 DB 旧值，仅日志/徽标提示 + 一键清理）；
- 不自动生成 .env.example（保留手写注释，只做一致性校验）；
- 前端分组/来源/描述全部由 API 元数据驱动，删除硬编码键白名单与分类表。

---

### Task 1: 注册表扩展——scope 字段与 envKey，合并 env-only 定义

**Files:**
- Modify: `noj-core/src/lib/settings-registry.ts`（全文改造）
- Modify: `noj-core/src/lib/env-snapshot.ts`（删除重复定义，改为消费注册表）
- Test: `noj-core/tests/services/system-settings.test.ts`（新增用例）

**Interfaces:**
- Consumes: 现有 `SettingCategory` 联合类型
- Produces:
  - `type ConfigScope = "runtime" | "bootstrap"`
  - `interface ConfigDefinition { key; type; default?; description; is_secret; category; scope; envKey?; min?; max?; visible? }`（`envKey` 为 env 事实源键名，仅 bootstrap 用；runtime 用既有 `envFallback`）
  - `CONFIG_DEFINITIONS: readonly ConfigDefinition[]`（合并两表，含 17 项 bootstrap 划归 + 原 13 项 env-only + 新登记 infra）
  - `findDefinition(key)`（保留，遍历 CONFIG_DEFINITIONS）
  - `validateRegistry()`（扩展 scope 完整性 + env 键唯一性校验）
  - `isBootstrap(key)`, `isRuntime(key)`, `isVisible(key)` 辅助

**步骤：**

- [ ] **Step 1: 写失败测试**

在 `noj-core/tests/services/system-settings.test.ts` 新增（置于文件中部逻辑分组处）：

```ts
Deno.test({
  name: "system-settings service: 注册表 scope 声明完整（runtime/bootstrap 不重叠）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    validateRegistry(); // 不应抛错
    // 划归项 scope=bootstrap
    for (const k of [
      "storage_provider", "s3_endpoint", "s3_secret_key",
      "email_provider", "alibaba_access_key_secret",
      "audit_log_retention_days",
    ]) {
      assertEquals(findDefinition(k)?.scope, "bootstrap");
    }
    // 保留 runtime 项 scope=runtime
    for (const k of [
      "allow_register", "rate_limit_login_ip_max",
      "maintenance_mode", "homepage_banner",
    ]) {
      assertEquals(findDefinition(k)?.scope, "runtime");
    }
  },
});
```

需要 `findDefinition` import（现文件仅 `validateRegistry`）。运行确认失败（`findDefinition(...).scope` 为 undefined → 不等）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test tests/services/system-settings.test.ts`（注意：应直接 `deno task test:smoke` 不可行——需单文件，用 `deno task test -- tests/...` 语法，或经 `test` 任务跑全量确认新用例失败）
Expected: FAIL——`findDefinition` 无 `scope` 属性或为 undefined。

- [ ] **Step 3: 改造 `settings-registry.ts`**

在文件顶部类型区加入 scope 语义与合并结构。保留 `SettingType`、`SettingCategory`（增补 infra 所需分类，若需要）、`SettingDefinition` 形态兼容性。具体：
1. 定义 `type ConfigScope = "runtime" | "bootstrap"`;
2. `SettingDefinition` 增加 `scope: ConfigScope`、`visible?: boolean`、`envKey?: string`（仅 bootstrap）、保留 `envFallback`（仅 runtime，语义=首次兜底）;
3. 新建 `CONFIG_DEFINITIONS`：合并三类条目：
   - 原 66 项 SETTING_DEFINITIONS：其中 **17 项改 scope=bootstrap 并赋 `envKey`**（storage/email/audit_log_retention_days，envKey=原 envFallback 键名，如 `storage_provider`→`STORAGE_PROVIDER`、`s3_secret_key`→`S3_SECRET_KEY`、`email_provider`→`EMAIL_PROVIDER`、`audit_log_retention_days`→`AUDIT_LOG_RETENTION_DAYS`）；其余 49 项 scope=runtime、保留 envFallback；
   - 原 `ENV_ONLY_DEFINITIONS` 13 项（DATABASE_URL、REDIS_URL、JWT_SECRET、ADMIN_EMAIL、ADMIN_PASS、BCRYPT_SALT_ROUNDS、CORS_ALLOWED_ORIGINS、PORT、NOJ_ENV、DATABASE_POOL_MAX/CONNECT_TIMEOUT/IDLE_TIMEOUT/MAX_LIFETIME）以 scope=bootstrap + envKey=key 并入；
   - **新登记 infra env（~30 项）**：TFA_ENCRYPTION_KEY、APP_URL、LOG_LEVEL、LOG_FORMAT、RESULT_CONSUMER_CONCURRENCY、SUPPORT_PACKAGE_DIR、JUDGE_IMAGE_BASE、NOJ_ARTIFACT_MAX_SIZE_MB、NOJ_ALLOW_INSECURE_HTTP、NOJ_FORCE_PASSWORD_CHANGE、OAUTH_GITHUB_CLIENT_ID/SECRET、OAUTH_OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET/NAME、NOJ_LLM_SERVICE_TOKEN、NOJ_LLM_GATEWAY_URL、NOJ_LLM_MAX_CALLS、NOJ_LLM_MAX_TOKENS 等（见 spec §3.3，仅登记展示、不改读取路径）；开发/测试专用（NOJ_RUN_E2E、TEST_SCHEMA、NOJ_MIGRATIONS_DIR、NOJ_BYPASS_JWT_REVOKE）标记 `visible: false`。
4. `validateRegistry()` 扩展校验：
   - scope ∈ {"runtime","bootstrap"}；
   - bootstrap 必须声明 `envKey`，runtime 必须声明 `envFallback`（或无兜底的显式标记，倾向每个 runtime 项都有 envFallback——按 spec §7）；
   - **env 键唯一性**：遍历所有 `envKey`/`envFallback` 收集集合，重复即抛错；
   - `visible !== false` 时 bootstrap 需有描述。
5. `findDefinition()` 改为遍历 `CONFIG_DEFINITIONS`；
6. 保留对旧名 `SETTING_DEFINITIONS` / `ENV_ONLY_DEFINITIONS` 的导出兼容（或同步更新 import——见 Step 4/5，倾向删除旧导出并更新引用方，避免双真源）。

> 原 13 项 env-only 属"无 default"，`ConfigDefinition` 的 `default?` 可选；`type` 对 env-only 项原本恒为 string，现可按真实类型登记（DATABASE_POOL_MAX=integer 等）。

- [ ] **Step 4: 更新 `env-snapshot.ts` 消费注册表**

将 `ENV_ONLY_DEFINITIONS` 数组删除或改为从 `CONFIG_DEFINITIONS` 派生：
```ts
import { CONFIG_DEFINITIONS } from "./settings-registry.ts";
// 快照白名单 = 所有 scope=bootstrap 的 envKey
export function getBootstrapEnvKeys(): string[] {
  return CONFIG_DEFINITIONS.filter((d) => d.scope === "bootstrap")
    .map((d) => d.envKey!);
}
```
`snapshotEnv()` 改为遍历 `getBootstrapEnvKeys()`；`getEnvSnapshotValue`、`_resetEnvSnapshotForTest` 保留。若保留 `ENV_ONLY_DEFINITIONS` 导出则改为派生别名。

- [ ] **Step 5: 运行测试确认通过 + fmt/lint**

Run: `cd noj-core && deno task fmt && deno task lint`；`deno task test`（或 `test:parallel`）
Expected: PASS——既有用例（allow_register/smtp_from/rate_limit）仍通过，新增 scope 用例通过。若编译期报旧引用（如 `ENV_ONLY_DEFINITIONS` 在别处 import），同步更新那些 import 指向新注册表辅助函数。

- [ ] **Step 6: Commit**

```bash
cd noj-core && git add src/lib/settings-registry.ts src/lib/env-snapshot.ts tests/services/system-settings.test.ts
git commit -F - <<'EOF'
feat(core): 合并统一配置注册表，引入 scope(runtime/bootstrap) 语义 (#issue)

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 2: 读取层语义——getSetting 按 scope 分支，bootstrap 忽略 DB

**Files:**
- Modify: `noj-core/src/domains/system/services/system-settings.ts`
- Test: `noj-core/tests/services/system-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `findDefinition`、`CONFIG_DEFINITIONS`（含 scope/envKey）、`getBootstrapEnvKeys()`、`isBootstrap()`
- Produces:
  - `getSetting(key)` 返回 `SettingValue | null`（不变签名；bootstrap 项返回 `source:"env"` 或 `"default"`，绝不 `"db"`）
  - `listSettings()` 返回 `SystemSettingListItem[]`（现含 `scope` 字段、`effective_value` 掩码逻辑统一到通用注册表）
  - `initSystemSettings()` 加载 DB 时**跳过 bootstrap 键**（不缓存到 Map）
  - `listOrphanedBootstrapRows()` / `cleanupBootstrapRow(key)`：供日志与后台清理

**步骤：**

- [ ] **Step 1: 写失败测试**

```ts
Deno.test({
  name: "system-settings service: bootstrap 项忽略 DB 旧值（source 非 db）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    // 直接向 DB 插入 bootstrap 键旧值（绕过 updateSetting 的注册表 type 校验）
    const db = getDb();
    await db.insert(systemSettings).values({
      key: "storage_provider", value: JSON.stringify("local"),
      description: "", is_secret: false,
      updated_at: new Date().toISOString(), updated_by: "0",
    });
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const got = getSetting("storage_provider");
    // 忽略 DB，回退 env/default（此处 env 未设 → default）
    assertEquals(got?.source !== "db", true);
  },
});

Deno.test({
  name: "system-settings service: runtime 项仍 DB 优先",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    await updateSetting("allow_register", false, "0");
    const got = getSetting("allow_register");
    assertEquals(got?.source, "db");
  },
});
```

- [ ] **Step 2: 运行确认失败**

Expected: 第一个用例 FAIL（当前 DB 有值即返回 db source）。

- [ ] **Step 3: 实现 getSetting/init 分支**

在 `system-settings.ts`：
1. `initSystemSettings()`：SELECT 全表后，仅 `!isBootstrap(row.key)` 的行走入 Map（bootstrap 键跳过，不缓存）；
2. `getSetting(key)`：
   - 查 `def = findDefinition(key)`；
   - 若 `def?.scope === "bootstrap"`：**跳过 DB Map**，直接走 env 快照（`def.envKey`）+ default 兜底，返回 `source: "env" | "default"`；
   - 若 runtime（或无 def 的旧 env-only 兼容）：维持现有 DB→env→default 链；
   - 非注册表 key 分支保留（env 直读）。
3. `listSettings()` 统一为遍历 `CONFIG_DEFINITIONS`（可见项），按 scope 分支取值与脱敏；`SystemSettingListItem` 增加 `scope` 字段与（bootstrap 残留提示用）`db_orphaned?: boolean`。通用化掩码：URL 凭据（DATABASE_URL/REDIS_URL）strip、JWT_SECRET hash、其余 is_secret mask——逻辑不变但键集改为查注册表 `is_secret`，URL 集可保留常量。
4. 新增：
   - `listOrphanedBootstrapRows(): Promise<{key, updated_at, updated_by}[]>`：SELECT system_settings WHERE key IN (bootstrap keys)；
   - `cleanupBootstrapRow(key, actorId): Promise<void>`：仅接受 bootstrap 键，DELETE + 审计 `settings.reset`（复用 resetSetting 的审计形态）。
5. `updateSetting`/`resetSetting` 增加 guard：**拒绝写 bootstrap 键**（抛 ValidationError，如"该配置由环境变量管理，请修改 .env 后重启"）。这保证后台不可改。

- [ ] **Step 4: 运行测试确认通过 + fmt/lint**

Run: `cd noj-core && deno task fmt && deno task lint && deno task test`（或 test:parallel）
Expected: PASS 新旧用例。若既有用例（如 `listSettings 包含所有 DB-backed 项` 断言 `email_provider/storage_provider` 存在）依赖划归项仍在列表，检查新 listSettings 仍返回全部可见项（scope 不隐藏，只改 source 语义），应仍通过。

- [ ] **Step 5: Commit**

```bash
cd noj-core && git add src/domains/system/services/system-settings.ts tests/services/system-settings.test.ts
git commit -F - <<'EOF'
feat(core): getSetting 按 scope 分支，bootstrap 配置忽略 DB 旧值

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 3: 启动日志与一键清理端点

**Files:**
- Modify: `noj-core/src/main.ts`
- Modify: `noj-core/src/domains/system/routes/admin-settings.ts`
- Modify: `noj-core/src/domains/system/services/system-settings.ts`（若 Task 2 未含 cleanup 则补）
- Test: `noj-core/tests/routes/admin-settings.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listOrphanedBootstrapRows()`、`cleanupBootstrapRow(key, actorId)`
- Produces:
  - 启动日志：`main.ts` 在 `snapshotEnv()` 后调用 `listOrphanedBootstrapRows()`，非空时 `logger.warn("以下配置项已由环境变量接管，DB 旧值不再生效…", { keys })`；
  - `DELETE /api/v1/admin/settings/:key` 扩展为也接受 bootstrap 键（清理残留行）；`PUT` 保持拒绝。

**步骤：**

- [ ] **Step 1: 写失败测试**

在 `admin-settings.test.ts` 新增：

```ts
Deno.test({
  name: "admin-settings route: PUT bootstrap 键拒绝 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app, "/api/v1/admin/settings/storage_provider",
      { method: "PUT", body: { value: "s3" }, token },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "admin-settings route: DELETE bootstrap 键清理残留 DB 行 204",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const db = getDb();
    await db.insert(systemSettings).values({
      key: "email_provider", value: JSON.stringify("mock"),
      description: "", is_secret: false,
      updated_at: new Date().toISOString(), updated_by: "0",
    });
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app, "/api/v1/admin/settings/email_provider",
      { method: "DELETE", token },
    );
    assertEquals(res.status, 204);
    // DB 行已清理
    const rows = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "email_provider"));
    assertEquals(rows.length, 0);
  },
});
```

需在测试顶部 import `getDb`、`systemSettings`、`eq`。

- [ ] **Step 2: 运行确认失败**

Expected: PUT storage_provider 当前返回 200（可写）→ FAIL；DELETE 残留当前 204 但不审计/语义不清（行为上可能通过，故重点断言 PUT 拒绝）。

- [ ] **Step 3: 实现**

1. `system-settings.ts`：`updateSetting` 开头若 `findDefinition(key)?.scope === "bootstrap"` 抛 ValidationError（文案："该配置由环境变量管理（bootstrap），请修改 .env 后重启 noj-core"）；`resetSetting` 允许 bootstrap 键（等价于清理残留行），其内部 `findDefinition` 限制改为"已注册即可"。
2. `admin-settings.ts`：路由 docstring 更新；PUT 依赖 service 抛错即 400（无需改路由逻辑）；DELETE 依赖 service 允许 bootstrap。
3. `main.ts`：在 `snapshotEnv()`（main.ts:146）之后加入：
```ts
const orphaned = await listOrphanedBootstrapRows();
if (orphaned.length > 0) {
  logger.warn(
    "以下配置项已由环境变量接管，DB 旧值不再生效，可到管理后台一键清理：",
    { keys: orphaned.map((r) => `${r.key}(更新于 ${r.updated_at} 由 ${r.updated_by})`) },
  );
}
```
（置于 try/catch 内，失败不阻断启动——仅 warn。）
从 `domains/system/index.ts` import 新函数。

- [ ] **Step 4: 运行测试确认通过 + fmt/lint**

Run: `cd noj-core && deno task fmt && deno task lint && deno task test`
Expected: PASS——PUT bootstrap 400，DELETE bootstrap 清理成功，既有 DELETE/GET 用例通过。

- [ ] **Step 5: Commit**

```bash
cd noj-core && git add src/main.ts src/domains/system/services/system-settings.ts src/domains/system/routes/admin-settings.ts tests/routes/admin-settings.test.ts
git commit -F - <<'EOF'
feat(core): bootstrap 配置拒绝后台写入，支持一键清理残留 DB 行与启动提示

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 4: 管理 API 元数据全量化——listSettings 输出 scope/分类/来源

**Files:**
- Modify: `noj-core/src/domains/system/services/system-settings.ts`
- Modify: `noj-core/src/domains/system/routes/admin-settings.ts`（docstring 同步）
- Test: `noj-core/tests/services/system-settings.test.ts`、`noj-core/tests/routes/admin-settings.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的注册表与 listSettings
- Produces:
  - `SystemSettingListItem` 含：`key/type/effective_value/raw_value/source/is_secret/description/updated_at/updated_by/category/scope/min/max/needsRestart/visible/db_orphaned`
  - GET /api/v1/admin/settings 返回全部可见项（runtime + bootstrap），不再有两段硬编码分界——前端据 `scope` 分组
  - `category` 标签与顺序：新增 `CATEGORY_ORDER`/`CATEGORY_LABEL` 导出（或由 UI 端保留展示文案，键/序来自 API）

**步骤：**

- [ ] **Step 1: 写失败测试**

在 `system-settings.test.ts` 新增：

```ts
Deno.test({
  name: "system-settings service: listSettings 返回 scope 字段与全部可见项",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await freshSetup();
    const items = await listSettings();
    const runtime = items.find((i) => i.key === "allow_register");
    assertEquals(runtime?.scope, "runtime");
    const boot = items.find((i) => i.key === "storage_provider");
    assertEquals(boot?.scope, "bootstrap");
    // 新登记 infra 可见（LOG_LEVEL 若未设 env 则不返回；此处断言已设 key 或结构存在性）
    assertEquals(items.some((i) => i.scope === "bootstrap"), true);
    assertEquals(items.some((i) => i.scope === "runtime"), true);
  },
});
```

> 注意：env-only 项仅当 env 实际设置才返回（现有语义）。新登记项在测试环境多为未设置→不出现；本测试只断言结构。

- [ ] **Step 2: 运行确认失败**

Expected: `scope` 字段 undefined → FAIL。

- [ ] **Step 3: 实现**

1. `SystemSettingListItem` 增加 `scope: ConfigScope`、`visible: boolean`、`db_orphaned?: boolean`（bootstrap 且 DB 有残留时 true）；
2. `listSettings()` 统一遍历 `CONFIG_DEFINITIONS`（`visible !== false`）：
   - runtime：`getSetting()`（DB→env→default），脱敏与现有一致；
   - bootstrap：读 env 快照（未设置则**跳过**还是展示为"未设置"？——按现有语义：仅展示已设置项；但为了"无盲区"，spec 倾向展示全部 bootstrap 项含"未设置"。**决策：bootstrap 项即使 env 未设置也返回**（值为 null/undefined → `effective_value: null`、`source:"default"`），让后台显示"未配置"。runtime 项维持恒有值（default 兜底））。
   - `db_orphaned`: 通过一次性 `listOrphanedBootstrapRows()` 结果集标记；
3. 更新 `admin-settings.ts` docstring（"返回全部配置项，scope 区分 runtime/bootstrap"）。

> 若"未设置也返回"破坏既有测试（如 env-only REDIS_URL 未设时不出现），按 spec §10"无配置盲区"优先，更新对应测试断言。

- [ ] **Step 4: 运行测试确认通过 + fmt/lint**

Run: `cd noj-core && deno task fmt && deno task lint && deno task test`
Expected: PASS。检查是否有 UI/其他服务依赖"env-only 未设置不返回"的行为（grep listSettings 消费方），如有则同步调整。

- [ ] **Step 5: Commit**

```bash
cd noj-core && git add src/domains/system/services/system-settings.ts src/domains/system/routes/admin-settings.ts tests/services/system-settings.test.ts tests/routes/admin-settings.test.ts
git commit -F - <<'EOF'
feat(core): 管理 API 返回完整注册表元数据（scope/visible/db_orphaned）

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 5: UI 设置页两段语义重写（元数据驱动）

**Files:**
- Modify: `noj-ui/pages/admin/settings.vue`
- Test: 手动验证（noj-ui 测试基建较弱，见仓库惯例）

**Interfaces:**
- Consumes: GET /api/v1/admin/settings 返回的完整元数据（Task 4）
- Produces: 无新接口；页面按 scope 渲染两组

**步骤：**

- [ ] **Step 1: 删除硬编码元数据**

移除 `settings.vue` 中：
- `ENV_ONLY_KEYS` Set（:105-112）；
- `SettingCategory` 联合类型硬编码（:19-30）→ 改从 API item 推断或放宽为 string；
- `CATEGORY_LABEL`/分组顺序数组（:48-60, :131-141）→ 改为服务端下发或保留纯展示映射（若保留需与注册表分类一致，倾向从 API 返回的 category 集合动态生成标签映射，标签文案可留前端但键集不再硬编码）。

- [ ] **Step 2: 按 scope 分组渲染**

上段「运行时可改」= `items.filter(i => i.scope === "runtime")`；下段「环境配置（只读，重启生效）」= `i.scope === "bootstrap"`。来源徽标逻辑改为读 `i.source` 与 `i.db_orphaned`：
- runtime 项：DB 徽标 / env 徽标 / 默认徽标（source）；
- bootstrap 项：统一"env（只读）"，若 `db_orphaned` 显示"忽略 DB 旧值"角标，悬停提示可一键清理（调 DELETE /settings/:key）。

下段展示**全部** bootstrap 项（含 `effective_value: null` 显示"未配置"），不再依赖"仅已设置才出现"。

- [ ] **Step 3: 操作按钮逻辑**

runtime 项保留"保存/重置"；bootstrap 项只读，若 `db_orphaned` 提供"清理残留值"按钮（DELETE），成功后刷新列表并 toast。

- [ ] **Step 4: 手动验证**

Run: `cd noj-ui && deno task dev`（需 noj-core 同时运行），访问 `/admin/settings`：
- 上段只出现 runtime 项（allow_register、限流、社区、审核）；
- 下段出现 bootstrap 项（storage/email/audit + env-only 如 PORT/NOJ_ENV + infra 如 LOG_LEVEL 未配置显示"未配置"）；
- storage_provider 若曾在 DB 写入，显示"忽略 DB 旧值"并可清理；
- PUT bootstrap 键被后端 400 拦截，UI 无编辑入口。
验证后停止 dev server。

- [ ] **Step 5: Commit**

```bash
cd noj-ui && git add pages/admin/settings.vue
git commit -F - <<'EOF'
feat(ui): 设置页按 scope 两段渲染，全元数据驱动去除硬编码键表

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 6: check-env 与注册表一致性校验（文档链路）

**Files:**
- Modify: `noj-core/scripts/check-env.ts`
- Test: `noj-core/tests/`（新增 check-env 的轻量单元测试或直接手动跑脚本）

**Interfaces:**
- Consumes: Task 1 的 `CONFIG_DEFINITIONS`（含 scope/envKey/envFallback）
- Produces: 校验报告——"注册表 env 键必须出现在 .env.example" 与 "孤儿键警告"

**步骤：**

- [ ] **Step 1: 写失败测试（或脚本内自检函数）**

因 check-env 是独立脚本，采用"提取可测函数 + 单元测试"方式（若仓库无脚本测试先例，可接受手动验证 + 简单断言脚本）。倾向：在 `scripts/check-env.ts` 内新增 `inspectConsistency(registryKeys, exampleKeys)` 纯函数并导出，配套最小测试文件 `noj-core/tests/scripts/check-env.test.ts`（参照仓库测试风格）：

```ts
Deno.test("check-env: 注册表键缺失于 .env.example 时报告", () => {
  const findings = inspectConsistency(
    new Set(["SOME_NEW_KEY"]),
    new Set(["JWT_SECRET"]),
  );
  assertEquals(findings.some(f => f.key === "SOME_NEW_KEY"), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd noj-core && deno task test`
Expected: FAIL——`inspectConsistency` 未导出/未定义。

- [ ] **Step 3: 实现**

1. `check-env.ts` 顶部 import `CONFIG_DEFINITIONS`（脚本 run -A 可读 TS 源码；注意脚本独立不依赖 DB，仅静态读注册表）；
2. 导出纯函数：
```ts
export function inspectConsistency(
  registryKeys: Set<string>,
  exampleKeys: Set<string>,
): { key: string; reason: string }[] {
  const out = [];
  for (const k of registryKeys) if (!exampleKeys.has(k))
    out.push({ key: k, reason: "注册表声明但 .env.example 缺失" });
  return out;
}
```
3. `main()` 中：
   - 注册表键集合 = `CONFIG_DEFINITIONS.filter(d => d.scope==="bootstrap" || d.envFallback).map(d => d.envKey ?? d.envFallback!)`（**bootstrap envKey + runtime envFallback 都应出现在 .env.example**，因为都是"env 可配"键；若 runtime envFallback 仅作可选兜底、可不在模板——按 spec §7"每个 bootstrap/env-owned 键必须出现"，这里取 bootstrap envKey 全集 + runtime envFallback 中确有兜底语义的——**简化决策：校验 bootstrap envKey 全集必须出现；runtime envFallback 出现与否仅警告**）；
   - 解析 `.env.example`（复用 `parseEnvFile`，路径默认 `./.env.example`）；
   - 孤儿键 = example 中有但注册表无（排除 NOJ_/已知 compose 级变量白名单如 POSTGRES_PASSWORD、REDIS_PASSWORD、MINIO_*、NOJ_VERSION 等——它们属部署编排变量非 core 读键，维护一个 `EXAMPLE_ALLOWLIST`）→ 警告（strict 报错）；
   - 输出并入现有 findings 流程。
4. 同步维护 `.env.example`：把 17 个划归项从"系统设置/社区/内容审核"可改注释段移到"启动期配置（只读，后台不可改，改后重启生效）"注释分组，与注册表描述一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task fmt && deno task lint && deno task test && deno task check:env`
Expected: 新测试 PASS；`check:env` 报告无新增一致性错误（或按要求补 .env.example 后通过）。

- [ ] **Step 5: Commit**

```bash
cd noj-core && git add scripts/check-env.ts tests/scripts/check-env.test.ts .env.example
git commit -F - <<'EOF'
feat(core): check-env 校验注册表与 .env.example 一致性，拦截孤儿/缺失键

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

### Task 7: 文档与 Agent Note 收尾

**Files:**
- Modify: `noj-core/CLAUDE.md`（env 表与设置说明）
- Modify: `dev-docs/engineering/config-layering.md`
- Modify: `.env.example` 分组注释（若 Task 6 未全做）
- Create: `.agents/notes/implemented/<分类>/2026-09-02-config-layering-semantics.md`
- Test: `deno run -A scripts/verify-agent-note-format.ts`（Agent Note 格式校验）

**Interfaces:**
- Consumes: 前述所有任务结论
- Produces: 一致的最新文档

**步骤：**

- [ ] **Step 1: 更新 noj-core/CLAUDE.md**

- env 表：标注三类（runtime 兜底键 / bootstrap 键 / infra 键），注明"管理后台>系统设置>环境配置 只读展示"；
- 更新设置说明：scope 两分法、读取链、bootstrap 不读 DB、残留清理。

- [ ] **Step 2: 更新 dev-docs/engineering/config-layering.md**

- 写入生命周期两分法语义（runtime=bootstrap 的定义与读取链）；
- 写入注册表为单一事实源 + check-env 一致性校验规则；
- 更新"新 env 变量必须同步 .env.example"规则为"必须登记入注册表（含 scope/envKey）+ 同步 .env.example"。

- [ ] **Step 3: 写 Agent Note**

按 AGENTS.md §9.3 格式：`# Agent Note: 配置分层语义治理` + `Status: implemented` + Problem/Decision/Alternatives considered/Consequences。分类取 `architecture`（或 `simplification`，按惯例选 architecture）。

- [ ] **Step 4: 校验 Agent Note 格式 + fmt/lint 全量**

Run:
```bash
cd noj-core && deno run -A ../scripts/verify-agent-note-format.ts
deno task fmt && deno task lint && deno task test:parallel
```
Expected: Agent Note 校验 PASS；全量测试通过。

- [ ] **Step 5: Commit**

```bash
cd neuro-oj && git add noj-core/CLAUDE.md dev-docs/engineering/config-layering.md .agents/notes/implemented/architecture/2026-09-02-config-layering-semantics.md
git commit -F - <<'EOF'
docs(root): 配置分层语义治理——scope 两分法文档与决策记录

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

---

## Self-Review

### Spec 覆盖检查

| Spec 需求 | Task |
|---|---|
| scope 两分法概念（§3） | Task 1（注册表 scope 字段） |
| 划归清单 17 项（§3.1） | Task 1 Step 3 |
| 统一注册表合并两表 + 新登记 ~30 项 + env 键唯一性（§3.2/3.3） | Task 1 |
| 读取层按 scope 分支、bootstrap 不读 DB（§4） | Task 2 |
| env 快照按 bootstrap envKey（§4） | Task 1 Step 4 |
| 存量切换：启动日志 + 忽略 DB + 一键清理（§5） | Task 2/3 |
| 后台页两段语义重写、删硬编码（§6） | Task 5（settings.vue） |
| community.vue preset 去重（§6 待确认项） | **未纳入**（spec §8 待确认项 1——需执行前与用户确认范围） |
| check-env 一致性校验（§7） | Task 6 |
| 文档链路（CLAUDE.md/config-layering） | Task 7 |

### 占位符扫描

已避免 TBD/TODO；各步骤均含具体文件、代码片段、命令与预期。唯一开放性决策（community.vue 范围、runtime envFallback 是否必现于模板）已在对应任务内标注"倾向/需执行前确认"。

### 类型一致性

- `ConfigDefinition.scope`、`envKey` 在 Task 1 定义，Task 2/4/6 消费一致；
- `isBootstrap()`/`findDefinition()` 命名在 Task 1 定义、Task 2/3 使用一致；
- `SettingValue.source` 维持 `"db" | "env" | "default"` 三态（不新增值，避免破坏既有消费）；
- `SystemSettingListItem` 在 Task 2 增 `scope`、Task 4 增 `db_orphaned`/`visible`，前端 Task 5 消费一致；
- `listOrphanedBootstrapRows`/`cleanupBootstrapRow` 命名跨 Task 2/3 一致。
