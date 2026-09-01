# noj-core 域隔离基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 noj-core 建立域边界文档与可执行的 `check:domains` 静态检查，作为后续按域迁移的基础设施。

**Architecture:** 先不移动业务代码；通过一份 `domain-boundaries.md` 明确“表/服务/路由 → 域”的归属，再用一个 Deno 脚本扫描 `src/domains/**` 与遗留 `src/services/**` 的相对导入，阻止跨域深路径依赖。后续域迁移计划将在本基础设施之上逐个执行。

**Tech Stack:** Deno 2、TypeScript、`deno test`、`scripts/check-all.ts`。

**Spec:** `dev-docs/superpowers/specs/2026-09-01-noj-core-domain-isolation-design.md`

## Global Constraints

- 所有提交必须 GPG 签名，使用 `jj` 提交。
- 提交信息遵循 Conventional Commits，描述使用中文。
- CI 中的 `scripts/check-all.ts` 是本仓库统一门禁入口。
- 搜索代码/文件内容必须使用 `rg`（ripgrep）。
- 新 Deno 脚本必须通过 `deno fmt`、`deno lint`。
- 本计划只做基础设施，不迁移业务代码。

---

### Task 1: 定义域边界文档

**Files:**
- Create: `dev-docs/engineering/domain-boundaries.md`

**Interfaces:**
- Consumes: 无
- Produces: 后续 `check-domains.ts` 依据这里的“域/表/服务目录”映射实现静态检查。

- [ ] **Step 1: 创建 `dev-docs/engineering/domain-boundaries.md`**

写入以下完整内容：

```markdown
# noj-core 域边界与所有权

> 本文档是 noj-core 代码级域隔离的事实来源。
> 每个域拥有自己的 routes / services / types；跨域只允许通过域门面（`index.ts`）或事件协作。

## 域目录

| 域 | 目录（目标） | 主要职责 |
|---|---|---|
| identity | `src/domains/identity/` | 注册/登录、JWT、TFA、密码重置、OAuth、用户资料、RBAC、用户封禁 |
| catalog | `src/domains/catalog/` | 题目、标签、题目包、支持包、题单 |
| objective | `src/domains/objective/` | 客观题套卷、题目、练习提交 |
| submission | `src/domains/submission/` | 提交、评测结果、评测队列、重测、自测、SSE 事件 |
| contest | `src/domains/contest/` | 竞赛、参赛者、题目关联、澄清、榜单 |
| community | `src/domains/community/` | 板块、帖子、评论、点赞、收藏、关注、动态、举报、审核、通知 |
| messaging | `src/domains/messaging/` | 私信、会话、已读、删除 |
| system | `src/domains/system/` | 系统设置、公告、审计日志、IP 封禁、Judge 镜像 |
| gateway | `src/domains/gateway/` | LLM Provider、用量、配额；远期迁入 noj-llm-gateway |
| query | `src/domains/query/` | 搜索、统计、排行榜、Dashboard 等读模型 |

## 遗留服务目录 → 域映射

下列 `src/services/*` 目录/文件在迁移完成前视为对应域的一部分：

| 遗留路径 | 域 |
|---|---|
| `src/services/auth`、`src/services/users`、`src/services/oauth.ts`、`src/services/tfa.ts`、`src/services/passwordReset.ts`、`src/services/banlist.ts`、`src/services/checkin.ts` | identity |
| `src/services/problems`、`src/services/tags.ts`、`src/services/trainings.ts`、`src/services/support-package.ts` | catalog |
| `src/services/submissions`、`src/services/queue.ts`、`src/services/self-tests.ts` | submission |
| `src/services/contest/` | contest |
| `src/services/community/`、`src/services/notifications.ts` | community |
| `src/services/objective/` | objective |
| `src/services/messages.ts` | messaging |
| `src/services/system-settings.ts`、`src/services/announcements.ts`、`src/services/audit-log.ts`、`src/services/seed/` | system |
| `src/services/llm.ts` | gateway |
| `src/services/search.ts`、`src/services/rankings.ts`、`src/services/stats-cache.ts`、`src/services/dashboard.ts` | query |

## 表所有权

| 表 | 域 |
|---|---|
| `users`、`oauth_accounts`、`roles`、`permissions`、`user_roles`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans` | identity |
| `problems`、`tags`、`problem_tags`、`trainings`、`training_problems` | catalog |
| `objective_questions`、`objective_submissions` | objective |
| `submissions`、`evaluation_results`、`self_tests`、`sse_events` | submission |
| `contests`、`contest_problems`、`contest_participants`、`contest_clarifications` | contest |
| `community_boards`、`community_board_role_grants`、`community_posts`、`community_comments`、`community_post_likes`、`community_comment_likes`、`community_bookmarks`、`community_follows`、`community_activity_events`、`community_reports`、`community_moderation_actions`、`community_sanctions`、`community_notifications` | community |
| `conversations`、`messages`、`conversation_reads`、`message_deletions` | messaging |
| `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images` | system |
| `llm_providers`、`llm_usage`、`llm_quotas` | gateway |

> 注：`check_ins` 由 identity 域拥有（用户签到）；`sse_events` 由 submission 域拥有（评测/状态事件），未来若作为通用 outbox 再调整为 shared。

## 跨域规则

1. 域 A 不得 import 域 B 的 `services/` 或 `routes/` 深路径。
2. 跨域只能 import `src/domains/<B>/index.ts`（门面）。
3. 共享内核 `src/shared/` 不得反向依赖 `src/domains/**`。
4. 遗留迁移期间，旧 `src/services/<域>` 也按上述规则检查，直到迁移完成。
```

- [ ] **Step 2: 校验文档存在**

Run: `test -f dev-docs/engineering/domain-boundaries.md && echo ok`
Expected: `ok`

- [ ] **Step 3: 提交**

```bash
jj commit -m "docs(core): 新增 noj-core 域边界与所有权文档"
```

---

### Task 2: 实现 `check-domains.ts` 静态检查脚本

**Files:**
- Create: `scripts/check-domains.ts`
- Test: `scripts/check-domains_test.ts`

**Interfaces:**
- Consumes: Task 1 的 `dev-docs/engineering/domain-boundaries.md` 中定义的域映射。
- Produces:
  - `domainOf(file: string): string | null`
  - `resolveRelativeImport(file: string, spec: string, root?: string): string | null`
  - `checkFile(file: string, content: string, root?: string): DomainViolation[]`
  - `checkDomains(root?: string): Promise<DomainViolation[]>`
  - CLI 入口：无违规时退出 0，有违规时打印并退出 1。

- [ ] **Step 1: 写失败测试 `scripts/check-domains_test.ts`**

```ts
import {
  checkFile,
  domainOf,
  resolveRelativeImport,
} from "./check-domains.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  assert(
    actual === expected,
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

Deno.test("domainOf: 遗留 auth 目录映射到 identity", () => {
  assertEquals(domainOf("src/services/auth/auth.ts"), "identity");
});

Deno.test("domainOf: contest 服务目录映射到 contest", () => {
  assertEquals(domainOf("src/services/contest/contests.ts"), "contest");
});

Deno.test("domainOf: 顶层 notifications.ts 映射到 community", () => {
  assertEquals(domainOf("src/services/notifications.ts"), "community");
});

Deno.test("domainOf: 非域文件返回 null", () => {
  assertEquals(domainOf("src/lib/errors.ts"), null);
});

Deno.test("resolveRelativeImport: 解析相对导入到仓库相对路径", () => {
  const target = resolveRelativeImport(
    "src/services/contest/contests.ts",
    "../submissions/submissions.ts",
  );
  assertEquals(target, "src/services/submissions/submissions.ts");
});

Deno.test("checkFile: 跨域深路径导入报违规", () => {
  const violations = checkFile(
    "src/services/contest/contests.ts",
    `import { listSubmissions } from "../submissions/submissions.ts";\n`,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.target, "src/services/submissions/submissions.ts");
});

Deno.test("checkFile: 同域相对导入不报违规", () => {
  const violations = checkFile(
    "src/services/contest/contest-ranking.ts",
    `import { getContest } from "./contests.ts";\n`,
  );
  assert(violations.length === 0, "应无违规");
});

Deno.test("checkFile: 允许未来域门面 index.ts 导入", () => {
  const violations = checkFile(
    "src/services/contest/contests.ts",
    `import { listSubmissions } from "../domains/submission/index.ts";\n`,
  );
  assert(violations.length === 0, "应允许域门面导入");
});

Deno.test("checkFile: 非相对导入不检查", () => {
  const violations = checkFile(
    "src/services/contest/contests.ts",
    `import { Hono } from "hono";\n`,
  );
  assert(violations.length === 0, "非相对导入不应产生违规");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A scripts/check-domains_test.ts`
Expected: FAIL，原因是 `scripts/check-domains.ts` 不存在。

- [ ] **Step 3: 实现 `scripts/check-domains.ts`**

```ts
/**
 * noj-core 域边界静态检查。
 *
 * 扫描 src/domains/** 与遗留 src/services/** 的相对导入：
 * - 域内文件不得深路径 import 其他域的 services/routes；
 * - 允许 import 目标域门面 src/domains/<domain>/index.ts；
 * - shared/lib/db/types 等共享路径不检查。
 */
import { dirname, relative, resolve } from "node:path";

export interface DomainViolation {
  file: string;
  importSpec: string;
  target: string;
  message: string;
}

const DOMAINS = new Set([
  "identity",
  "catalog",
  "objective",
  "submission",
  "contest",
  "community",
  "messaging",
  "system",
  "gateway",
  "query",
]);

const LEGACY_ALIASES: Record<string, string> = {
  auth: "identity",
  users: "identity",
  oauth: "identity",
  tfa: "identity",
  passwordReset: "identity",
  banlist: "identity",
  checkin: "identity",
  problems: "catalog",
  tags: "catalog",
  trainings: "catalog",
  "support-package": "catalog",
  submissions: "submission",
  queue: "submission",
  "self-tests": "submission",
  contest: "contest",
  community: "community",
  notifications: "community",
  messages: "messaging",
  objective: "objective",
  "system-settings": "system",
  announcements: "system",
  "audit-log": "system",
  seed: "system",
  llm: "gateway",
  search: "query",
  rankings: "query",
  "stats-cache": "query",
  dashboard: "query",
};

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

export function domainOf(file: string): string | null {
  const p = toPosix(file);
  const domainsMatch = p.match(/^src\/domains\/([^/]+)\//);
  if (domainsMatch && DOMAINS.has(domainsMatch[1]!)) {
    return domainsMatch[1]!;
  }
  const servicesDir = p.match(/^src\/services\/([^/]+)\//);
  if (servicesDir) {
    return LEGACY_ALIASES[servicesDir[1]!] ?? null;
  }
  const servicesFile = p.match(/^src\/services\/([^/]+)\.ts$/);
  if (servicesFile) {
    return LEGACY_ALIASES[servicesFile[1]!] ?? null;
  }
  return null;
}

export function resolveRelativeImport(
  file: string,
  spec: string,
  root = ".",
): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    return null;
  }
  const absSource = resolve(root, file);
  const absTarget = resolve(dirname(absSource), spec);
  const rel = relative(resolve(root), absTarget);
  return toPosix(rel);
}

function isPublicDomainImport(target: string): boolean {
  const m = toPosix(target).match(/^src\/domains\/([^/]+)\/index\.ts$/);
  return m ? DOMAINS.has(m[1]!) : false;
}

export function checkFile(
  file: string,
  content: string,
  root = ".",
): DomainViolation[] {
  const sourceDomain = domainOf(file);
  if (!sourceDomain) return [];

  const violations: DomainViolation[] = [];
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
    const targetDomain = domainOf(target);
    if (!targetDomain || targetDomain === sourceDomain) continue;
    if (isPublicDomainImport(target)) continue;

    violations.push({
      file,
      importSpec: spec,
      target,
      message: `${sourceDomain} 域不得深路径导入 ${targetDomain} 域: ${spec}`,
    });
  }
  return violations;
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
  await walk(dir);
  return results;
}

export async function checkDomains(root = "."): Promise<DomainViolation[]> {
  const violations: DomainViolation[] = [];
  for (const dir of ["src/domains", "src/services"]) {
    const absDir = resolve(root, dir);
    try {
      const stat = await Deno.stat(absDir);
      if (!stat.isDirectory) continue;
    } catch {
      continue;
    }
    const files = await collectTsFiles(absDir);
    for (const file of files) {
      const rel = toPosix(relative(resolve(root), file));
      if (!domainOf(rel)) continue;
      const content = await Deno.readTextFile(file);
      violations.push(...checkFile(rel, content, root));
    }
  }
  return violations;
}

if (import.meta.main) {
  const args = Deno.args;
  const baselineIndex = args.indexOf("--baseline");
  const baselinePath = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;

  const violations = await checkDomains(".");

  if (baselinePath) {
    const baselineText = await Deno.readTextFile(baselinePath).catch(() => "");
    const baseline = new Set(baselineText.split("\n").map((s) => s.trim()).filter(Boolean));
    const newViolations = violations.filter((v) => !baseline.has(`- ${v.file}: ${v.message}`));
    if (newViolations.length > 0) {
      console.error(`发现 ${newViolations.length} 条新增域边界违规:`);
      for (const v of newViolations) {
        console.error(`- ${v.file}: ${v.message}`);
      }
      Deno.exit(1);
    }
    console.log("域边界检查通过（无新增违规）");
    Deno.exit(0);
  }

  if (violations.length > 0) {
    console.error(`发现 ${violations.length} 条域边界违规:`);
    for (const v of violations) {
      console.error(`- ${v.file}: ${v.message}`);
    }
    Deno.exit(1);
  }
  console.log("域边界检查通过");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A scripts/check-domains_test.ts`
Expected: PASS

- [ ] **Step 5: 格式化与 lint**

Run: `deno fmt scripts/check-domains.ts scripts/check-domains_test.ts && deno lint scripts/check-domains.ts scripts/check-domains_test.ts`
Expected: 无输出/无错误

- [ ] **Step 6: 生成基线违规清单**

Run: `deno run -A scripts/check-domains.ts > dev-docs/engineering/domain-violations-baseline.txt 2>&1; echo "exit=$?"`
Expected: 输出 `exit=1`（当前迁移前存在历史违规属于预期），文件内容以“发现 N 条域边界违规”开头，每行格式为 `- <file>: <message>`。

- [ ] **Step 7: 提交**

```bash
jj commit -m "feat(core): 新增域边界静态检查 scripts/check-domains"
```

---

### Task 3: 接入 `check-all.ts` 与 `deno task check:domains`

**Files:**
- Modify: `scripts/check-all.ts`
- Modify: `noj-core/deno.json`

**Interfaces:**
- Consumes: Task 2 的 `scripts/check-domains.ts`。
- Produces: 仓库级 `check-all` 会执行域边界检查；`noj-core` 提供 `deno task check:domains` 快捷入口。

- [ ] **Step 1: 在 `scripts/check-all.ts` 添加门禁**

在“== 仓库级门禁 ==”区块追加一行：

```ts
  await run([
    "deno",
    "run",
    "-A",
    "scripts/check-domains.ts",
    "--baseline",
    "dev-docs/engineering/domain-violations-baseline.txt",
  ]);
```

- [ ] **Step 2: 在 `noj-core/deno.json` 添加 task**

在 `tasks` 对象中追加：

```json
    "check:domains": "deno run -A ../scripts/check-domains.ts"
```

- [ ] **Step 3: 运行门禁验证**

Run: `deno run -A scripts/check-all.ts`
Expected: 仓库级门禁中域边界检查输出“域边界检查通过（无新增违规）”，且 `check-all` 最终全部通过；确认命令已接入。

- [ ] **Step 4: 提交**

```bash
jj commit -m "ci(root): 将域边界检查接入 check-all 与 noj-core task"
```

---

## Self-Review

- Spec coverage：本计划覆盖设计文档 Step 1（域边界文档）与 Step 2（检查脚本 + CI 接入），后续 contest 迁移单独建计划。
- Placeholder scan：所有步骤含实际文件路径、代码或命令，无 TBD/TODO。
- Type consistency：`DomainViolation`、`domainOf`、`resolveRelativeImport`、`checkFile`、`checkDomains` 在测试与实现中签名一致。
