# noj-core 组织架构重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 noj-core 的 `lib/`、`middleware/`、`mq/`、`routes/`、`types/` 等横切目录重构为“域归属收拢 + `src/shared/` 共享内核”，同时保持 API、MQ、SSE 行为不变。

**Architecture:** 新建 `src/shared/` 承载真正跨域复用的基础设施；把 domain 专属的 middleware、MQ 消费者、SSE 路由、领域类型、业务工具迁入各 `domains/<domain>/`；每个域提供 `routes/index.ts` 域自装配，`app.ts` 只做全局中间件和按域挂载；测试随域走。

**Tech Stack:** Deno 2、TypeScript、Hono、Drizzle ORM、ioredis、jujutsu (jj)。

**Spec:** `dev-docs/superpowers/specs/2026-09-03-noj-core-organization-refactor-design.md`

## Global Constraints

- API 路径、鉴权语义、MQ 队列名、SSE 事件名完全不变。
- 不修改数据库 schema、不修改 `.env` 语义。
- `src/shared/**` 不得反向 import `src/domains/**`。
- 域间只允许通过 `domains/<domain>/index.ts` 门面导入。
- 所有提交使用 jj + GPG 签名，提交信息为中文 Conventional Commits。
- 运行测试必须通过 `deno task test:parallel`（或 `deno task test`），不要直接手拼 `deno test`。
- 每阶段结束必须通过：`deno task check`、`deno run -A scripts/check-domains.ts`、`deno run -A scripts/check-all.ts`（按阶段允许部分暂未全绿时在任务说明中注明）。
- Task 0 会创建 `scripts/rewrite-imports.ts`。后续所有“更新导入路径”步骤统一使用该脚本，命令形式为 `deno run -A scripts/rewrite-imports.ts <旧绝对路径> <新绝对路径>`；脚本不覆盖的非常规路径再用 `rg -l` 手工修正。

---

## Task 0: 创建导入路径重写脚本

**Files:**
- Create: `scripts/rewrite-imports.ts`

**Interfaces:**
- Produces: `deno run -A scripts/rewrite-imports.ts <oldAbsPath> <newAbsPath>`，自动扫描 `noj-core/src`、`noj-core/tests`、`noj-core/scripts` 下所有 `.ts` 文件，把解析到旧绝对路径的相对导入改写为指向新绝对路径。

- [ ] **Step 1: 创建 `scripts/rewrite-imports.ts`**

```ts
/**
 * 迁移辅助：把旧文件路径改写为新文件路径。
 *
 * 用法（在仓库根运行）：
 *   deno run -A scripts/rewrite-imports.ts noj-core/src/lib/errors.ts noj-core/src/shared/base/errors.ts
 *
 * 会扫描 noj-core/src、noj-core/tests、noj-core/scripts 下的 .ts 文件，
 * 找到“相对导入解析后等于旧绝对路径”的 import/export spec，替换为
 * 指向新绝对路径的相对 spec。
 */
import { dirname, relative, resolve, sep } from "node:path";

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
  }
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return [];
  } catch {
    return [];
  }
  await walk(dir);
  return results;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function rewriteImport(oldAbs: string, newAbs: string): Promise<number> {
  const oldTarget = toPosix(resolve(oldAbs));
  const newTarget = toPosix(resolve(newAbs));
  const roots = ["noj-core/src", "noj-core/tests", "noj-core/scripts"];
  let changedFiles = 0;

  for (const root of roots) {
    for (const file of await collectTsFiles(root)) {
      const content = await Deno.readTextFile(file);
      const specs = new Set<string>();
      for (const m of content.matchAll(IMPORT_RE)) {
        if (m[1]) specs.add(m[1]);
      }
      for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
        if (m[1]) specs.add(m[1]);
      }

      let updated = content;
      for (const spec of specs) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
        const target = toPosix(resolve(dirname(file), spec));
        if (target === oldTarget) {
          const newSpec = "./" + toPosix(relative(dirname(file), newTarget));
          updated = updated.split(`'${spec}'`).join(`'${newSpec}'`);
        }
      }
      if (updated !== content) {
        await Deno.writeTextFile(file, updated);
        changedFiles++;
        console.log(`updated ${file}`);
      }
    }
  }
  return changedFiles;
}

if (import.meta.main) {
  if (Deno.args.length !== 2) {
    console.error("用法: deno run -A scripts/rewrite-imports.ts <oldAbsPath> <newAbsPath>");
    Deno.exit(1);
  }
  const count = await rewriteImport(Deno.args[0]!, Deno.args[1]!);
  console.log(`重写完成，修改 ${count} 个文件`);
}
```

- [ ] **Step 2: 用一个已有文件自测**

```bash
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/errors.ts noj-core/src/shared/base/errors.ts
```

此时目标文件尚未移动，扫描应无匹配（或仅匹配已存在的旧路径），输出 `重写完成，修改 0 个文件` 即正常。

- [ ] **Step 3: 提交**

```bash
jj describe -m "chore(core): 新增导入路径重写辅助脚本"
jj new
```

> 后续所有“更新导入路径”步骤优先使用该脚本；脚本无法覆盖的非常规引用（如字符串常量里的路径）再用 `rg -l` 定位后手工修正。

**导入重写操作模板（后续所有任务通用）**：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/<旧路径> noj-core/<新路径>
# 对每个移动文件执行一次；随后用下列命令确认无残留：
rg -n '<旧路径片段>' noj-core/src noj-core/tests noj-core/scripts || true
```

每个任务的 Files 块已经给出旧/新路径映射，执行者按模板逐条执行，不再在每个任务的 Step 中重复书写完整命令。

---

## Task 1: 建立 `src/shared/` 骨架并迁移 `base` 模块

**Files:**
- Create: `noj-core/src/shared/base/`
- Move: `noj-core/src/lib/errors.ts`、`logging.ts`、`constants.ts`、`dates.ts`、`sql-rows.ts`
- Modify: 所有引用上述 5 个文件的 `src/**` 与 `tests/**` 导入路径

**Interfaces:**
- Consumes: 无
- Produces: `src/shared/base/errors.ts`、`src/shared/base/logging.ts`、`src/shared/base/constants.ts`、`src/shared/base/dates.ts`、`src/shared/base/sql-rows.ts`；导出符号与原文件完全一致。

- [ ] **Step 1: 创建目录并移动文件**

```bash
cd noj-core
mkdir -p src/shared/base
mv src/lib/errors.ts src/shared/base/errors.ts
mv src/lib/logging.ts src/shared/base/logging.ts
mv src/lib/constants.ts src/shared/base/constants.ts
mv src/lib/dates.ts src/shared/base/dates.ts
mv src/lib/sql-rows.ts src/shared/base/sql-rows.ts
```

- [ ] **Step 2: 更新所有导入路径**

使用 Task 0 脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/errors.ts noj-core/src/shared/base/errors.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/logging.ts noj-core/src/shared/base/logging.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/constants.ts noj-core/src/shared/base/constants.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/dates.ts noj-core/src/shared/base/dates.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/sql-rows.ts noj-core/src/shared/base/sql-rows.ts
```

脚本无法覆盖的非常规引用（如字符串常量）再用 `rg -l 'lib/(errors|logging|constants|dates|sql-rows)\.ts' noj-core/src noj-core/tests noj-core/scripts` 手工修正。完成后用 `deno check` 兜底。

- [ ] **Step 3: 运行类型检查**

```bash
cd noj-core && deno task check:types
```

Expected: 无未解析模块错误。

- [ ] **Step 4: 运行快速测试**

```bash
cd noj-core && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): 迁移共享基础模块到 src/shared/base"
jj new
```

---

## Task 2: 迁移 `config` 模块到 `src/shared/config`

**Files:**
- Create: `noj-core/src/shared/config/`
- Move: `noj-core/src/lib/settings-registry.ts`、`src/lib/production-config.ts`
- Modify: 所有引用上述文件的导入路径

**Interfaces:**
- Consumes: Task 1 的 `src/shared/base/*`
- Produces: `src/shared/config/settings-registry.ts`、`src/shared/config/production-config.ts`

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/shared/config
mv src/lib/settings-registry.ts src/shared/config/settings-registry.ts
mv src/lib/production-config.ts src/shared/config/production-config.ts
```

- [ ] **Step 2: 更新导入路径**

使用 Task 0 脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/settings-registry.ts noj-core/src/shared/config/settings-registry.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/production-config.ts noj-core/src/shared/config/production-config.ts
```

若 `settings-registry.ts` 内部引用 `./constants.ts`、`./dates.ts` 等，先执行 Task 1 中对应脚本，再手工检查 `src/shared/config/settings-registry.ts` 顶部导入为 `../base/...`。

- [ ] **Step 3: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移配置注册表到 src/shared/config"
jj new
```

---

## Task 3: 迁移 `db/` 到 `src/shared/db`

**Files:**
- Move: `noj-core/src/db/` → `noj-core/src/shared/db/`
- Modify: 所有 `src/**`、`tests/**`、`scripts/**` 中引用 `db/` 的导入路径

**Interfaces:**
- Consumes: 无
- Produces: `src/shared/db/connection.ts`、`src/shared/db/migrate.ts`、`src/shared/db/schema.ts`、`src/shared/db/schema/**`、`src/shared/db/schema-ddl.ts`

- [ ] **Step 1: 移动整个 db 目录**

```bash
cd noj-core
mkdir -p src/shared
mv src/db src/shared/db
```

- [ ] **Step 2: 更新导入路径**

因为 `db/` 是目录整体移动，脚本需对每个顶层文件执行一次（覆盖 `connection.ts`、`migrate.ts`、`schema.ts`、`schema-ddl.ts`、`schema/*.ts`）：

```bash
cd /path/to/neuro-oj
for f in $(find noj-core/src/shared/db -name '*.ts'); do
  old="noj-core/src/db/${f#noj-core/src/shared/db/}"
  deno run -A scripts/rewrite-imports.ts "$old" "$f"
done
```

同时检查 `noj-core/deno.json`、`drizzle.config.ts` 等配置中引用 `./src/db` 的路径并改为 `./src/shared/db`。

- [ ] **Step 3: 类型检查与数据库测试**

```bash
cd noj-core && deno task check:types && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移 db 目录到 src/shared/db"
jj new
```

---

## Task 4: 迁移 HTTP 工具到 `src/shared/http`

**Files:**
- Create: `noj-core/src/shared/http/`
- Move: `src/lib/request.ts`、`src/lib/pagination.ts`、`src/lib/file-stream.ts`
- Create: `src/shared/http/hono-env.ts`

**Interfaces:**
- Consumes: Task 1 的 `src/shared/base/*`
- Produces:
  - `src/shared/http/request.ts`
  - `src/shared/http/pagination.ts`
  - `src/shared/http/file-stream.ts`
  - `src/shared/http/hono-env.ts`，导出：
    ```ts
    export interface AuthEnv { Variables: { userId: string; userRole: string; mustChangePassword: boolean; jti?: string; } }
    export interface OptionalAuthEnv { Variables: { userId?: string; userRole?: string; mustChangePassword?: boolean; jti?: string; } }
    ```

- [ ] **Step 1: 创建目录并移动文件**

```bash
cd noj-core
mkdir -p src/shared/http
mv src/lib/request.ts src/shared/http/request.ts
mv src/lib/pagination.ts src/shared/http/pagination.ts
mv src/lib/file-stream.ts src/shared/http/file-stream.ts
```

- [ ] **Step 2: 创建 `src/shared/http/hono-env.ts`**

复制当前 `src/middleware/auth.ts` 中的 `AuthEnv` 和 `OptionalAuthEnv` 定义到新文件，并只保留类型定义（不导入业务逻辑）。

- [ ] **Step 3: 更新导入路径**

按全局模板执行：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/request.ts noj-core/src/shared/http/request.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/pagination.ts noj-core/src/shared/http/pagination.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/file-stream.ts noj-core/src/shared/http/file-stream.ts
```

- [ ] **Step 4: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): 迁移 HTTP 工具到 src/shared/http 并新增 Hono Env 类型"
jj new
```

---

## Task 5: 迁移 MQ 基础设施到 `src/shared/mq`

**Files:**
- Create: `noj-core/src/shared/mq/`
- Move: `src/mq/connection.ts`、`src/mq/base-consumer.ts`
- Modify: `src/lib/loginThrottle.ts`、`src/lib/revokedTokens.ts`、`src/lib/rate-limit.ts`、`src/lib/event-bus.ts`、`src/routes/health.ts` 等引用 `src/mq/connection.ts` 的文件

**Interfaces:**
- Consumes: Task 1 的 `src/shared/base/*`
- Produces: `src/shared/mq/connection.ts`、`src/shared/mq/base-consumer.ts`

- [ ] **Step 1: 移动 MQ 基础设施**

```bash
cd noj-core
mkdir -p src/shared/mq
mv src/mq/connection.ts src/shared/mq/connection.ts
mv src/mq/base-consumer.ts src/shared/mq/base-consumer.ts
```

- [ ] **Step 2: 更新导入路径**

使用 Task 0 脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/mq/connection.ts noj-core/src/shared/mq/connection.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/mq/base-consumer.ts noj-core/src/shared/mq/base-consumer.ts
```

- [ ] **Step 3: 类型检查与 MQ 测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/mq/consumer-config.test.ts tests/mq/producer.test.ts
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移 MQ 连接与消费者基类到 src/shared/mq"
jj new
```

---

## Task 6: 迁移 SSE 工具到 `src/shared/sse`

**Files:**
- Create: `noj-core/src/shared/sse/`
- Move: `src/lib/event-bus.ts`、`src/lib/sse-stream.ts`、`src/lib/sse-events.ts`
- Create: `src/shared/sse/server-helpers.ts`（从 `src/routes/sse.ts` 抽取 `lastEventId`、`subscribeToChannel`、`replayToStream`）

**Interfaces:**
- Consumes: Task 1 的 `src/shared/base/*`、Task 4 的 `src/shared/http/*`、Task 5 的 `src/shared/mq/*`
- Produces:
  - `src/shared/sse/event-bus.ts`、`sse-stream.ts`、`sse-events.ts`
  - `src/shared/sse/server-helpers.ts`

- [ ] **Step 1: 移动 SSE 工具**

```bash
cd noj-core
mkdir -p src/shared/sse
mv src/lib/event-bus.ts src/shared/sse/event-bus.ts
mv src/lib/sse-stream.ts src/shared/sse/sse-stream.ts
mv src/lib/sse-events.ts src/shared/sse/sse-events.ts
```

- [ ] **Step 2: 更新导入路径**

使用 Task 0 脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/event-bus.ts noj-core/src/shared/sse/event-bus.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/sse-stream.ts noj-core/src/shared/sse/sse-stream.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/sse-events.ts noj-core/src/shared/sse/sse-events.ts
```

- [ ] **Step 3: 抽取 `server-helpers.ts`**

将 `src/routes/sse.ts` 中的 `lastEventId`、`subscribeToChannel`、`replayToStream` 三个纯辅助函数复制到 `src/shared/sse/server-helpers.ts`，导入 `sse-stream.ts` 和 `sse-events.ts`。

- [ ] **Step 4: 修改 `src/routes/sse.ts` 改用 helper**

删除上述三个函数定义，改为：

```ts
import { lastEventId, subscribeToChannel, replayToStream } from "../shared/sse/server-helpers.ts";
```

- [ ] **Step 5: 类型检查与 SSE 相关测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/routes/sse.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): 迁移 SSE 工具到 src/shared/sse 并抽取 server-helpers"
jj new
```

---

## Task 7: 迁移限流工具到 `src/shared/rate-limit`

**Files:**
- Create: `noj-core/src/shared/rate-limit/`
- Move: `src/lib/rate-limit.ts`、`src/lib/rate-limit-env.ts`、`src/lib/hardening-rate-limit.ts`
- Modify: 所有引用这些文件的导入路径

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`、Task 2 `src/shared/config/*`、Task 5 `src/shared/mq/*`
- Produces: `src/shared/rate-limit/rate-limit.ts`、`rate-limit-env.ts`、`hardening-rate-limit.ts`

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/shared/rate-limit
mv src/lib/rate-limit.ts src/shared/rate-limit/rate-limit.ts
mv src/lib/rate-limit-env.ts src/shared/rate-limit/rate-limit-env.ts
mv src/lib/hardening-rate-limit.ts src/shared/rate-limit/hardening-rate-limit.ts
```

- [ ] **Step 2: 更新导入路径**

按全局模板执行：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/rate-limit.ts noj-core/src/shared/rate-limit/rate-limit.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/rate-limit-env.ts noj-core/src/shared/rate-limit/rate-limit-env.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/hardening-rate-limit.ts noj-core/src/shared/rate-limit/hardening-rate-limit.ts
```

- [ ] **Step 3: 类型检查与限流测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/lib/loginThrottle.test.ts tests/middleware/rate-limit.test.ts
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移限流工具到 src/shared/rate-limit"
jj new
```

---

## Task 8: 迁移安全与通用 ID 工具到 `src/shared/security`

**Files:**
- Create: `noj-core/src/shared/security/`
- Move: `src/lib/cidr.ts`、`src/lib/public-id.ts`、`src/lib/image-validation.ts`
- Modify: 所有引用这些文件的导入路径

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`
- Produces: `src/shared/security/cidr.ts`、`public-id.ts`、`image-validation.ts`

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/shared/security
mv src/lib/cidr.ts src/shared/security/cidr.ts
mv src/lib/public-id.ts src/shared/security/public-id.ts
mv src/lib/image-validation.ts src/shared/security/image-validation.ts
```

- [ ] **Step 2: 更新导入路径**

按全局模板执行：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/cidr.ts noj-core/src/shared/security/cidr.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/public-id.ts noj-core/src/shared/security/public-id.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/image-validation.ts noj-core/src/shared/security/image-validation.ts
```

- [ ] **Step 3: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/lib/cidr.test.ts tests/lib/public-id_test.ts tests/lib/storage/url.test.ts
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移 CIDR/公共 ID/图片校验到 src/shared/security"
jj new
```

---

## Task 9: 迁移存储与邮件到 `src/shared/storage`、`src/shared/email`

**Files:**
- Move: `noj-core/src/lib/storage/` → `src/shared/storage/`
- Move: `noj-core/src/lib/email.ts`、`src/lib/email-providers/` → `src/shared/email.ts`、`src/shared/email-providers/`
- Modify: 所有引用这些文件的导入路径

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`
- Produces: `src/shared/storage/*`、`src/shared/email.ts`、`src/shared/email-providers/*`

- [ ] **Step 1: 移动目录**

```bash
cd noj-core
mkdir -p src/shared
mv src/lib/storage src/shared/storage
mv src/lib/email.ts src/shared/email.ts
mv src/lib/email-providers src/shared/email-providers
```

- [ ] **Step 2: 更新导入路径**

对 storage 与 email 每个文件执行脚本：

```bash
cd /path/to/neuro-oj
for f in $(find noj-core/src/shared/storage noj-core/src/shared/email-providers -name '*.ts'); do
  old="noj-core/src/${f#noj-core/src/shared/}"
  deno run -A scripts/rewrite-imports.ts "$old" "$f"
done
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/email.ts noj-core/src/shared/email.ts
```

- [ ] **Step 3: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/lib/storage/local-storage.test.ts tests/lib/storage/s3.test.ts tests/lib/email-providers.test.ts
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移存储与邮件能力到 src/shared"
jj new
```

---

## Task 10: 新增 `shared/` 反向依赖静态检查

**Files:**
- Modify: `scripts/check-domains.ts`（或新增 `scripts/check-shared.ts` 并在 `scripts/check-all.ts` 接入）

**Interfaces:**
- Consumes: 无
- Produces: 静态检查命令，拒绝 `src/shared/**` import `src/domains/**`

- [ ] **Step 1: 在 `scripts/check-domains.ts` 增加 `checkShared`**

在 `checkDomains` 函数附近新增：

```ts
export async function checkSharedImports(root = "."): Promise<DomainViolation[]> {
  const violations: DomainViolation[] = [];
  const sharedDir = resolve(root, "noj-core/src/shared");
  try {
    const stat = await Deno.stat(sharedDir);
    if (!stat.isDirectory) return [];
  } catch {
    return [];
  }
  const files = await collectTsFiles(sharedDir);
  for (const file of files) {
    const rel = toPosix(relative(resolve(root), file));
    const content = await Deno.readTextFile(file);
    const specs = new Set<string>();
    for (const m of content.matchAll(IMPORT_RE)) {
      if (m[1]) specs.add(m[1]);
    }
    for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
      if (m[1]) specs.add(m[1]);
    }
    for (const spec of specs) {
      const target = resolveRelativeImport(file, spec, root);
      if (!target) continue;
      if (target.startsWith("noj-core/src/domains/")) {
        violations.push({
          file: rel,
          importSpec: spec,
          target,
          message: `shared 不得反向依赖 domains: ${spec}`,
        });
      }
    }
  }
  return violations;
}
```

在 `checkDomains(".")` 之后调用，并把 `sharedImports` 结果合并到同一失败输出：

```ts
const violations = await checkDomains(".");
const sharedViolations = await checkSharedImports(".");
const all = [...violations, ...sharedViolations];
```

后续 `--baseline` / 常规输出逻辑改用 `all`。

- [ ] **Step 2: 运行检查**

```bash
deno run -A scripts/check-domains.ts
```

Expected: 通过（当前 shared 尚未反向依赖 domains）。

- [ ] **Step 3: 提交**

```bash
jj describe -m "ci(core): 增加 src/shared 反向依赖静态检查"
jj new
```

---

## Task 11: 迁移 identity 域业务工具（lib → domains/identity）

**Files:**
- Move: `src/lib/permissions.ts`、`jwt.ts`、`password.ts`、`tfa.ts`、`resetToken.ts`、`revokedTokens.ts`、`loginThrottle.ts`、`banCache.ts` → `src/domains/identity/services/` 或 `src/domains/identity/lib/`
- Modify: `src/domains/identity/index.ts` 门面导出；所有引用这些文件的导入路径

**Interfaces:**
- Consumes: Task 1 的 `src/shared/base/*`、Task 4 的 `src/shared/http/*`、Task 6 的 `src/shared/mq/*`、Task 7 的 `src/shared/rate-limit/*`
- Produces: identity 门面额外导出 `getUserPermissions`、`resolvePermissions`、`checkPermission`、`assertPermission`、`requireAdmin`、`requirePermission`、`signToken`、`verifyToken`、`hashPassword`、`verifyPassword`、`setupTfa`、`verifyTfa`、`createResetToken`、`verifyResetToken`、`revokeJti`、`isJtiRevoked`、`loginThrottle` 等（保持原有符号名）。

- [ ] **Step 1: 移动文件并统一到 `src/domains/identity/services/security/`**

```bash
cd noj-core
mkdir -p src/domains/identity/services/security
mv src/lib/permissions.ts src/domains/identity/services/security/permissions.ts
mv src/lib/jwt.ts src/domains/identity/services/security/jwt.ts
mv src/lib/password.ts src/domains/identity/services/security/password.ts
mv src/lib/tfa.ts src/domains/identity/services/security/tfa.ts
mv src/lib/resetToken.ts src/domains/identity/services/security/resetToken.ts
mv src/lib/revokedTokens.ts src/domains/identity/services/security/revokedTokens.ts
mv src/lib/loginThrottle.ts src/domains/identity/services/security/loginThrottle.ts
mv src/lib/banCache.ts src/domains/identity/services/security/banCache.ts
```

- [ ] **Step 2: 更新 `src/domains/identity/index.ts`**

在文件顶部改为：

```ts
export * from "./services/security/permissions.ts";
export * from "./services/security/jwt.ts";
export * from "./services/security/password.ts";
export * from "./services/security/tfa.ts";
export * from "./services/security/resetToken.ts";
export * from "./services/security/revokedTokens.ts";
export * from "./services/security/loginThrottle.ts";
export * from "./services/security/banCache.ts";
```

保持对外门面符号不变。

- [ ] **Step 3: 更新所有引用旧 `lib/` 路径的导入**

先使用脚本：

```bash
cd /path/to/neuro-oj
for f in \
  noj-core/src/domains/identity/services/security/permissions.ts \
  noj-core/src/domains/identity/services/security/jwt.ts \
  noj-core/src/domains/identity/services/security/password.ts \
  noj-core/src/domains/identity/services/security/tfa.ts \
  noj-core/src/domains/identity/services/security/resetToken.ts \
  noj-core/src/domains/identity/services/security/revokedTokens.ts \
  noj-core/src/domains/identity/services/security/loginThrottle.ts \
  noj-core/src/domains/identity/services/security/banCache.ts; do
  old="noj-core/src/${f#noj-core/src/domains/identity/services/security/}"
  case "$old" in
    *permissions.ts) old="noj-core/src/lib/permissions.ts" ;;
    *jwt.ts) old="noj-core/src/lib/jwt.ts" ;;
    *password.ts) old="noj-core/src/lib/password.ts" ;;
    *tfa.ts) old="noj-core/src/lib/tfa.ts" ;;
    *resetToken.ts) old="noj-core/src/lib/resetToken.ts" ;;
    *revokedTokens.ts) old="noj-core/src/lib/revokedTokens.ts" ;;
    *loginThrottle.ts) old="noj-core/src/lib/loginThrottle.ts" ;;
    *banCache.ts) old="noj-core/src/lib/banCache.ts" ;;
  esac
  deno run -A scripts/rewrite-imports.ts "$old" "$f"
done
```

随后处理跨域引用：其他域不应深路径 import identity 的 `services/security/*`，应改为 `import { ... } from "../identity/index.ts"`。用 `rg -n 'domains/identity/services/security' noj-core/src` 检查并手工修正。

- [ ] **Step 4: 类型检查与相关测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/services/rbac.test.ts tests/services/auth.test.ts tests/services/users.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): identity 域收拢 JWT/RBAC/密码/封禁等业务工具"
jj new
```

---

## Task 12: 迁移 catalog 域业务工具（lib → domains/catalog）

**Files:**
- Move: `src/lib/problem-resolve.ts`、`src/lib/bundle-parser.ts` → `src/domains/catalog/services/`
- Modify: `src/domains/catalog/index.ts`、相关导入

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`、Task 8 `src/shared/security/*`
- Produces: catalog 门面额外导出 `resolveProblem`、`resolveProblemIdOrThrow`、`parseProblemBundle` 等（保持原符号）。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mv src/lib/problem-resolve.ts src/domains/catalog/services/problem-resolve.ts
mv src/lib/bundle-parser.ts src/domains/catalog/services/bundle-parser.ts
```

- [ ] **Step 2: 更新 `src/domains/catalog/index.ts` 重新导出**

```ts
export * from "./services/problem-resolve.ts";
export * from "./services/bundle-parser.ts";
```

- [ ] **Step 3: 更新所有引用旧路径的导入**

使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/problem-resolve.ts noj-core/src/domains/catalog/services/problem-resolve.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/bundle-parser.ts noj-core/src/domains/catalog/services/bundle-parser.ts
```

跨域引用改为从 `domains/catalog/index.ts` 门面导入，用 `rg -n 'domains/catalog/services/(problem-resolve|bundle-parser)' noj-core/src` 检查并手工修正。

- [ ] **Step 4: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/services/problems.test.ts tests/routes/problem-bundle.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): catalog 域收拢题目解析与题包解析工具"
jj new
```

---

## Task 13: 迁移 gateway 域业务工具（lib → domains/gateway）

**Files:**
- Move: `src/lib/llm-token.ts` → `src/domains/gateway/services/`
- Modify: `src/domains/gateway/index.ts`、相关导入

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`
- Produces: gateway 门面额外导出原 `src/lib/llm-token.ts` 的全部导出（当前为 `buildJudgeTaskLlmForProvider`）。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/gateway/services
mv src/lib/llm-token.ts src/domains/gateway/services/llm-token.ts
```

- [ ] **Step 2: 更新 `src/domains/gateway/index.ts` 重新导出**

```ts
export { buildJudgeTaskLlmForProvider } from "./services/llm-token.ts";
```

- [ ] **Step 3: 更新引用**

使用 Task 0 脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/llm-token.ts noj-core/src/domains/gateway/services/llm-token.ts
```

随后手工处理跨域导入：submission 等服务不应深路径 import gateway，改为从 `domains/gateway/index.ts` 门面导入（可在 `rg -n 'domains/gateway/services/llm-token' noj-core/src` 中检查无残留）。

- [ ] **Step 4: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/services/llm-problem.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): gateway 域收拢 LLM token 工具"
jj new
```

---

## Task 14: 迁移 system 域业务工具（lib → domains/system）

**Files:**
- Move: `src/lib/env-snapshot.ts` → `src/domains/system/services/`
- Modify: `src/domains/system/index.ts`、`src/main.ts`、相关导入

**Interfaces:**
- Consumes: Task 2 `src/shared/config/*`
- Produces: system 门面额外导出 `snapshotEnv`。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mv src/lib/env-snapshot.ts src/domains/system/services/env-snapshot.ts
```

- [ ] **Step 2: 更新 `src/domains/system/index.ts` 重新导出**

```ts
export { snapshotEnv } from "./services/env-snapshot.ts";
```

- [ ] **Step 3: 更新引用**

使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/lib/env-snapshot.ts noj-core/src/domains/system/services/env-snapshot.ts
```

- [ ] **Step 4: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): system 域收拢环境快照工具"
jj new
```

---

## Task 15: 迁移全局中间件到 `src/shared/middleware`

**Files:**
- Move: `src/middleware/request-context.ts`、`src/middleware/rate-limit.ts` → `src/shared/middleware/`
- Modify: `src/app.ts`、所有引用这两个中间件的路由文件

**Interfaces:**
- Consumes: Task 1 `src/shared/base/*`、Task 7 `src/shared/rate-limit/*`
- Produces: `src/shared/middleware/request-context.ts`、`src/shared/middleware/rate-limit.ts`

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/shared/middleware
mv src/middleware/request-context.ts src/shared/middleware/request-context.ts
mv src/middleware/rate-limit.ts src/shared/middleware/rate-limit.ts
```

- [ ] **Step 2: 更新导入**

按全局模板执行：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/request-context.ts noj-core/src/shared/middleware/request-context.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/rate-limit.ts noj-core/src/shared/middleware/rate-limit.ts
```

- [ ] **Step 3: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/middleware/rate-limit.test.ts
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 迁移全局中间件到 src/shared/middleware"
jj new
```

---

## Task 16: 迁移 identity 专属中间件

**Files:**
- Create: `noj-core/src/domains/identity/middleware/`
- Move: `src/middleware/auth.ts`、`login-rate-limit.ts`、`banlist.ts`
- Create: `src/domains/identity/middleware/index.ts` 或直接在门面导出
- Modify: `src/app.ts`、`src/routes/admin/index.ts`、所有引用 auth/banlist/login-rate-limit 的路由文件

**Interfaces:**
- Consumes: Task 4 `src/shared/http/hono-env.ts`、Task 11 identity services、Task 1/7 shared
- Produces: `domains/identity/middleware/auth.ts`、`login-rate-limit.ts`、`banlist.ts`；门面导出 `authMiddleware`、`optionalAuthMiddleware`、`adminMiddleware`、`loginIpRateLimit`、`banlistMiddleware`、`PASSWORD_CHANGE_WHITELIST`。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/identity/middleware
mv src/middleware/auth.ts src/domains/identity/middleware/auth.ts
mv src/middleware/login-rate-limit.ts src/domains/identity/middleware/login-rate-limit.ts
mv src/middleware/banlist.ts src/domains/identity/middleware/banlist.ts
```

- [ ] **Step 2: 修改 `auth.ts` 使用 shared Hono Env**

删除文件内 `AuthEnv` / `OptionalAuthEnv` 定义，改为：

```ts
import type { AuthEnv, OptionalAuthEnv } from "../../../shared/http/hono-env.ts";
```

保留 `export type { AuthEnv, OptionalAuthEnv }` 作为兼容出口。

- [ ] **Step 3: 更新 `src/domains/identity/index.ts`**

从 `./middleware/auth.ts`、`./middleware/login-rate-limit.ts`、`./middleware/banlist.ts` 重新导出。

- [ ] **Step 4: 更新所有引用旧 `middleware/auth.ts` 等路径的导入**

使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/auth.ts noj-core/src/domains/identity/middleware/auth.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/login-rate-limit.ts noj-core/src/domains/identity/middleware/login-rate-limit.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/banlist.ts noj-core/src/domains/identity/middleware/banlist.ts
```

随后跨域修正：
- 其他域不应深路径 import identity 的 `middleware/*`，应改为从 `domains/identity/index.ts` 门面导入；
- 若其他域只用到 `AuthEnv` / `OptionalAuthEnv` 类型，应改为从 `shared/http/hono-env.ts` 导入。
用 `rg -n 'domains/identity/middleware' noj-core/src` 检查并手工修正。

- [ ] **Step 5: 类型检查与相关测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/middleware/auth.test.ts tests/middleware/banlist.test.ts tests/routes/auth.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): identity 域收拢认证与封禁中间件"
jj new
```

---

## Task 17: 迁移 query 专属中间件

**Files:**
- Create: `noj-core/src/domains/query/middleware/`
- Move: `src/middleware/search-rate-limit.ts`
- Modify: `src/domains/query/index.ts`、引用该中间件的路由

**Interfaces:**
- Consumes: Task 7 `src/shared/rate-limit/*`、Task 11 identity 门面
- Produces: `domains/query/middleware/search-rate-limit.ts`；门面导出 `searchRateLimit`。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/query/middleware
mv src/middleware/search-rate-limit.ts src/domains/query/middleware/search-rate-limit.ts
```

- [ ] **Step 2: 更新 `src/domains/query/index.ts` 重新导出**

```ts
export { searchRateLimit } from "./middleware/search-rate-limit.ts";
```

- [ ] **Step 3: 更新引用**

使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/middleware/search-rate-limit.ts noj-core/src/domains/query/middleware/search-rate-limit.ts
```

- [ ] **Step 4: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/middleware/search-rate-limit.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): query 域收拢搜索限流中间件"
jj new
```

---

## Task 18: 迁移 identity 与 catalog 类型

**Files:**
- Create: `src/domains/identity/types/`、`src/domains/catalog/types/`
- Move: `src/types/auth.ts` → identity/types/auth.ts
- Move: `src/types/problems.ts`、`src/types/problem-bundle.ts`、`src/types/trainings.ts` → catalog/types/
- Create: `src/domains/catalog/types/runtime-config.ts`（从 `src/types/index.ts` 拆出 `EvaluatorRuntime`/`SolutionRuntime`/`RuntimeConfig`）
- Create: `src/domains/identity/types/permissions.ts`（从 `src/types/index.ts` 拆出 `PermissionName`/`PERMISSION_DEFS`）
- Modify: 相关域门面与所有引用

**Interfaces:**
- Consumes: Task 1/8 shared
- Produces: 各域门面导出对应类型。

- [ ] **Step 1: 创建目录并移动现有类型文件**

```bash
cd noj-core
mkdir -p src/domains/identity/types src/domains/catalog/types
mv src/types/auth.ts src/domains/identity/types/auth.ts
mv src/types/problems.ts src/domains/catalog/types/problems.ts
mv src/types/problem-bundle.ts src/domains/catalog/types/problem-bundle.ts
mv src/types/trainings.ts src/domains/catalog/types/trainings.ts
```

- [ ] **Step 2: 从 `src/types/index.ts` 拆出 runtime-config 与 permissions**

创建 `src/domains/catalog/types/runtime-config.ts`，内容为 `EvaluatorRuntime`、`SolutionRuntime`、`RuntimeConfig`。
创建 `src/domains/identity/types/permissions.ts`，内容为 `PermissionName`、`PERMISSION_DEFS`。
`src/types/index.ts` 中删除这两段导出。

- [ ] **Step 3: 更新域门面**

`identity/index.ts` 导出 `auth.ts` 与 `permissions.ts` 的类型；
`catalog/index.ts` 导出 `problems.ts`、`problem-bundle.ts`、`trainings.ts`、`runtime-config.ts` 的类型。

- [ ] **Step 4: 更新引用**

对整文件移动的类型使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/types/auth.ts noj-core/src/domains/identity/types/auth.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/problems.ts noj-core/src/domains/catalog/types/problems.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/problem-bundle.ts noj-core/src/domains/catalog/types/problem-bundle.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/trainings.ts noj-core/src/domains/catalog/types/trainings.ts
```

从 `src/types/index.ts` 拆出的 `RuntimeConfig`、`PermissionName`/`PERMISSION_DEFS` 引用无法用脚本自动处理，手工将相关 import 改为从 `domains/catalog/index.ts` 或 `domains/identity/index.ts` 门面导入。完成后用 `rg -l 'types/index\.ts|types/auth\.ts|types/problems\.ts|types/problem-bundle\.ts|types/trainings\.ts' noj-core/src noj-core/tests` 确认无残留。

- [ ] **Step 5: 类型检查与相关测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/types/problems.test.ts tests/types/contests.test.ts tests/routes/problems.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): 迁移 identity/catalog 领域类型并拆分 RuntimeConfig 与权限定义"
jj new
```

---

## Task 19: 迁移 submission 类型

**Files:**
- Create: `src/domains/submission/types/`
- Move: `src/types/self-tests.ts` → submission/types/self-tests.ts
- Move: `src/types/index.ts` 中 submission 相关导出 → `src/domains/submission/types/index.ts`
- Modify: 相关门面与所有引用

**Interfaces:**
- Consumes: Task 18 catalog 门面（`RuntimeConfig`）
- Produces: submission 门面导出 `JudgeTaskLlm`、`JudgeTask`、`JudgeResult`、`SubmissionStatus`、`SUBMISSION_STATUSES`、`assertNever`、`isTerminalSubmissionStatus`、`SCORE_SCALE`、`scoreToDb`、`scoreFromDb`、`LANGUAGE_EXT_MAP`、`SELF_TEST_ID_PREFIX`、`SELF_TEST_STATUSES`、`SelfTestStatus`、`SelfTestInput`、`SelfTestResponse`、`SelfTestDetail`。

- [ ] **Step 1: 创建 submission types 目录并移动 self-tests**

```bash
cd noj-core
mkdir -p src/domains/submission/types
mv src/types/self-tests.ts src/domains/submission/types/self-tests.ts
```

- [ ] **Step 2: 创建 `src/domains/submission/types/index.ts`**

将 `src/types/index.ts` 中的 `JudgeTaskLlm`、`JudgeTask`、`JudgeResult`、`SubmissionStatus`、`SUBMISSION_STATUSES`、`assertNever`、`isTerminalSubmissionStatus`、`SCORE_SCALE`、`scoreToDb`、`scoreFromDb`、`LANGUAGE_EXT_MAP` 复制过去。`JudgeTask` 需要的 `RuntimeConfig` 从 `../../catalog/index.ts` 导入。

- [ ] **Step 3: 更新 `src/domains/submission/index.ts` 重新导出**

- [ ] **Step 4: 删除 `src/types/index.ts` 中已迁移的导出**

- [ ] **Step 5: 更新引用**

self-tests 整文件移动用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/types/self-tests.ts noj-core/src/domains/submission/types/self-tests.ts
```

`src/types/index.ts` 拆分出的 submission 类型引用需手工改为从 `domains/submission/index.ts` 门面导入；`RuntimeConfig` 引用从 `domains/catalog/index.ts` 导入。完成后用 `rg -l 'types/index\.ts|types/self-tests\.ts' noj-core/src noj-core/tests` 确认无残留。

- [ ] **Step 6: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/types/index.test.ts tests/routes/submissions.test.ts tests/services/queue.test.ts
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
jj describe -m "refactor(core): 迁移 submission 评测协议与自测类型"
jj new
```

---

## Task 20: 迁移 contest / community / objective / system 类型

**Files:**
- Create: `src/domains/contest/types/`、`src/domains/community/types/`、`src/domains/objective/types/`、`src/domains/system/types/`
- Move: `src/types/contests.ts`、`community.ts`、`objective.ts`、`audit-log.ts`
- Modify: 相关门面与所有引用

**Interfaces:**
- Consumes: 各自域服务
- Produces: 对应域门面导出类型。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/contest/types src/domains/community/types src/domains/objective/types src/domains/system/types
mv src/types/contests.ts src/domains/contest/types/contests.ts
mv src/types/community.ts src/domains/community/types/community.ts
mv src/types/objective.ts src/domains/objective/types/objective.ts
mv src/types/audit-log.ts src/domains/system/types/audit-log.ts
```

- [ ] **Step 2: 更新各域门面重新导出类型**

- [ ] **Step 3: 更新引用**

使用脚本：

```bash
cd /path/to/neuro-oj
deno run -A scripts/rewrite-imports.ts noj-core/src/types/contests.ts noj-core/src/domains/contest/types/contests.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/community.ts noj-core/src/domains/community/types/community.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/objective.ts noj-core/src/domains/objective/types/objective.ts
deno run -A scripts/rewrite-imports.ts noj-core/src/types/audit-log.ts noj-core/src/domains/system/types/audit-log.ts
```

- [ ] **Step 4: 删除 `src/types/` 空目录**

```bash
rmdir src/types 2>/dev/null || true
```

- [ ] **Step 5: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno task test:smoke
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): 迁移 contest/community/objective/system 领域类型"
jj new
```

---

## Task 21: 迁移 submission MQ 消费者/生产者/sweeper

**Files:**
- Create: `noj-core/src/domains/submission/mq/`
- Move: `src/mq/consumer.ts`、`src/mq/producer.ts`、`src/mq/sweeper.ts`
- Modify: `src/main.ts`、`src/routes/health.ts`、`src/domains/submission/index.ts`、相关引用

**Interfaces:**
- Consumes: Task 5 `src/shared/mq/*`、Task 19 submission types、Task 13 gateway 门面、Task 14 system 门面
- Produces: `domains/submission/mq/consumer.ts`、`producer.ts`、`sweeper.ts`。门面导出：
  - consumer: `RESULT_QUEUE`、`DEFAULT_RESULT_CONSUMER_CONCURRENCY`、`MAX_RESULT_CONSUMER_CONCURRENCY`、`parseResultConsumerConcurrency`、`consumerAlive`、`ResultConsumerFactory`、`createResultConsumerPool`、`handleResultMessage`、`startResultConsumerWithRetry`、`requestResultConsumerShutdown`
  - producer: `JUDGE_QUEUE`、`MAX_JUDGE_QUEUE_LENGTH`、`isRetryableJudgeQueueError`、`pushJudgeTask`
  - sweeper: `recoverPendingSubmissions`、`recoverPendingSelfTests`、`cleanupOrphanArtifacts`、`runQueueSweeperOnce`、`startQueueSweeper`、`_resetSweeperStateForTest`

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/submission/mq
mv src/mq/consumer.ts src/domains/submission/mq/consumer.ts
mv src/mq/producer.ts src/domains/submission/mq/producer.ts
mv src/mq/sweeper.ts src/domains/submission/mq/sweeper.ts
```

- [ ] **Step 2: 更新文件内部导入**

以 `src/domains/submission/mq/` 为基准：

- `consumer.ts`：
  - `./base-consumer.ts` → `../../../shared/mq/base-consumer.ts`
  - `../domains/submission/index.ts` → `../index.ts`（submission 门面）
  - `../lib/logging.ts` → `../../../shared/base/logging.ts`
  - `../lib/event-bus.ts` → `../../../shared/sse/event-bus.ts`
- `producer.ts`：
  - `./connection.ts` → `../../../shared/mq/connection.ts`
  - `../lib/logging.ts` → `../../../shared/base/logging.ts`
- `sweeper.ts`：
  - `../db/connection.ts` → `../../../shared/db/connection.ts`
  - `../db/schema.ts` → `../../../shared/db/schema.ts`
  - `../lib/storage/mod.ts` → `../../../shared/storage/mod.ts`
  - `./connection.ts` → `../../../shared/mq/connection.ts`
  - `../lib/logging.ts` → `../../../shared/base/logging.ts`
  - `../types/index.ts` → `../types/index.ts`
  - `../types/problems.ts` → `../../catalog/index.ts`（`RuntimeConfig` 已迁至 catalog，经门面导入）
  - `../lib/llm-token.ts` → `../../gateway/index.ts`（门面导入）
  - `../domains/system/index.ts` → `../../system/index.ts`
  - `../domains/gateway/index.ts` → `../../gateway/index.ts`

- [ ] **Step 3: 更新 `src/domains/submission/index.ts` 门面重新导出**

- [ ] **Step 4: 更新外部引用**

```bash
rg -l 'mq/consumer\.ts|mq/producer\.ts|mq/sweeper\.ts' src tests
```

将 `src/main.ts`、`src/routes/health.ts` 等改为从 submission 门面导入。

- [ ] **Step 5: 类型检查与 MQ 测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/mq/consumer.test.ts tests/mq/producer.test.ts tests/mq/self-test-consumer.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): submission 域收拢评测 MQ 消费者/生产者/sweeper"
jj new
```

---

## Task 22: 迁移 content-review MQ 消费者

**Files:**
- Create: `noj-core/src/domains/content-review/mq/`
- Move: `src/mq/review-consumer.ts`
- Modify: `src/main.ts`、`src/domains/content-review/index.ts`、相关引用

**Interfaces:**
- Consumes: Task 5 `src/shared/mq/*`、Task 3 `src/shared/db/*`
- Produces: `domains/content-review/mq/review-consumer.ts`；门面导出 `createReviewConsumer`、`reviewConsumerAlive`。

- [ ] **Step 1: 移动文件**

```bash
cd noj-core
mkdir -p src/domains/content-review/mq
mv src/mq/review-consumer.ts src/domains/content-review/mq/review-consumer.ts
```

- [ ] **Step 2: 更新内部导入**

以 `src/domains/content-review/mq/review-consumer.ts` 为基准：

- `./base-consumer.ts` → `../../../shared/mq/base-consumer.ts`
- `../db/connection.ts` → `../../../shared/db/connection.ts`
- `../db/schema.ts` → `../../../shared/db/schema.ts`
- `../lib/logging.ts` → `../../../shared/base/logging.ts`
- `../domains/content-review/index.ts` → `../index.ts`（content-review 门面）

- [ ] **Step 3: 更新 `src/domains/content-review/index.ts` 门面重新导出**

- [ ] **Step 4: 更新外部引用**

```bash
rg -l 'mq/review-consumer\.ts' src tests
```

将 `src/main.ts` 改为从 content-review 门面导入。

- [ ] **Step 5: 类型检查与测试**

```bash
cd noj-core && deno task check:types && deno test -A --no-check tests/services/content-review.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
jj describe -m "refactor(core): content-review 域收拢私信审核消费者"
jj new
```

---

## Task 23: 拆分 SSE 路由到各域

**Files:**
- Create: `src/domains/submission/routes/sse.ts`、`src/domains/query/routes/sse.ts`、`src/domains/contest/routes/sse.ts`、`src/domains/community/routes/sse.ts`
- Modify: `src/routes/sse.ts`（删除已拆分端点）、`src/app.ts` 挂载方式

**Interfaces:**
- Consumes: Task 6 `src/shared/sse/*`、Task 19 submission 门面、Task 18/20 域门面
- Produces: 上述四个域 SSE 路由模块，导出 Hono router。

- [ ] **Step 1: 从 `src/routes/sse.ts` 复制对应端点到新文件**

- `submission/routes/sse.ts`：`GET /submissions/:id/events`、`GET /queue/events`
- `query/routes/sse.ts`：`GET /submissions/stats/events`
- `contest/routes/sse.ts`：`GET /contests/:id/events`
- `community/routes/sse.ts`：`GET /community/notifications/events`

每个新文件从 `../../../shared/sse/server-helpers.ts` 导入辅助函数，认证中间件从 `../../identity/index.ts` 门面导入。

- [ ] **Step 2: 从 `src/routes/sse.ts` 删除已复制端点**

保留 `src/routes/sse.ts` 中剩余内容；若已无可保留端点，则删除该文件（由各域 router 接管）。

- [ ] **Step 3: 类型检查**

```bash
cd noj-core && deno task check:types
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "refactor(core): 拆分 SSE 端点到所属域"
jj new
```

---

## Task 24: 为所有域创建 `routes/index.ts` 并简化 `app.ts`

**Files:**
- Create: 每个有路由的域 `src/domains/<domain>/routes/index.ts`
- Modify: `src/app.ts`、`src/routes/admin/index.ts`

**Interfaces:**
- Consumes: 各域现有 route 文件、Task 23 域 SSE 路由
- Produces: 各域导出 `xxxRouter`、`xxxAdminRouter`；`app.ts` 仅按域挂载。

- [ ] **Step 1: 为每个有公开路由的域创建 `routes/index.ts`**

参考模式：

```ts
// domains/identity/routes/index.ts
import { Hono } from "hono";
import auth from "./auth.ts";
import users from "./users.ts";
import checkin from "./checkin.ts";

export const identityRouter = new Hono();
identityRouter.route("/auth", auth);
identityRouter.route("/users", users);
identityRouter.route("/checkin", checkin);

export const identityAdminRouter = new Hono();
// ... admin routers
```

对以下域创建：
- identity（`identityRouter` + `identityAdminRouter`）
- catalog（`catalogRouter` + `catalogAdminRouter`）
- submission（含新 sse.ts；`submissionRouter` + `submissionAdminRouter`）
- query（含新 sse.ts；`queryRouter` + `queryAdminRouter`）
- contest（含新 sse.ts；`contestRouter` + `contestAdminRouter`）
- community（含新 sse.ts；`communityRouter` + `communityAdminRouter`）
- messaging（`messagingRouter`）
- system（`systemRouter` + `systemAdminRouter`）
- gateway（仅 `gatewayAdminRouter`，无公开 router）
- objective、content-review 无路由层，不需要创建 `routes/index.ts`

- [ ] **Step 2: 简化 `src/app.ts`**

替换所有逐个 `app.route` 的 import 为按域挂载：

```ts
app.route("/", health);
app.route("/api/v1", identityRouter);
app.route("/api/v1", catalogRouter);
app.route("/api/v1", submissionRouter);
app.route("/api/v1", queryRouter);
app.route("/api/v1", contestRouter);
app.route("/api/v1", communityRouter);
app.route("/api/v1", messagingRouter);
app.route("/api/v1", systemRouter);
app.route("/api/v1/admin", adminRouter);
```

将原有的顺序敏感注释移到对应域 `routes/index.ts` 内。

- [ ] **Step 3: 更新 `src/routes/admin/index.ts`**

改为从各域 `routes/index.ts` 收集 `xxxAdminRouter`，保留组级鉴权与 `FINE_GRAINED_ADMIN_PREFIXES`。

- [ ] **Step 4: 运行路由目录检查**

```bash
cd noj-core && deno task check:types && deno run -A ../scripts/gen-route-catalog.ts --check
```

Expected: API 路径集合与重构前一致。

- [ ] **Step 5: 提交**

```bash
jj describe -m "refactor(core): 路由域自装配并简化 app.ts"
jj new
```

---

## Task 25: 迁移共享层测试到 `tests/shared`

**Files:**
- Create: `noj-core/tests/shared/`
- Move: `tests/lib/errors.test.ts`、`logging_test.ts`、`pagination.test.ts`、`request.test.ts`、`sql-rows.test.ts`、`storage/`、`cidr.test.ts`、`public-id_test.ts`、`email-providers.test.ts`
- Modify: 测试内导入路径

**Interfaces:**
- Consumes: 前序任务形成的 `src/shared/**`
- Produces: `tests/shared/**` 测试文件。

- [ ] **Step 1: 移动共享测试与公共 helper**

```bash
cd noj-core
mkdir -p tests/shared
mv tests/lib/errors.test.ts tests/shared/errors.test.ts
mv tests/lib/logging_test.ts tests/shared/logging_test.ts
mv tests/lib/pagination.test.ts tests/shared/pagination.test.ts
mv tests/lib/request.test.ts tests/shared/request.test.ts
mv tests/lib/sql-rows.test.ts tests/shared/sql-rows.test.ts
mv tests/lib/cidr.test.ts tests/shared/cidr.test.ts
mv tests/lib/public-id_test.ts tests/shared/public-id_test.ts
mv tests/lib/email-providers.test.ts tests/shared/email-providers.test.ts
mv tests/lib/storage tests/shared/storage
mv tests/lib/helper.ts tests/helper.ts
```

- [ ] **Step 2: 更新测试导入路径**

将 `../lib/...` 改为 `../../shared/...` 或按相对深度修正；所有原 `../lib/helper.ts` 改为 `../helper.ts` 或按目标深度指向 `tests/helper.ts`。

- [ ] **Step 3: 运行共享测试**

```bash
cd noj-core && deno test -A --no-check tests/shared
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "test(core): 迁移共享层测试到 tests/shared"
jj new
```

---

## Task 26: 迁移各域测试

**Files:**
- Create: `src/domains/<domain>/tests/` 各目录
- Move: `tests/routes/*`、`tests/services/*`、`tests/middleware/*`、`tests/mq/*`、`tests/types/*` 中对应域测试
- Modify: 测试内导入路径

**Interfaces:**
- Consumes: 前序任务形成的域结构
- Produces: `src/domains/<domain>/tests/**`。

- [ ] **Step 1: 按归属移动测试**

按以下映射逐文件移动（源路径以 `noj-core/tests/` 为基准，目标路径以 `noj-core/src/domains/<domain>/tests/` 为基准；目标目录不存在时先创建）：

| 测试文件 | 目标域 |
|---|---|
| `routes/auth*.test.ts`、`routes/avatar.test.ts`、`routes/checkin.test.ts`、`routes/oauth.test.ts`、`routes/tfa.test.ts`、`routes/users.test.ts`、`routes/admin-blacklist.test.ts`、`routes/auth-admin.test.ts`、`routes/auth-ban-status.test.ts`、`routes/auth-dead-switches.test.ts` | `identity` |
| `services/auth*.test.ts`、`services/oauth*.test.ts`、`services/passwordReset.test.ts`、`services/banlist.test.ts`、`services/checkin.test.ts`、`services/tfa.test.ts`、`services/users.test.ts`、`services/user-ban.test.ts`、`services/rbac.test.ts`、`services/admin-roles.test.ts`（若存在） | `identity` |
| `routes/problems*.test.ts`、`routes/tags.test.ts`、`routes/trainings.test.ts`、`routes/problem-bundle.test.ts`、`routes/problem-field-guard.test.ts`、`routes/support-package.test.ts`、`routes/admin-trainings.test.ts` | `catalog` |
| `services/problems*.test.ts`、`services/tags.test.ts`、`services/trainings.test.ts`、`services/problem-bundle.test.ts`、`services/problem-field-guard.test.ts`、`services/problem-template.test.ts`、`services/rbac-training.test.ts`（若存在）、`services/support-package.test.ts` | `catalog` |
| `routes/queue.test.ts`、`routes/submissions.test.ts`、`routes/self-tests.test.ts` | `submission` |
| `services/queue.test.ts`、`services/submissions.test.ts`、`services/self-tests.test.ts`、`services/artifact-submissions.test.ts` | `submission` |
| `mq/consumer-config.test.ts`、`mq/consumer.test.ts`、`mq/producer.test.ts`、`mq/self-test-consumer.test.ts` | `submission`（放到 `submission/tests/mq/`） |
| `types/index.test.ts` | `submission`（放到 `submission/tests/types/index.test.ts`） |
| `routes/rankings.test.ts`、`routes/search.test.ts`、`routes/stats.test.ts` | `query` |
| `services/rankings.test.ts`、`services/search.test.ts`、`services/stats-cache.test.ts` | `query` |
| `middleware/search-rate-limit.test.ts` | `query` |
| `routes/contests.test.ts`、`services/contests.test.ts`、`services/contest-ranking.test.ts`、`services/contest-clarifications.test.ts`、`types/contests.test.ts` | `contest` |
| `routes/community.test.ts`、`services/community.test.ts` | `community` |
| `routes/messages.test.ts`、`services/messages.test.ts` | `messaging` |
| `routes/objective.test.ts`、`services/objective-judge.test.ts`、`services/objective-submissions.test.ts`、`types/objective.test.ts`（若存在） | `objective` |
| `routes/announcements.test.ts`、`routes/judge-images.test.ts`、`routes/admin-settings.test.ts`、`routes/admin-audit-logs.test.ts`、`services/announcements.test.ts`、`services/audit-log.test.ts`、`services/judge-images.test.ts`、`services/system-settings.test.ts` | `system` |
| `services/content-review.test.ts` | `content-review` |
| `services/llm-problem.test.ts` | `gateway` |

保留在顶层：
- `tests/routes/health.test.ts`（`src/routes/health.ts` 仍为顶层路由）
- `tests/routes/sse.test.ts` 中的 submit/queue/stats/contest/community SSE 用例在 Task 23 已按端点拆分；本任务将 `tests/routes/sse.test.ts` 对应拆分为：
  - `src/domains/submission/tests/sse.test.ts`（`/submissions/:id/events`、`/queue/events`）
  - `src/domains/query/tests/sse.test.ts`（`/submissions/stats/events`）
  - `src/domains/contest/tests/sse.test.ts`（`/contests/:id/events`）
  - `src/domains/community/tests/sse.test.ts`（`/community/notifications/events`）
  若某文件原本没有对应端点测试，则只移动存在的部分，不新增测试。
- `tests/middleware/rate-limit.test.ts` → 移到 `tests/shared/middleware/rate-limit.test.ts`
- `tests/lib/loginThrottle.test.ts` → 移到 `tests/shared/rate-limit/loginThrottle.test.ts` 或 `identity/tests`（取决于 Task 11 后其实现位置，若在 identity 则移到 identity/tests）

```bash
cd noj-core
mkdir -p src/domains/identity/tests src/domains/catalog/tests src/domains/submission/tests \
  src/domains/query/tests src/domains/contest/tests src/domains/community/tests \
  src/domains/messaging/tests src/domains/objective/tests src/domains/system/tests \
  src/domains/gateway/tests src/domains/content-review/tests
# 按上表逐条执行 mv，例如：
mv tests/routes/auth.test.ts src/domains/identity/tests/auth.test.ts
mv tests/services/problems.test.ts src/domains/catalog/tests/problems.test.ts
mv tests/services/submissions.test.ts src/domains/submission/tests/submissions.test.ts
```

- [ ] **Step 2: 更新测试导入路径**

- 被测试对象改为从同域相对路径或域门面导入。
- 公共 helper 继续从 `../../../tests/helper.ts`（按实际深度）导入。

- [ ] **Step 3: 删除顶层 `tests/routes`、`tests/services`、`tests/middleware`、`tests/mq`、`tests/types` 中已迁移文件**

```bash
find tests/routes tests/services tests/middleware tests/mq tests/types -type f -name '*.test.ts' 2>/dev/null | wc -l
```

确保没有遗留已迁移测试。

- [ ] **Step 4: 运行全量测试**

```bash
cd noj-core && deno task test:parallel
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): 测试随域迁移到 domains/*/tests"
jj new
```

---

## Task 27: 清理 `src/lib` / `src/types` 残留并更新文档

**Files:**
- Delete: `noj-core/src/lib/`、`noj-core/src/types/`（应为空）
- Modify: `noj-core/CLAUDE.md`、`dev-docs/engineering/domain-boundaries.md`、`dev-docs/engineering/route-catalog.md` 生成说明、`noj-core/deno.json` 若引用旧路径

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无残留目录；文档反映新结构。

- [ ] **Step 1: 确认残留**

```bash
cd noj-core && find src/lib src/types -type f 2>/dev/null | head
```

Expected: 无文件输出。

- [ ] **Step 2: 删除空目录**

```bash
rmdir src/lib src/types 2>/dev/null || true
```

- [ ] **Step 3: 更新 `noj-core/CLAUDE.md`**

将“目录结构”章节改为 spec 第 3 节目标结构。

- [ ] **Step 4: 更新 `dev-docs/engineering/domain-boundaries.md`**

补充 `src/shared/` 规则：`shared/**` 不得反向依赖 `domains/**`；列出现有 `shared/` 子目录职责。

- [ ] **Step 5: 运行全量检查**

```bash
deno run -A scripts/check-all.ts
cd noj-core && deno task test:parallel
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
jj describe -m "docs(core): 更新 noj-core 新目录结构与共享层边界文档"
jj new
```

---

## Task 28: 新增 Agent Note 与最终验收

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-09-03-noj-core-organization-refactor.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: Agent Note 记录本次架构决策。

- [ ] **Step 1: 创建 Agent Note**

按 `.agents/notes/README.md` 格式编写：标题、Status、Problem、Decision、Alternatives considered、Consequences。

- [ ] **Step 2: 运行格式校验与全量检查**

```bash
deno run -A scripts/verify-agent-note-format.ts
deno run -A scripts/check-all.ts
cd noj-core && deno task test:parallel
```

Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
jj describe -m "docs(core): 新增 noj-core 组织架构重构 Agent Note"
jj new
```

---

## Self-Review Notes

- **spec 覆盖**：所有 spec 章节（shared 清单、域归属、路由自装配、测试随域、迁移顺序、验证标准）均有对应任务。
- **types/index.ts 拆分**：Task 18/19 覆盖 RuntimeConfig、Submission 协议、RBAC 权限定义拆分。
- **shared 反向依赖**：Task 10 增加静态检查，Task 27 文档固化规则。
- **行为不变**：各任务均要求 `deno check` 和相关测试通过，Task 24 强制 `gen-route-catalog --check` 核对 API 路径。
