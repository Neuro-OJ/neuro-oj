# 出题人与选手体验增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通竞赛风控的复核闭环、让出题人看见题目数据、为题目提供官方题解并堵住竞赛赛期的题解剧透。

**Architecture:** 三个工作流（W1 风控接线 / W2 数据洞察 / W3 官方题解与赛后复盘）可独立交付。W2 与 W3 共用一个新建的"题目是否处于进行中竞赛"判定点（`contest/services/problem-exposure.ts`），该判定纯按时间窗口实时计算，不引入缓存或调度任务。W3 的题解门控全部实现在**服务层**（读路径 5 处 + 搜索 SQL 谓词 + 发布入口），而非路由层。

**Tech Stack:** Deno 2 + Hono + Drizzle ORM + PostgreSQL 16（noj-core）；Nuxt 4 + Vue 3 + Nuxt UI v4 + Tailwind v4（noj-ui）；Deno.test（后端测试）。

**Spec:** `dev-docs/superpowers/specs/2026-09-14-problem-setter-and-solver-experience-design.md`

## Global Constraints

- 迁移禁止 `ALTER TABLE ... ADD COLUMN ... NOT NULL` 不带 `DEFAULT`（本计划新增列 `is_official` 带 `DEFAULT false`，合规）。门禁：`deno run -A scripts/check-migration-safety.ts`
- 迁移文件由 `deno task db:generate` 生成；**禁止手改 `_journal.json`**
- 跨域只允许 import 其他域的 `index.ts` 门面；禁止深路径 import 其他域 `services/`、`routes/`
- `domains/observability` 是受限域：本计划**不得**改动它
- 新增进程内可变状态必须登记 `dev-docs/engineering/domain-boundaries.md` 的「多副本约束」表
- 测试必须用 `deno task test:domain <domain>`（noj-core）或 `deno task test`（noj-ui），**禁止手拼 `deno test`**
- 前端业务代码禁止直接 `$fetch`，统一走 `useApi()`；错误文案用 `extractApiError(e).message`
- **文案遵循各文件的既有约定**：本计划触及的 4 个 UI 文件（`admin/contests.vue`、`problems/[id].vue`、`editor/CodingProblemEditor.vue`、`contests/[contestId]/index.vue`）**均硬编码中文**，未接入 `useI18n`。全仓 104 个页面/组件中仅 11 个使用 i18n，且 `2026-09-06-frontend-i18n` Agent Note 明确写明"低频管理/社区页面仍可能显示中文，后续按 key 逐步迁移"。因此**本计划在这些文件内直接写中文文案，不新增 i18n key**（引入半套 i18n 会造成新的不一致）。`ProblemStatsPanel.vue` 为新建组件，同样直接写中文以与其使用者一致
- 文件规模棘轮：单文件 > 1200 行且未登记基线即失败（`scripts/check-file-size.ts`）。`admin/contests.vue` 当前 661 行
- 提交：Conventional Commits + 中文描述 + GPG 签名（jj：`jj describe` → `jj new`）
- 每个工作流完成后跑 `deno run -A scripts/check-ci.ts`

---

## 文件结构总览

| 文件 | 职责 | 工作流 |
| --- | --- | --- |
| `noj-core/src/domains/contest/services/problem-exposure.ts` | **新建**。题目是否处于进行中竞赛的单一判定点 | W2/W3 共享 |
| `noj-core/src/domains/contest/index.ts` | 导出上述判定 | W2 |
| `noj-core/src/domains/catalog/services/problems/problems-stats.ts` | **新建**。通过率与用例失败分布聚合 + 5 分钟缓存 | W2 |
| `noj-core/src/domains/catalog/routes/problems.ts` | +2 统计路由 | W2 |
| `noj-core/src/shared/db/schema/community.ts` | `is_official` 列 + 索引 | W3 |
| `noj-core/src/domains/community/services/community/community-post-list.ts` | 题解门控（listPosts/getPost/countPostsByType/listBookmarks） | W3 |
| `noj-core/src/domains/community/services/community/community-feed.ts` | 动态流题解门控 | W3 |
| `noj-core/src/domains/search/services/permission-filter.ts` | 题解搜索门控 SQL 谓词 | W3 |
| `noj-core/src/domains/community/routes/community.ts` | eligibility 返回 `blocked_reason` | W3 |
| `noj-ui/composables/useContests.ts` | 相似提交 API + DTO | W1 |
| `noj-ui/composables/useProblemStats.ts` | **新建**。题目统计数据获取 | W2 |
| `noj-ui/pages/admin/contests.vue` | 风控面板加"相似提交" tab | W1 |
| `noj-ui/components/admin/ProblemStatsPanel.vue` | **新建**。统计展示组件（供编辑页与题面页复用） | W2 |
| `noj-ui/pages/problems/[id].vue` | 公开通过率 + 官方题解置顶 + 赛期禁用发布 | W2/W3 |
| `noj-ui/pages/contests/[contestId]/index.vue` | 赛后复盘分区 | W3 |
| （不新增 i18n） | 本计划触及的 UI 文件均硬编码中文，按既有约定直接写中文文案 | — |

---

# W1：风控接线（纯前端，单 PR）

### Task 1: 相似提交 API 客户端与 DTO

**Files:**
- Modify: `noj-ui/composables/useContests.ts`（在 `listAntiCheatTimeline` 之后，约 `:244`）
- Test: `noj-ui/tests/contestAntiCheat_test.ts`（追加）

**Interfaces:**
- Consumes: 后端 `GET /api/v1/admin/contest/contests/:id/anti-cheat/similar-submissions`（已存在，无需改动）
- Produces:
  - `export interface SimilarSubmissionPair`（字段见下）
  - `export interface SimilarSubmissionsMeta`
  - `listAntiCheatSimilarSubmissions(contestId: string, query?: { threshold?: number; limit?: number; problem_id?: string })`

- [ ] **Step 1: 写失败测试**

追加到 `noj-ui/tests/contestAntiCheat_test.ts` 末尾：

```ts
type SimilarSubmissionPair = {
  submission_a_id: string;
  user_a_id: string;
  username_a: string | null;
  submitted_at_a: string | null;
  submission_b_id: string;
  user_b_id: string;
  username_b: string | null;
  submitted_at_b: string | null;
  problem_id: string;
  language: string;
  similarity: number;
  shared_fingerprints: number;
  fingerprint_count_a: number;
  fingerprint_count_b: number;
};

Deno.test('相似提交 DTO 不含源代码，且携带人工复核所需的证据强度字段', () => {
  const pair: SimilarSubmissionPair = {
    submission_a_id: 's1',
    user_a_id: 'u1',
    username_a: 'alice',
    submitted_at_a: '2026-01-01T00:00:00.000Z',
    submission_b_id: 's2',
    user_b_id: 'u2',
    username_b: 'bob',
    submitted_at_b: '2026-01-01T00:05:00.000Z',
    problem_id: 'p1',
    language: 'python3',
    similarity: 0.9312,
    shared_fingerprints: 142,
    fingerprint_count_a: 180,
    fingerprint_count_b: 155,
  };
  const keys = Object.keys(pair);
  // 复核只需要线索字段；源码属于提交详情页面的职责（最小暴露面）
  assertEquals(keys.includes('code'), false);
  assertEquals(keys.includes('source'), false);
  // 证据强度三件套必须存在，管理员据此判断相似度是否可信
  assertEquals(keys.includes('shared_fingerprints'), true);
  assertEquals(keys.includes('fingerprint_count_a'), true);
  assertEquals(keys.includes('fingerprint_count_b'), true);
  assertEquals(typeof pair.similarity, 'number');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-ui && deno task test`
Expected: FAIL —— `SimilarSubmissionPair` 类型未定义（或新用例尚未通过）；若类型在测试文件内自声明则先确认该文件可编译

- [ ] **Step 3: 在 composable 中加类型与函数**

在 `noj-ui/composables/useContests.ts` 的 `listAntiCheatTimeline` 函数之后插入：

```ts
  /**
   * 竞赛内互相高度相似的提交对（人工复核线索）。
   * 响应不含源代码；源码走 `/api/v1/admin/submission/submissions/:id`。
   */
  function listAntiCheatSimilarSubmissions(
    contestId: string,
    query?: { threshold?: number; limit?: number; problem_id?: string },
  ) {
    return api.get<{
      data: SimilarSubmissionPair[];
      meta: SimilarSubmissionsMeta;
      data_policy: {
        purpose: string;
        retention_days: number;
        automated_penalty: boolean;
      };
    }>(
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions`,
      { query, silent: true },
    );
  }
```

在同文件的类型声明区（`ContestAntiCheatTimelineItem` 附近）加：

```ts
/** 相似提交对：仅含人工复核所需字段，不含源代码。 */
export interface SimilarSubmissionPair {
  submission_a_id: string;
  user_a_id: string;
  username_a: string | null;
  submitted_at_a: string | null;
  submission_b_id: string;
  user_b_id: string;
  username_b: string | null;
  submitted_at_b: string | null;
  problem_id: string;
  language: string;
  similarity: number;
  shared_fingerprints: number;
  fingerprint_count_a: number;
  fingerprint_count_b: number;
}

/** 相似度分析的规模与覆盖率元数据：缺了它会把“没算到”误读成“没有相似提交”。 */
export interface SimilarSubmissionsMeta {
  threshold: number;
  limit: number;
  total: number;
  truncated: boolean;
  candidates: number;
  participating: number;
  skipped: number;
  buckets: number;
  max_submissions: number;
}
```

并在文件末尾的 `return { ... }` 中导出新函数（与 `listAntiCheatTimeline` 并列）：

```ts
    listAntiCheatSimilarSubmissions,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-ui && deno task test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): 竞赛风控补相似提交 API 客户端与 DTO"
jj new
```

---

### Task 2: 风控面板加"相似提交"分栏

**Files:**
- Modify: `noj-ui/pages/admin/contests.vue`（风控弹窗，约 `:643-652`）
- Test: 手工验收（见 Step 5）

**Interfaces:**
- Consumes: Task 1 的 `listAntiCheatSimilarSubmissions`、`SimilarSubmissionPair`、`SimilarSubmissionsMeta`
- Produces: 无（终端 UI）

> **文案约定**：`admin/contests.vue` **未接入 i18n**（全仓 104 个页面/组件中仅 11 个使用 `useI18n`，该文件是硬编码中文）。**不要为本任务新增 i18n key** —— 直接写中文文案，与该文件其余部分保持一致（见 Global Constraints 第 7 条）。

- [ ] **Step 1: 加状态与加载逻辑**

在 `noj-ui/pages/admin/contests.vue` 的 `<script setup>` 中，`antiCheatGroups` 等 ref 声明之后插入：

```ts
// ── 风控面板：IP 关联 / 相似提交 两个分栏 ──────────────────────
const antiCheatTab = ref<'ip' | 'similar'>('ip')
const similarPairs = ref<SimilarSubmissionPair[]>([])
const similarMeta = ref<SimilarSubmissionsMeta | null>(null)
const similarThreshold = ref(0.8)
const similarProblemId = ref('')
const similarLoading = ref(false)
const similarError = ref('')

const antiCheatProblemOptions = computed(() =>
  problems.value.map((p) => ({ label: `${p.display_id || p.id} ${p.title}`, value: p.id })),
)

async function loadSimilarSubmissions() {
  if (!antiCheatContest.value) return
  similarLoading.value = true
  similarError.value = ''
  try {
    const res = await listAntiCheatSimilarSubmissions(antiCheatContest.value.id, {
      threshold: similarThreshold.value,
      limit: 50,
      ...(similarProblemId.value ? { problem_id: similarProblemId.value } : {}),
    })
    similarPairs.value = res.data
    similarMeta.value = res.meta
  } catch (e) {
    similarError.value = extractApiError(e).message
    similarPairs.value = []
    similarMeta.value = null
  } finally {
    similarLoading.value = false
  }
}

/** 切换分栏时按需加载，避免打开面板就做一次 200 份候选的相似度计算。 */
watch(antiCheatTab, (tab) => {
  if (tab === 'similar' && similarPairs.value.length === 0 && !similarLoading.value) {
    void loadSimilarSubmissions()
  }
})

/** 关闭风控面板时清空相似提交状态，避免残留上一次竞赛的结果。 */
watch(antiCheatContest, (contest) => {
  if (!contest) {
    antiCheatTab.value = 'ip'
    similarPairs.value = []
    similarMeta.value = null
    similarError.value = ''
  }
})
```

在文件顶部的 `useContests()` 解构中追加新函数，并引入类型：

```ts
const { typeLabels, statusLabels, formatDateTime, statusClass, listAntiCheatGroups, listAntiCheatTimeline, listAntiCheatSimilarSubmissions } = useContests()
```

```ts
import type { SimilarSubmissionPair, SimilarSubmissionsMeta } from '~/composables/useContests'
```

（若该文件已有 `useContests` 的类型 import 行，把两个类型并入该行。约定已核对：`noj-ui/pages/community/bookmarks.vue:2` 即用 `import type { ... } from '~/composables/useCommunity'` 这一形式。）

同时确认 `extractApiError` 已 import（该文件已在用则跳过）：

```ts
import { extractApiError } from '~/utils/apiError'
```

- [ ] **Step 2: 改模板 —— 加 tab 切换与相似提交列表**

把风控弹窗的 header 之后、`<div class="flex-1 overflow-y-auto p-5">` 之前插入 tab 栏：

```html
      <div class="flex gap-1 border-b border-border px-6 pt-3">
        <button
          class="rounded-t-lg px-3 py-2 text-sm font-medium transition"
          :class="antiCheatTab === 'ip' ? 'border-b-2 border-signal text-text' : 'text-text-secondary hover:text-text'"
          @click="antiCheatTab = 'ip'"
        >
          IP 关联
        </button>
        <button
          class="rounded-t-lg px-3 py-2 text-sm font-medium transition"
          :class="antiCheatTab === 'similar' ? 'border-b-2 border-signal text-text' : 'text-text-secondary hover:text-text'"
          @click="antiCheatTab = 'similar'"
        >
          相似提交
        </button>
      </div>
```

把原 `<div class="flex-1 overflow-y-auto p-5">` 内的内容**用 `v-if="antiCheatTab === 'ip'"` 包住**（不改内部结构），并在其后追加相似提交分支：

```html
        <div v-else class="space-y-4">
          <p class="text-xs text-text-secondary">基于代码 token 指纹的相似度，仅供人工复核，不自动判罚。</p>

          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2 text-xs text-text-secondary">
              相似度阈值
              <input v-model.number="similarThreshold" type="range" min="0.5" max="0.99" step="0.01" class="w-40">
              <span class="font-mono tabular-nums text-text">{{ similarThreshold.toFixed(2) }}</span>
            </label>
            <USelect
              v-model="similarProblemId"
              :items="[{ label: '全部题目', value: '' }, ...antiCheatProblemOptions]"
              size="sm"
              class="min-w-52"
            />
            <UButton size="sm" color="primary" :loading="similarLoading" @click="loadSimilarSubmissions">
              刷新
            </UButton>
          </div>

          <p v-if="similarMeta" class="text-xs text-text-muted">
            比较 {{ similarMeta.participating }} 份 / 候选 {{ similarMeta.candidates }} 份，跳过 {{ similarMeta.skipped }} 份
          </p>
          <p v-if="similarMeta?.truncated" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            结果已按上限截断，请按题目缩小范围后重试
          </p>
          <p v-if="similarError" class="text-sm text-error-text">{{ similarError }}</p>
          <p v-if="similarLoading" class="py-12 text-center text-sm text-text-muted">加载中...</p>

          <div v-else-if="similarPairs.length" class="divide-y divide-border rounded-xl border border-border">
            <div v-for="pair in similarPairs" :key="`${pair.submission_a_id}-${pair.submission_b_id}`" class="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3">
              <UBadge color="warning" variant="subtle" class="tabular-nums">{{ pair.similarity.toFixed(4) }}</UBadge>
              <div class="min-w-0 text-xs">
                <div class="truncate">
                  <strong class="text-text">{{ pair.username_a ?? '—' }}</strong>
                  <span class="mx-1 text-text-muted">↔</span>
                  <strong class="text-text">{{ pair.username_b ?? '—' }}</strong>
                </div>
                <div class="mt-0.5 text-text-muted">
                  {{ pair.language }} · 公共指纹 {{ pair.shared_fingerprints }} / {{ pair.fingerprint_count_a }} · {{ pair.fingerprint_count_b }}
                </div>
              </div>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :to="`/admin/submissions?highlight=${pair.submission_b_id}`"
              >
                查看提交详情
              </UButton>
            </div>
          </div>
          <p v-else-if="!similarLoading" class="py-12 text-center text-sm text-text-muted">
            当前阈值下没有相似提交对
          </p>
        </div>
```

- [ ] **Step 3: 加限流豁免白名单说明（如门禁要求）**

Run: `deno run -A scripts/check-write-rate-limits.ts`
Expected: PASS（本任务只加 GET，无写路由；若报未登记项，按脚本提示在 `dev-docs/engineering/write-rate-limit-matrix.md` 登记）

- [ ] **Step 4: 手工验收**

前置：`cd noj-core && deno task dev`；`cd noj-ui && deno task dev`。
造数：建一场已结束的竞赛，同一题放两份高度相似的提交（可复制同一份代码用两个账号提交）。

Expected:
1. 进 `/admin/contests` → 点某场竞赛的盾牌图标 → 弹窗出现两个 tab；
2. 切到"相似提交" → 出现成对记录与相似度数值；
3. 拖动阈值滑杆到 0.99 → 列表变空并显示"没有相似提交对"；
4. 覆盖率行显示"比较 X 份 / 候选 Y 份，跳过 Z 份"。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): 竞赛风控面板新增相似提交分栏"
jj new
```

---

# W2：题目数据洞察

### Task 3: 题目暴露判定（共享依赖）

**Files:**
- Create: `noj-core/src/domains/contest/services/problem-exposure.ts`
- Modify: `noj-core/src/domains/contest/index.ts`（追加导出）
- Test: `noj-core/src/domains/contest/tests/services/problem-exposure.test.ts`（新建）

**Interfaces:**
- Consumes: `contestProblems`、`contests`（`shared/db/schema.ts`）
- Produces:
  - `isProblemInRunningContest(problemId: string): Promise<boolean>`
  - `filterProblemsInRunningContest(problemIds: string[]): Promise<Set<string>>`

- [ ] **Step 1: 写失败测试**

新建 `noj-core/src/domains/contest/tests/services/problem-exposure.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import {
  createContest,
  deleteContest,
  filterProblemsInRunningContest,
  isProblemInRunningContest,
} from "../../index.ts";

await resetDbForTest();

async function createUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `暴露判定测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createContestWithWindow(
  startOffsetMs: number,
  endOffsetMs: number,
  problemIds: string[],
  creatorId: string,
): Promise<string> {
  const contest = await createContest({
    title: `暴露判定 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    start_time: new Date(Date.now() + startOffsetMs).toISOString(),
    end_time: new Date(Date.now() + endOffsetMs).toISOString(),
    type: "kaggle",
    problems: problemIds.map((problemId, index) => ({
      problem_id: problemId,
      label: String.fromCharCode(65 + index),
      sort_order: index,
      score: 10000,
    })),
  }, creatorId, true);
  return contest.id;
}

Deno.test({
  name: "problem-exposure: running 竞赛内的题目被标记为暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-1");
    const problemId = await createProblem(930001);
    const contestId = await createContestWithWindow(-60_000, 60_000, [problemId], creatorId);
    try {
      assertEquals(await isProblemInRunningContest(problemId), true);
    } finally {
      await deleteContest(contestId).catch(() => {});
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "problem-exposure: pending 与 ended 竞赛不算暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-2");
    const pendingProblem = await createProblem(930002);
    const endedProblem = await createProblem(930003);
    const pendingContest = await createContestWithWindow(60_000, 120_000, [pendingProblem], creatorId);
    const endedContest = await createContestWithWindow(-120_000, -60_000, [endedProblem], creatorId);
    try {
      assertEquals(await isProblemInRunningContest(pendingProblem), false);
      assertEquals(await isProblemInRunningContest(endedProblem), false);
    } finally {
      await deleteContest(pendingContest).catch(() => {});
      await deleteContest(endedContest).catch(() => {});
      await getDb().delete(problems).where(eq(problems.id, pendingProblem));
      await getDb().delete(problems).where(eq(problems.id, endedProblem));
      await getDb().delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "problem-exposure: 不在任何竞赛的题目不算暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await createProblem(930004);
    try {
      assertEquals(await isProblemInRunningContest(problemId), false);
      assertEquals((await filterProblemsInRunningContest([problemId])).size, 0);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
    }
  },
});

Deno.test({
  name: "problem-exposure: 批量判定只返回处于进行中竞赛的题目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-3");
    const exposed = await createProblem(930005);
    const quiet = await createProblem(930006);
    const contestId = await createContestWithWindow(-60_000, 60_000, [exposed], creatorId);
    try {
      const result = await filterProblemsInRunningContest([exposed, quiet]);
      assertEquals(result.has(exposed), true);
      assertEquals(result.has(quiet), false);
      assertEquals(result.size, 1);
    } finally {
      await deleteContest(contestId).catch(() => {});
      await getDb().delete(problems).where(eq(problems.id, exposed));
      await getDb().delete(problems).where(eq(problems.id, quiet));
      await getDb().delete(users).where(eq(users.id, creatorId));
    }
  },
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain contest`
Expected: FAIL —— `isProblemInRunningContest` 未定义 / 未从 `../../index.ts` 导出

- [ ] **Step 3: 实现判定模块**

新建 `noj-core/src/domains/contest/services/problem-exposure.ts`：

```ts
/**
 * 题目暴露判定：题目当前是否处于「进行中竞赛」的题目集内。
 *
 * 供读路径门控复用（题解赛期隐藏、通过率赛中隐藏）。
 *
 * 设计取舍：**不使用缓存、不引入调度任务**。时间窗口实时比较，
 * 竞赛开始/结束无需任何状态翻转动作，因此不新增进程内可变状态
 * （见 dev-docs/engineering/domain-boundaries.md 多副本约束表）。
 */
import { and, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contests, contestProblems } from "./../../../shared/db/schema.ts";

/** 返回给定题目中，处于进行中竞赛的题目 id 集合。 */
export async function filterProblemsInRunningContest(
  problemIds: string[],
): Promise<Set<string>> {
  if (problemIds.length === 0) return new Set();
  const nowIso = new Date().toISOString();
  const rows = await getDb()
    .selectDistinct({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .innerJoin(contests, eqContest())
    .where(and(
      inArray(contestProblems.problem_id, problemIds),
      lte(contests.start_time, nowIso),
      gt(contests.end_time, nowIso),
    ));
  return new Set(rows.map((row) => row.problem_id));
}

/** 单题版本：该题当前是否处于进行中竞赛的题目集内。 */
export async function isProblemInRunningContest(
  problemId: string,
): Promise<boolean> {
  const result = await filterProblemsInRunningContest([problemId]);
  return result.has(problemId);
}

/** 竞赛与题目关联的连接条件（独立函数便于阅读，避免行内 SQL 片段重复）。 */
function eqContest() {
  return sqlEq(contestProblems.contest_id, contests.id);
}
```

**注意**：上面最后的 `eqContest`/`sqlEq` 是为了可读性，实际实现请直接用 drizzle 的 `eq`，把 `.innerJoin(contests, eq(contestProblems.contest_id, contests.id))` 写进查询，并删除这两个辅助函数。最终实现应为：

```ts
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { contests, contestProblems } from "./../../../shared/db/schema.ts";

export async function filterProblemsInRunningContest(
  problemIds: string[],
): Promise<Set<string>> {
  if (problemIds.length === 0) return new Set();
  const nowIso = new Date().toISOString();
  const rows = await getDb()
    .selectDistinct({ problem_id: contestProblems.problem_id })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      inArray(contestProblems.problem_id, problemIds),
      lte(contests.start_time, nowIso),
      gt(contests.end_time, nowIso),
    ));
  return new Set(rows.map((row) => row.problem_id));
}

export async function isProblemInRunningContest(
  problemId: string,
): Promise<boolean> {
  const result = await filterProblemsInRunningContest([problemId]);
  return result.has(problemId);
}
```

- [ ] **Step 4: 从门面导出**

在 `noj-core/src/domains/contest/index.ts` 末尾追加：

```ts
export {
  filterProblemsInRunningContest,
  isProblemInRunningContest,
} from "./services/problem-exposure.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain contest`
Expected: PASS（4 个新用例全绿）

- [ ] **Step 6: 校验域边界**

Run: `cd noj-core && deno run -A ../scripts/check-domains.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(core): 新增题目暴露判定（进行中竞赛题目集）"
jj new
```

---

### Task 4: 统计聚合服务

**Files:**
- Create: `noj-core/src/domains/catalog/services/problems/problems-stats.ts`
- Test: `noj-core/src/domains/catalog/tests/services/problems-stats.test.ts`（新建）

**Interfaces:**
- Consumes: `submissions`、`evaluationResults`（`shared/db/schema.ts`）；`isProblemInRunningContest`（`contest/index.ts`）
- Produces:
  - `export interface PublicProblemStats { attempt_count: number; submit_count: number; accepted_count: number; acceptance_rate: number | null; suppressed_reason: "running_contest" | null }`
  - `export interface ProblemStatsDetail extends PublicProblemStats { status_distribution: Record<string, number>; case_failure_distribution: Array<{ case_id: string; failed: number; hidden: boolean }>; first_ac_median_ms: number | null; sample_size: number; truncated: boolean; window_days: number }`
  - `getPublicProblemStats(problemId: string): Promise<PublicProblemStats>`
  - `getProblemStatsDetail(problemId: string, windowDays?: number): Promise<ProblemStatsDetail>`
  - `_resetProblemStatsCacheForTest(): void`

**关键口径（不可偏离）：**
- 只统计 `submissions.status = 'finished'` 且有 `evaluation_results` 行的提交
- AC 判定：`evaluation_results.status = 'finished'` 且 `score > 0`
- 隐藏用例判定必须复用 `hidden === true || visibility === "hidden"`。**隐藏用例只进匿名聚合桶**（`hidden-1`、`hidden-2`…），不得返回真实 `case_id`
- 取数上限 2000 条，超出返回 `truncated: true`（不静默截断）

- [ ] **Step 1: 写失败测试**

新建 `noj-core/src/domains/catalog/tests/services/problems-stats.test.ts`：

```ts
import { assertEquals } from "jsr:@assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  _resetProblemStatsCacheForTest,
  getProblemStatsDetail,
  getPublicProblemStats,
} from "../../index.ts";

await resetDbForTest();

async function seedProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `统计测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedSubmission(
  problemId: string,
  userId: string,
  score: number,
  details: unknown,
  status = "finished",
): Promise<void> {
  const submissionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    language: "python3",
    code: "print(1)",
    status,
    created_at: now,
  });
  await getDb().insert(evaluationResults).values({
    id: crypto.randomUUID(),
    submission_id: submissionId,
    status: status === "finished" ? "finished" : "error",
    score,
    output: "",
    details: JSON.stringify(details),
    created_at: now,
  });
}

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "problems-stats: 通过率与服务层聚合（含隐藏用例匿名化）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const problemId = await seedProblem(940001);
    const alice = await seedUser("ps-alice");
    const bob = await seedUser("ps-bob");
    try {
      await seedSubmission(problemId, alice, 10000, {
        cases: [
          { case_id: "case-01", status: "Accepted", hidden: false },
          { case_id: "secret-01", status: "WrongAnswer", hidden: true },
        ],
      });
      await seedSubmission(problemId, bob, 0, {
        cases: [
          { case_id: "case-01", status: "WrongAnswer", hidden: false },
          { case_id: "secret-01", status: "WrongAnswer", hidden: true },
        ],
      });

      const publicStats = await getPublicProblemStats(problemId);
      assertEquals(publicStats.submit_count, 2);
      assertEquals(publicStats.accepted_count, 1);
      assertEquals(publicStats.acceptance_rate, 0.5);
      assertEquals(publicStats.suppressed_reason, null);

      const detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.sample_size, 2);
      assertEquals(detail.truncated, false);
      // 可见用例出真实 id
      assertEquals(
        detail.case_failure_distribution.some((c) => c.case_id === "case-01" && !c.hidden),
        true,
      );
      // 隐藏用例只进匿名桶，真实 id 绝不出现
      assertEquals(
        detail.case_failure_distribution.some((c) => c.hidden),
        true,
      );
      const serialized = JSON.stringify(detail.case_failure_distribution);
      assertEquals(serialized.includes("secret-01"), false);
    } finally {
      await getDb().delete(evaluationResults).where(
        eq(evaluationResults.submission_id, submissions.id),
      ).catch(() => {});
      await getDb().delete(submissions).where(eq(submissions.problem_id, problemId));
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, alice));
      await getDb().delete(users).where(eq(users.id, bob));
    }
  },
});

Deno.test({
  name: "problems-stats: 中位数与空集边界",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const emptyProblem = await seedProblem(940002);
    try {
      const detail = await getProblemStatsDetail(emptyProblem);
      assertEquals(detail.first_ac_median_ms, null);
      assertEquals(detail.accepted_count, 0);
      assertEquals(detail.acceptance_rate, 0);
      assertEquals(detail.sample_size, 0);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, emptyProblem));
    }
  },
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain catalog`
Expected: FAIL —— `getProblemStatsDetail` 未导出

- [ ] **Step 3: 实现聚合服务**

新建 `noj-core/src/domains/catalog/services/problems/problems-stats.ts`：

```ts
/**
 * 题目统计聚合：公开通过率 + 出题人数据洞察。
 *
 * 口径约定（spec §5.4/§5.5）：
 * - 仅统计 finished 且有评测结果的提交；
 * - 隐藏用例只进匿名聚合桶（hidden-1、hidden-2…），**绝不返回真实 case_id**；
 * - 取数上限 2000 条，超出返回 truncated=true（不静默截断）。
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  evaluationResults,
  submissions,
} from "./../../../../shared/db/schema.ts";
import { isProblemInRunningContest } from "./../../../contest/index.ts";

/** 单次聚合的提交样本上限。 */
export const MAX_STATS_SAMPLE = 2000;

/** 统计缓存的默认有效期（毫秒）。 */
export const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

/** 公开统计：所有登录/匿名用户可见（赛中进行中的题目隐藏通过率）。 */
export interface PublicProblemStats {
  attempt_count: number;
  submit_count: number;
  accepted_count: number;
  acceptance_rate: number | null;
  suppressed_reason: "running_contest" | null;
}

/** 出题人统计：仅题目 owner 与管理员可见。 */
export interface ProblemStatsDetail extends PublicProblemStats {
  status_distribution: Record<string, number>;
  case_failure_distribution: Array<{
    case_id: string;
    failed: number;
    hidden: boolean;
  }>;
  first_ac_median_ms: number | null;
  sample_size: number;
  truncated: boolean;
  window_days: number;
}

/**
 * 进程内统计缓存（5 分钟）。
 * **单副本专用**：多副本部署下各副本各自缓存，读到的可能是 5 分钟内的旧值。
 * 已登记于 dev-docs/engineering/domain-boundaries.md 多副本约束表。
 */
const statsCache = new Map<string, { at: number; value: ProblemStatsDetail }>();

/** 测试用：清空统计缓存，避免用例间互相污染。 */
export function _resetProblemStatsCacheForTest(): void {
  statsCache.clear();
}

/** 判定用例是否为隐藏用例（与 submission-projection 保持同一口径）。 */
function isHiddenCase(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.hidden === true) return true;
  return record.visibility === "hidden";
}

/** 计算中位数（偶数个样本取中间两数均值）。 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * 拉取题目统计样本并按窗口聚合。
 * @param problemId 题目 UUID。
 * @param windowDays 统计窗口天数；默认 90。
 */
export async function getProblemStatsDetail(
  problemId: string,
  windowDays = 90,
): Promise<ProblemStatsDetail> {
  const cached = statsCache.get(problemId);
  if (cached && Date.now() - cached.at < STATS_CACHE_TTL_MS && cached.value.window_days === windowDays) {
    return cached.value;
  }

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  // 只取 AC 时间戳所需的字段 + details，避免把 code 一起拉回
  const rows = await db
    .select({
      user_id: submissions.user_id,
      created_at: submissions.created_at,
      status: evaluationResults.status,
      score: evaluationResults.score,
      details: evaluationResults.details,
    })
    .from(submissions)
    .innerJoin(evaluationResults, eq(evaluationResults.submission_id, submissions.id))
    .where(and(
      eq(submissions.problem_id, problemId),
      eq(submissions.status, "finished"),
      gte(submissions.created_at, since),
    ))
    .orderBy(desc(submissions.created_at))
    .limit(MAX_STATS_SAMPLE + 1);

  const truncated = rows.length > MAX_STATS_SAMPLE;
  const sample = truncated ? rows.slice(0, MAX_STATS_SAMPLE) : rows;

  const statusDistribution: Record<string, number> = {};
  const caseFailures = new Map<string, { failed: number; hidden: boolean }>();
  const acByUser = new Map<string, number>();
  const hiddenAliases = new Map<string, string>();
  let acceptedCount = 0;

  for (const row of sample) {
    const status = row.status ?? "unknown";
    statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
    if (row.status === "finished" && row.score > 0) {
      acceptedCount += 1;
      const previous = acByUser.get(row.user_id);
      const elapsed = Date.parse(row.created_at);
      if (previous === undefined || elapsed < previous) {
        acByUser.set(row.user_id, elapsed);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const cases = (parsed as { cases?: unknown }).cases;
    if (!Array.isArray(cases)) continue;
    for (const entry of cases) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const caseStatus = typeof record.status === "string" ? record.status : "";
      if (caseStatus === "Accepted") continue;
      const hidden = isHiddenCase(entry);
      let key: string;
      if (hidden) {
        // 隐藏用例匿名化：按首次出现顺序分配稳定别名，绝不暴露真实 case_id
        const realId = typeof record.case_id === "string" ? record.case_id : `unknown-${caseFailures.size}`;
        const alias = hiddenAliases.get(realId) ?? `hidden-${hiddenAliases.size + 1}`;
        hiddenAliases.set(realId, alias);
        key = alias;
      } else {
        key = typeof record.case_id === "string" ? record.case_id : `unknown-${caseFailures.size}`;
      }
      const current = caseFailures.get(key);
      if (current) current.failed += 1;
      else caseFailures.set(key, { failed: 1, hidden });
    }
  }

  const attemptUsers = new Set(sample.map((row) => row.user_id));
  const firstAcDurations: number[] = [];
  const firstSubmissionByUser = new Map<string, number>();
  for (const row of [...sample].reverse()) {
    const elapsed = Date.parse(row.created_at);
    if (!firstSubmissionByUser.has(row.user_id)) {
      firstSubmissionByUser.set(row.user_id, elapsed);
    }
  }
  for (const [userId, acAt] of acByUser) {
    const firstAt = firstSubmissionByUser.get(userId);
    if (firstAt !== undefined && acAt >= firstAt) {
      firstAcDurations.push(acAt - firstAt);
    }
  }

  const value: ProblemStatsDetail = {
    attempt_count: attemptUsers.size,
    submit_count: sample.length,
    accepted_count: acceptedCount,
    acceptance_rate: sample.length === 0 ? 0 : acceptedCount / sample.length,
    suppressed_reason: null,
    status_distribution: statusDistribution,
    case_failure_distribution: [...caseFailures.entries()]
      .map(([case_id, info]) => ({ case_id, failed: info.failed, hidden: info.hidden }))
      .sort((a, b) => b.failed - a.failed),
    first_ac_median_ms: median(firstAcDurations),
    sample_size: sample.length,
    truncated,
    window_days: windowDays,
  };

  statsCache.set(problemId, { at: Date.now(), value });
  return value;
}

/** 公开统计：赛中进行中的题目隐藏通过率（避免泄露难度先验）。 */
export async function getPublicProblemStats(
  problemId: string,
): Promise<PublicProblemStats> {
  const detail = await getProblemStatsDetail(problemId);
  const suppressed = await isProblemInRunningContest(problemId);
  return {
    attempt_count: detail.attempt_count,
    submit_count: detail.submit_count,
    accepted_count: detail.accepted_count,
    acceptance_rate: suppressed ? null : detail.acceptance_rate,
    suppressed_reason: suppressed ? "running_contest" : null,
  };
}
```

- [ ] **Step 4: 从 catalog 门面导出**

在 `noj-core/src/domains/catalog/index.ts` 追加（若使用显式导出清单，则加入对应条目）：

```ts
export {
  _resetProblemStatsCacheForTest,
  getProblemStatsDetail,
  getPublicProblemStats,
  median,
  MAX_STATS_SAMPLE,
  STATS_CACHE_TTL_MS,
  type ProblemStatsDetail,
  type PublicProblemStats,
} from "./services/problems/problems-stats.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS

- [ ] **Step 6: 登记多副本约束**

在 `dev-docs/engineering/domain-boundaries.md` 的「多副本约束」表追加一行：

```markdown
| `domains/catalog/services/problems/problems-stats.ts` | 题目统计缓存 `statsCache`（5 分钟 TTL） | 各副本各自缓存，最多 5 分钟内读到旧统计 | 单副本专用（TTL 兜底） |
```

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(core): 题目统计聚合（公开通过率 + 用例失败分布）"
jj new
```

---

### Task 5: 统计路由

**Files:**
- Modify: `noj-core/src/domains/catalog/routes/problems.ts`（在 `/:id/template` 路由之后，约 `:468`）
- Test: `noj-core/src/domains/catalog/tests/routes/problems-stats.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `getPublicProblemStats`、`getProblemStatsDetail`
- Produces: `GET /api/v1/problems/:id/stats/public`、`GET /api/v1/problems/:id/stats`

**权限规则：**
- `/stats/public`：`optionalAuthMiddleware`，任何人可读
- `/stats`：`authMiddleware`；仅题目 `owner_id === userId` 或 `admin:full_access`，否则 403
- **路由注册顺序**：两条都必须在 `router.get("/:id", ...)` 之后注册，且 `/stats/public` 必须先于 `/stats`（Hono 前缀匹配）

- [ ] **Step 1: 写失败测试**

新建 `noj-core/src/domains/catalog/tests/routes/problems-stats.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { problemsRouter } from "../../routes/problems.ts";

await resetDbForTest();

async function seedProblem(ownerId: string, number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `统计路由测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "problems-stats route: 公开端点匿名可读",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await seedUser("psr-owner");
    const problemId = await seedProblem(owner, 950001);
    try {
      const res = await problemsRouter.request(`/${problemId}/stats/public`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(typeof body.data.submit_count, "number");
      assertEquals(body.data.acceptance_rate, 0);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, owner));
    }
  },
});

Deno.test({
  name: "problems-stats route: 深度端点未登录返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await seedUser("psr-owner-2");
    const problemId = await seedProblem(owner, 950002);
    try {
      const res = await problemsRouter.request(`/${problemId}/stats`);
      assertEquals(res.status === 401 || res.status === 403, true);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, owner));
    }
  },
});
```

（在文件顶部补 `import { eq } from "drizzle-orm";`）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain catalog`
Expected: FAIL —— 404（路由不存在）

- [ ] **Step 3: 加路由**

在 `noj-core/src/domains/catalog/routes/problems.ts` 的 `/:id/template` 路由之后插入：

```ts
/**
 * 题目公开统计：通过率对所有人可见，赛中进行中的题目隐藏通过率。
 * GET /api/v1/problems/:id/stats/public
 */
router.get("/:id/stats/public", optionalAuthMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  return c.json({ data: await getPublicProblemStats(problem.id) });
});

/**
 * 题目深度统计：状态分布与用例失败分布，仅题目 owner 与管理员可见。
 * GET /api/v1/problems/:id/stats
 */
router.get("/:id/stats", authMiddleware, async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  const userId = c.get("userId") as string;
  const isAdmin = (await resolvePermissions(c)).has(ADMIN_FULL_ACCESS);
  if (!isAdmin && problem.owner_id !== userId) {
    throw new ForbiddenError("无权查看该题目的统计数据");
  }
  const windowDays = Number(c.req.query("window_days") ?? 90);
  const safeWindow = Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365
    ? windowDays
    : 90;
  return c.json({ data: await getProblemStatsDetail(problem.id, safeWindow) });
});
```

在文件顶部的 import 中补齐（按实际已有项去重）：

```ts
import { ForbiddenError } from "../../../shared/base/errors.ts";
import {
  getProblemStatsDetail,
  getPublicProblemStats,
} from "../index.ts";
```

并确认 `resolvePermissions`、`ADMIN_FULL_ACCESS`、`authMiddleware`、`optionalAuthMiddleware` 已 import（该文件 `:36` 一带已有 `assertPermission` 等，按需补 `resolvePermissions` 与 `ADMIN_FULL_ACCESS`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain catalog`
Expected: PASS

- [ ] **Step 5: 校验路由目录与限流**

Run:
```bash
deno run -A scripts/gen-route-catalog.ts --check || deno run -A scripts/gen-route-catalog.ts
deno run -A scripts/check-write-rate-limits.ts
```
Expected: PASS（本任务只加 GET）

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): 新增题目公开与深度统计路由"
jj new
```

---

### Task 6: 前端统计展示

**Files:**
- Create: `noj-ui/composables/useProblemStats.ts`
- Create: `noj-ui/components/admin/ProblemStatsPanel.vue`
- Modify: `noj-ui/pages/problems/[id].vue`（公开通过率）
- Modify: `noj-ui/components/editor/CodingProblemEditor.vue`（编辑页"数据"分区）

**Interfaces:**
- Consumes: `GET /api/v1/problems/:id/stats/public`、`GET /api/v1/problems/:id/stats`
- Produces:
  - `export interface PublicProblemStats`、`export interface ProblemStatsDetail`
  - `useProblemStats()` → `{ fetchPublic(problemId), fetchDetail(problemId, windowDays?) }`
  - `<ProblemStatsPanel :stats="detail" />` 组件

- [ ] **Step 1: 加类型与 composable**

新建 `noj-ui/composables/useProblemStats.ts`：

```ts
export interface PublicProblemStats {
  attempt_count: number;
  submit_count: number;
  accepted_count: number;
  acceptance_rate: number | null;
  suppressed_reason: 'running_contest' | null;
}

export interface ProblemStatsDetail extends PublicProblemStats {
  status_distribution: Record<string, number>;
  case_failure_distribution: Array<{
    case_id: string;
    failed: number;
    hidden: boolean;
  }>;
  first_ac_median_ms: number | null;
  sample_size: number;
  truncated: boolean;
  window_days: number;
}

/** 题目统计获取：公开通过率与出题人深度统计。 */
export function useProblemStats() {
  const { api } = useApi();

  function fetchPublic(problemId: string) {
    return api.get<{ data: PublicProblemStats }>(
      `/api/v1/problems/${problemId}/stats/public`,
      { silent: true },
    );
  }

  function fetchDetail(problemId: string, windowDays = 90) {
    return api.get<{ data: ProblemStatsDetail }>(
      `/api/v1/problems/${problemId}/stats`,
      { query: { window_days: windowDays }, silent: true },
    );
  }

  return { fetchPublic, fetchDetail };
}
```

- [ ] **Step 2: 写展示组件**

新建 `noj-ui/components/admin/ProblemStatsPanel.vue`：

```vue
<script setup lang="ts">
import type { ProblemStatsDetail } from '~/composables/useProblemStats'

defineProps<{ stats: ProblemStatsDetail }>()

/** 状态分布按次数降序，便于一眼看出主要失败原因。 */
function sortedStatus(entry: Record<string, number>) {
  return Object.entries(entry).sort((a, b) => b[1] - a[1])
}

/** 用例失败分布取前 10，横向条形按最大失败数归一化。 */
function topCases(entry: ProblemStatsDetail['case_failure_distribution']) {
  return entry.slice(0, 10)
}

function barWidth(failed: number, list: ProblemStatsDetail['case_failure_distribution']) {
  const max = Math.max(1, ...list.map((item) => item.failed))
  return `${Math.max(4, Math.round((failed / max) * 100))}%`
}
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">尝试人数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.attempt_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">提交数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.submit_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">通过数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.accepted_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">首次通过中位耗时</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">
          {{ stats.first_ac_median_ms === null ? '—' : `${(stats.first_ac_median_ms / 1000).toFixed(1)}s` }}
        </div>
      </div>
    </div>

    <p v-if="stats.truncated" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      样本已达上限（最近 {{ stats.window_days }} 天），实际数据更多。
    </p>
    <p class="text-xs text-text-muted">
      基于最近 {{ stats.window_days }} 天的 {{ stats.sample_size }} 次提交。
    </p>

    <section>
      <h3 class="text-sm font-semibold text-text">评测状态分布</h3>
      <div v-if="sortedStatus(stats.status_distribution).length" class="mt-2 space-y-1">
        <div v-for="[status, count] in sortedStatus(stats.status_distribution)" :key="status" class="flex items-center justify-between text-xs">
          <span class="text-text-secondary">{{ status }}</span>
          <span class="font-mono tabular-nums text-text">{{ count }}</span>
        </div>
      </div>
      <p v-else class="mt-2 text-xs text-text-muted">暂无数据</p>
    </section>

    <section>
      <h3 class="text-sm font-semibold text-text">用例失败分布</h3>
      <p class="mt-1 text-xs text-text-muted">显示失败次数最多的用例；隐藏用例已匿名化。</p>
      <div v-if="topCases(stats.case_failure_distribution).length" class="mt-3 space-y-2">
        <div v-for="item in topCases(stats.case_failure_distribution)" :key="item.case_id">
          <div class="flex items-center justify-between text-xs">
            <code class="font-mono" :class="item.hidden ? 'text-text-muted italic' : 'text-text'">{{ item.case_id }}</code>
            <span class="font-mono tabular-nums text-text-secondary">{{ item.failed }}</span>
          </div>
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              class="h-full rounded-full"
              :class="item.hidden ? 'bg-border' : 'bg-signal'"
              :style="{ width: barWidth(item.failed, stats.case_failure_distribution) }"
            />
          </div>
        </div>
      </div>
      <p v-else class="mt-2 text-xs text-text-muted">暂无数据</p>
    </section>
  </div>
</template>
```

> **文案说明**：该组件与其使用者（`CodingProblemEditor.vue`）均硬编码中文，未接入 i18n，故此处直接写中文。

- [ ] **Step 3: 编辑页接入"数据"分区**

在 `noj-ui/components/editor/CodingProblemEditor.vue` 的 `<script setup>` 加：

```ts
const { fetchDetail } = useProblemStats()
const statsDetail = ref<ProblemStatsDetail | null>(null)
const statsLoading = ref(false)
const statsError = ref('')

async function loadStats() {
  if (!props.problemId) return
  statsLoading.value = true
  statsError.value = ''
  try {
    const res = await fetchDetail(props.problemId)
    statsDetail.value = res.data
  } catch (e) {
    statsError.value = extractApiError(e).message
    statsDetail.value = null
  } finally {
    statsLoading.value = false
  }
}
```

加 import：

```ts
import { useProblemStats, type ProblemStatsDetail } from '~/composables/useProblemStats'
import { extractApiError } from '~/utils/apiError'
```

在模板最后一个 `<section>`（`:639` 结束的那段）之后追加：

```html
    <section v-if="isEditMode" class="px-6 py-5 border-b border-border last:border-b-0">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-semibold text-text">题目数据</h3>
        <UButton size="sm" color="neutral" variant="outline" :loading="statsLoading" @click="loadStats">
          {{ statsDetail ? '刷新' : '加载数据' }}
        </UButton>
      </div>
      <p v-if="statsError" class="mt-2 text-sm text-error-text">{{ statsError }}</p>
      <div v-if="statsDetail" class="mt-4">
        <ProblemStatsPanel :stats="statsDetail" />
      </div>
      <p v-else-if="!statsLoading && !statsError" class="mt-2 text-xs text-text-muted">
        点击"加载数据"查看本题的评测统计
      </p>
    </section>
```

- [ ] **Step 4: 题目页显示公开通过率**

在 `noj-ui/pages/problems/[id].vue` 的 `<script setup>` 加：

```ts
const { fetchPublic } = useProblemStats()
const publicStats = ref<PublicProblemStats | null>(null)

/** 公开通过率展示文案：赛中隐藏时给出原因，无提交时显示占位。 */
const acceptanceText = computed(() => {
  const stats = publicStats.value
  if (!stats) return null
  if (stats.suppressed_reason === 'running_contest') return '竞赛进行中，暂不显示通过率'
  if (stats.submit_count === 0) return '暂无通过记录'
  return `通过率 ${((stats.acceptance_rate ?? 0) * 100).toFixed(1)}% · ${stats.accepted_count}/${stats.submit_count}`
})
```

在已有 `watch(problem, ...)` 内、`loadingSolutions` 处理之后追加拉取：

```ts
    try {
      const statsRes = await fetchPublic(p.id)
      publicStats.value = statsRes.data
    } catch {
      publicStats.value = null
    }
```

在题目信息区（题目标题/难度附近）加入展示：

```html
        <p v-if="acceptanceText" class="mt-1 text-xs text-text-secondary">{{ acceptanceText }}</p>
```

补齐 import：

```ts
import { useProblemStats, type PublicProblemStats } from '~/composables/useProblemStats'
```

- [ ] **Step 5: 校验**

Run:
```bash
cd noj-ui && deno task lint && deno task test
```
Expected: PASS

- [ ] **Step 6: 手工验收**

Expected:
1. 匿名打开题目页 → 显示"通过率 X% · AC/提交"；
2. 把该题加入一场进行中的竞赛后再打开 → 显示"竞赛进行中，暂不显示通过率"；
3. 题目 owner 打开 `/admin/problem-edit/<id>` → 点"数据" → 显示四项指标、状态分布、用例失败分布；
4. 用例失败分布中隐藏用例显示为 `hidden-N` 斜体，**不出现真实用例名**。

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(ui): 题目统计数据展示（公开通过率 + 出题人数据面板）"
jj new
```

---

# W3：官方题解 + 赛后复盘 + 堵剧透

### Task 7: `is_official` 迁移与官方题解能力

**Files:**
- Modify: `noj-core/src/shared/db/schema/community.ts`（`communityPosts` 定义，`:57-130`）
- Create: `noj-core/drizzle/00XX_*.sql`（由 `db:generate` 生成）
- Modify: `noj-core/src/domains/community/services/community/community-post-crud.ts`（创建时接受官方标记 + 权限校验）
- Modify: `noj-core/src/domains/community/types/community.ts`（`CommunityPostInput` 加字段）
- Modify: `noj-core/src/domains/community/services/community/community-post-list.ts`（排序官方优先）
- Test: `noj-core/src/domains/community/tests/services/community-official.test.ts`（新建）

**Interfaces:**
- Produces: `is_official` 列；`CommunityPostInput.is_official?: boolean`；`setPostOfficial(postId, actorId, moderator, value)`；列表排序 `is_official DESC`
- Consumes: `resolveProblemAccess` 的 owner 判定路径（catalog 门面）

**权限规则**：设置官方标记需 题目 owner（`problems.owner_id === actorId`）或 moderator。**服务层强制**，前端隐藏不作为保障。

- [ ] **Step 1: 改 schema**

在 `noj-core/src/shared/db/schema/community.ts` 的 `communityPosts` 列定义中，`is_pinned` 之后插入：

```ts
    /** 官方题解标记：由题目 owner 或审核员设置；题目页置顶展示。 */
    is_official: boolean("is_official").notNull().default(false),
```

在同表索引定义中追加：

```ts
    officialIdx: index("idx_community_posts_official").on(
      table.problem_id,
      table.is_official,
      table.created_at,
    ),
```

- [ ] **Step 2: 生成迁移**

Run: `cd noj-core && deno task db:generate`
Expected: 生成新的 `drizzle/00XX_*.sql`，内容含 `ADD COLUMN "is_official" boolean DEFAULT false NOT NULL` 与 `CREATE INDEX`

- [ ] **Step 3: 校验迁移安全**

Run: `deno run -A scripts/check-migration-safety.ts`
Expected: PASS（新列带 DEFAULT）

同时人工确认生成的 SQL **不含** `REFERENCES "public".` 前缀：

Run: `rg -n 'REFERENCES "public"\.' noj-core/drizzle/00XX_*.sql`
Expected: 无输出

- [ ] **Step 4: 写失败测试**

新建 `noj-core/src/domains/community/tests/services/community-official.test.ts`：

```ts
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { communityPosts, problems, users } from "../../../../shared/db/schema.ts";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import { createPost, listPosts, setPostOfficial } from "../../index.ts";
import { _resetSystemSettingsForTest, initSystemSettings, updateSetting, ensureRbacSeeds, enterTestContext, leaveTestContext } from "../../../system/index.ts";

const ownerId = "official-owner";
const otherId = "official-other";
const problemId = "official-problem";

async function setup(): Promise<void> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values([
    { id: ownerId, username: ownerId, email: `${ownerId}@example.com`, password_hash: "hash", created_at: now, updated_at: now },
    { id: otherId, username: otherId, email: `${otherId}@example.com`, password_hash: "hash", created_at: now, updated_at: now },
  ]);
  await getDb().insert(problems).values({
    id: problemId,
    title: "官方题解测试题",
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number: 960001,
    type: "U",
    visibility: "public",
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
}

Deno.test({
  name: "official: 题目 owner 可标记官方题解，非 owner 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await createPost(otherId, {
      type: "solution",
      title: "民间题解",
      content: "思路",
      problem_id: problemId,
    });

    await assertRejects(
      () => setPostOfficial(post.id, otherId, false, true),
      ForbiddenError,
    );

    await setPostOfficial(post.id, ownerId, false, true);
    const [row] = await getDb().select({ is_official: communityPosts.is_official })
      .from(communityPosts).where(eq(communityPosts.id, post.id));
    assertEquals(row?.is_official, true);
  },
});

Deno.test({
  name: "official: 官方题解在列表中排在前面",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const older = await createPost(otherId, {
      type: "solution", title: "较早的非官方题解", content: "A", problem_id: problemId,
    });
    const newer = await createPost(otherId, {
      type: "solution", title: "较晚的官方题解", content: "B", problem_id: problemId,
    });
    await setPostOfficial(newer.id, ownerId, false, true);

    const list = await listPosts({ type: "solution", problemId });
    assertEquals(list.data[0]?.post.id, newer.id);
    assertEquals(list.data[1]?.post.id, older.id);
  },
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain community`
Expected: FAIL —— `setPostOfficial` 未导出

- [ ] **Step 6: 实现服务层**

在 `noj-core/src/domains/community/types/community.ts` 的 `CommunityPostInput` 加：

```ts
  /** 请求标记为官方题解；服务层校验题目 owner 或 moderator 权限。 */
  is_official?: boolean;
```

在 `noj-core/src/domains/community/services/community/community-post-crud.ts` 追加：

```ts
/**
 * 设置/取消题解的官方标记。
 *
 * 权限：题目 owner 或审核员。服务层强制，前端隐藏不作为保障。
 *
 * @param postId 帖子 UUID。
 * @param actorId 操作用户 UUID。
 * @param moderator 是否为审核员。
 * @param value 目标标记值。
 * @throws {NotFoundError} 帖子或关联题目不存在。
 * @throws {ForbiddenError} 非题目 owner 且非审核员。
 * @throws {ValidationError} 帖子不是题解类型。
 */
export async function setPostOfficial(
  postId: string,
  actorId: string,
  moderator: boolean,
  value: boolean,
): Promise<void> {
  const post = await getPost(postId, actorId, moderator);
  if (post.post.type !== "solution") {
    throw new ValidationError("仅题解可标记为官方题解");
  }
  if (!moderator) {
    const db = getDb();
    const [problem] = await db.select({ owner_id: problems.owner_id })
      .from(problems)
      .where(eq(problems.id, post.post.problem_id!))
      .limit(1);
    if (!problem || problem.owner_id !== actorId) {
      throw new ForbiddenError("仅题目所有者可设置官方题解");
    }
  }
  await getDb().update(communityPosts)
    .set({ is_official: value, updated_at: nowIso() })
    .where(eq(communityPosts.id, postId));
}
```

（确认该文件已 import `problems`、`ValidationError`、`nowIso`；缺则补。）

在 `createPost` 的 `const post = { ... }` 对象中加入：

```ts
    is_official: input.is_official === true && (moderator || await isProblemOwner(authorId, input.problem_id)),
```

并新增该辅助函数（放在 `ensureSolutionAccepted` 之后）：

```ts
/** 判断用户是否为指定题目的所有者（用于官方题解标记的写入校验）。 */
async function isProblemOwner(
  userId: string,
  problemId: string | undefined,
): Promise<boolean> {
  if (!problemId) return false;
  const [problem] = await getDb().select({ owner_id: problems.owner_id })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  return problem?.owner_id === userId;
}
```

- [ ] **Step 7: 列表排序官方优先**

在 `noj-core/src/domains/community/services/community/community-post-list.ts` 的 `listPosts` 中，把 `.orderBy(...)` 改为：

```ts
  ).orderBy(
    desc(communityPosts.is_official),
    desc(communityPosts.is_pinned),
    desc(communityPosts.created_at),
  ).limit(limit + 1);
```

- [ ] **Step 8: 导出与运行测试**

在 `noj-core/src/domains/community/index.ts` 导出 `setPostOfficial`（若为显式清单）。

Run: `cd noj-core && deno task test:domain community`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
jj describe -m "feat(core): 题解支持官方标记（题目 owner 或审核员可设置）"
jj new
```

---

### Task 8: 赛期题解门控（读路径 + 发布入口）

**Files:**
- Modify: `noj-core/src/domains/community/services/community/community-post-list.ts`（`listPosts`、`countPostsByType`、`listBookmarks`）
- Modify: `noj-core/src/domains/community/services/community/community-post-crud.ts`（`getPost`）
- Modify: `noj-core/src/domains/community/services/community/community-feed.ts`（`listFeed`）
- Modify: `noj-core/src/domains/community/routes/community.ts`（eligibility）
- Test: `noj-core/src/domains/community/tests/services/community-solution-gating.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `filterProblemsInRunningContest`
- Produces: 门控生效的 5 条读路径 + `blocked_reason: "running_contest"`

**口径**：对"属于进行中竞赛的题目"，题解类帖子对**普通用户（含发布者本人）**不可见；`moderator === true` 时不受限（复核需要）。

- [ ] **Step 1: 写失败测试**

新建 `noj-core/src/domains/community/tests/services/community-solution-gating.test.ts`。基础 setup 复用 Task 7 的 `setup()` 写法（可复制），额外建一场进行中的竞赛：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { communityPosts, problems, users } from "../../../../shared/db/schema.ts";
import { createPost, getPost, listPosts, countPostsByType } from "../../index.ts";
import { createContest } from "../../../contest/index.ts";
import { _resetSystemSettingsForTest, initSystemSettings, updateSetting, ensureRbacSeeds, enterTestContext, leaveTestContext } from "../../../system/index.ts";

const testOwnerId = "gating-owner";
const testProblemId = "gating-problem";
const gatingProblemId = "gating-contest-problem";
let contestId = "";

async function setup(): Promise<void> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id: testOwnerId, username: testOwnerId, email: `${testOwnerId}@example.com`,
    password_hash: "hash", created_at: now, updated_at: now,
  });
  await getDb().insert(problems).values([
    { id: testProblemId, title: "普通题", description: "x", difficulty: "easy", runtime_config: {}, number: 970001, type: "U", visibility: "public", owner_id: testOwnerId, created_at: now, updated_at: now },
    { id: gatingProblemId, title: "竞赛题", description: "x", difficulty: "easy", runtime_config: {}, number: 970002, type: "U", visibility: "public", owner_id: testOwnerId, created_at: now, updated_at: now },
  ]);
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
  const contest = await createContest({
    title: `门控测试 ${Date.now()}`,
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
    type: "kaggle",
    problems: [{ problem_id: gatingProblemId, label: "A", sort_order: 0, score: 10000 }],
  }, testOwnerId, true);
  contestId = contest.id;
}

Deno.test({
  name: "solution gating: 赛期题解在列表与详情中均不可见，赛后恢复",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 绕过发布门槛：以 moderator 身份发布（moderator 不受 AC 门槛与门控限制）
    const normalPost = await createPost(testOwnerId, {
      type: "solution", title: "普通题题解", content: "A", problem_id: testProblemId,
    }, true);
    const gatedPost = await createPost(testOwnerId, {
      type: "solution", title: "竞赛题题解", content: "B", problem_id: gatingProblemId,
    }, true);

    // 赛期：普通用户视角
    const gatedList = await listPosts({ type: "solution", problemId: gatingProblemId });
    assertEquals(gatedList.data.length, 0);
    const normalList = await listPosts({ type: "solution", problemId: testProblemId });
    assertEquals(normalList.data.length, 1);

    // 发布者本人在赛期亦不可见（避免自视图侧信道）
    await assertRejects(
      () => getPost(gatedPost.id, testOwnerId, false),
      Error,
    );

    // 审核员例外
    const moderatorView = await listPosts({ type: "solution", problemId: gatingProblemId, moderator: true });
    assertEquals(moderatorView.data.length, 1);
  },
});
```

在文件顶部补 `import { assertRejects } from "jsr:@std/assert@^1";`

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain community`
Expected: FAIL —— 赛期列表返回 1 条（尚未门控）

- [ ] **Step 3: 实现门控 SQL 谓词**

在 `noj-core/src/domains/community/services/community/community-post-common.ts` 追加：

```ts
import { sql } from "drizzle-orm";

/**
 * 赛期题解门控谓词：排除"所属题目正在竞赛中"的题解帖子。
 *
 * 采用**相关子查询**而非"先查题目 id 再拼 IN 列表"：
 * - 不产生应用侧扫描，不受题量规模影响（IN 列表方案必须设上限，
 *   上限一旦被超出就会**静默漏掉**需要门控的题目——这是不可接受的失效模式）；
 * - 时间窗口在 SQL 内实时比较，竞赛结束后自动放行，无需调度。
 *
 * 返回的片段可直接 push 进 drizzle 的 conditions 数组。
 */
export function notGatedSolution() {
  return sql`NOT (
    ${communityPosts.type} = 'solution'
    AND ${communityPosts.problem_id} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE cp.problem_id = ${communityPosts.problem_id}
        AND c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND c.end_time > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )`;
}
```

**注意时间格式**：`contests.start_time` / `end_time` 是 ISO 8601 **文本**列。文本比较按字典序，因此必须用同格式串；`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` 生成的正是 `new Date().toISOString()` 的形状。实现后**必须**用 Step 1 的用例验证赛期与赛后两种状态，并额外验证边界（`start_time` 恰好等于当前时刻应算 running）。

- [ ] **Step 4: 在 5 条读路径接入**

**4a. `listPosts`**（`community-post-list.ts`）——在 `if (options.type)` 等条件构建之后、执行查询之前插入：

```ts
  // 赛期题解门控：进行中竞赛的题目，其题解对普通用户整体不可见（spec §6.2）
  if (!options.moderator) {
    conditions.push(notGatedSolution());
  }
```

（补齐 import：`notGatedSolution` from `./community-post-common.ts`。）

**4b. `getPost`**（`community-post-crud.ts`）——在现有 `if (row.post.status !== "published" ...)` 判断之后追加（单帖场景直接用单题判定，无需 SQL 谓词）：

```ts
  // 赛期题解门控：进行中竞赛的题解对普通用户（含作者本人）不可见
  if (!moderator && row.post.type === "solution" && row.post.problem_id) {
    if (await isProblemInRunningContest(row.post.problem_id)) {
      throw new NotFoundError("社区内容不存在");
    }
  }
```

（该方法**必须** import `isProblemInRunningContest` from `./../../../contest/index.ts`。注意 `getPost` 在 `community-post-crud.ts`，与 `listPosts` 所在文件不同。）

**4c. `countPostsByType`**（同文件）——在 `where(...)` 的条件中追加同一个谓词，把被门控的题解排除出 Tab 计数：

```ts
  const rows = await db.select({
    type: communityPosts.type,
    count: sql<number>`count(*)::int`,
  }).from(communityPosts).where(and(
    eq(communityPosts.status, "published"),
    inArray(communityPosts.type, enabledTypes),
    notGatedSolution(),
  )).groupBy(communityPosts.type);
```

**4d. `listBookmarks`**（`community-post-list.ts`）——在 `conditions` 构造后追加 `conditions.push(notGatedSolution());`（无条件追加，不走 moderator 分支：收藏列表属于"普通用户读自己的收藏"，审核员看内容走 `listPosts`）。

**4e. `listFeed`**（`community-feed.ts`）——`listFeed` 的帖子查询只返回 `type = 'moment'`（`community-feed.ts:71`），**不含题解**，无需改；但活动流会出现 `solution_published` 事件。该事件的 `target_id` 是 **post id**（不是 problem id），因此用相关子查询按帖子反查题目门控：

```ts
  // 赛期不展示"发布竞赛题题解"的动态（避免通过动态流泄露题解存在性）
  const notGatedSolutionActivity = sql`NOT (
    ${communityActivityEvents.type} = 'solution_published'
    AND EXISTS (
      SELECT 1 FROM community_posts p
      WHERE p.id = ${communityActivityEvents.target_id}
        AND p.type = 'solution'
        AND p.problem_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM contest_problems cp
          JOIN contests c ON c.id = cp.contest_id
          WHERE cp.problem_id = p.problem_id
            AND c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
            AND c.end_time > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
        )
    )
  )`;
```

把它 push 进活动流分支的 `conditions` 数组（该文件的活动流查询条件变量名以实际代码为准）。

**4f. `solutions/eligibility` 路由**（`community/routes/community.ts`）——在 `canCreate` 计算前加：

```ts
  const inRunningContest = await isProblemInRunningContest(problemId);
```

返回体加字段，并在门控期强制 `can_create: false`：

```ts
  return c.json({
    data: {
      enabled: config.solutions_enabled,
      requires_accepted: requiresAccepted,
      accepted,
      can_create: canCreate && !inRunningContest,
      blocked_reason: inRunningContest ? "running_contest" : null,
    },
  });
```

（该路由需 import `isProblemInRunningContest` from `../../contest/index.ts`。）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain community`
Expected: PASS

- [ ] **Step 6: 补赛后恢复用例**

在上面的测试文件追加一个用例：把竞赛 `end_time` 改到过去（`getDb().update(contests).set({ end_time: ... })`）后，`listPosts` 与 `getPost` 均恢复可见。

- [ ] **Step 7: 校验域边界**

Run: `deno run -A scripts/check-domains.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
jj describe -m "feat(core): 竞赛赛期题解门控（读路径与发布入口）"
jj new
```

---

### Task 9: 搜索路径门控

**Files:**
- Modify: `noj-core/src/domains/search/services/permission-filter.ts`
- Test: `noj-core/src/domains/search/tests/services/search-solution-gating.test.ts`（新建）

**Interfaces:**
- Produces: `runningContestSolutionWhere()` —— 自包含 SQL 谓词，排除进行中竞赛的题解条目

**要求**：谓词必须自包含（不依赖调用方传参），与既有 `permissionWhere` / `communityVisibilityWhere` 同构；`metadata` 中的 `post_type` / `problem_id` 已存在（`index-writer.ts:226-232`），**无需重建索引**。

- [ ] **Step 1: 写失败测试**

新建 `noj-core/src/domains/search/tests/services/search-solution-gating.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import { upsertSearchEntry, buildCommunityPostEntry } from "../../services/index-writer.ts";
import { searchFlat } from "../../services/search.ts";
import { createPost } from "../../../community/index.ts";
import { createContest } from "../../../contest/index.ts";
import { _resetSystemSettingsForTest, initSystemSettings, updateSetting, ensureRbacSeeds, enterTestContext, leaveTestContext } from "../../../system/index.ts";

Deno.test({
  name: "search: 赛期搜不到竞赛题题解，赛后能搜到",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const now = new Date().toISOString();
    const ownerId = "sg-owner";
    const problemId = "sg-problem";
    await getDb().insert(users).values({
      id: ownerId, username: ownerId, email: `${ownerId}@example.com`,
      password_hash: "hash", created_at: now, updated_at: now,
    });
    await getDb().insert(problems).values({
      id: problemId, title: "搜索门控题", description: "x", difficulty: "easy",
      runtime_config: {}, number: 980001, type: "U", visibility: "public",
      owner_id: ownerId, created_at: now, updated_at: now,
    });
    enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
    try {
      await updateSetting("community_enabled", true, "0");
      await updateSetting("community_new_user_review_hours", 0, "0");
    } finally {
      leaveTestContext();
    }

    const post = await createPost(ownerId, {
      type: "solution", title: "搜索门控题解", content: "独特关键词 ZZYZX", problem_id: problemId,
    }, true);
    await upsertSearchEntry((await buildCommunityPostEntry(post.id))!);

    const contest = await createContest({
      title: `搜索门控 ${Date.now()}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      problems: [{ problem_id: problemId, label: "A", sort_order: 0, score: 10000 }],
    }, ownerId, true);

    // 赛期：普通用户搜不到
    const duringContest = await searchFlat({
      q: "ZZYZX", page: 1, perPage: 20,
      ctx: { isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(duringContest.items.length, 0);

    // 赛后：能搜到
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(contests.id, contest.id));
    const afterContest = await searchFlat({
      q: "ZZYZX", page: 1, perPage: 20,
      ctx: { isAdmin: false, guestReadEnabled: true },
    });
    assertEquals(afterContest.items.length, 1);
  },
});
```

**`searchFlat` 的真实签名**（已核对 `search.ts:97-103`）：

```ts
searchFlat(params: {
  q: string;
  type?: string;
  page: number;
  perPage: number;
  ctx: SearchPermissionContext;
}): Promise<FlatResult>
```

`SearchPermissionContext` 为 `{ userId?, isAdmin, guestReadEnabled, communityEnabled? }`（`permission-filter.ts:4-10`）。
返回结构为 `{ items, has_more, page, per_page, took_ms }`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain search`
Expected: FAIL —— 赛期仍搜到 1 条

- [ ] **Step 3: 加 SQL 谓词**

在 `noj-core/src/domains/search/services/permission-filter.ts` 追加：

```ts
/**
 * 赛期题解门控：排除"属于进行中竞赛的题目"的题解搜索条目。
 *
 * 自包含 SQL：时间窗口在 SQL 内实时比较，竞赛结束后自动放行，无需调度。
 * 依赖 metadata 中的 post_type / problem_id（index-writer 已写入，无需重建索引）。
 */
export function runningContestSolutionWhere() {
  return sql`NOT (
    ${searchEntries.entity_type} = 'community_post'
    AND ${searchEntries.metadata}->>'post_type' = 'solution'
    AND ${searchEntries.metadata}->>'problem_id' IN (
      SELECT cp.problem_id FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND c.end_time > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )`;
}
```

**注意**：`contests.start_time` / `end_time` 是 ISO 8601 **文本**列（见 `noj-core/CLAUDE.md`）。文本比较对同格式 ISO 串按字典序成立；上面的 `to_char` 生成同格式串以保证可比性。实现后**必须**用 Step 1 的用例验证赛期与赛后两种状态都正确。

- [ ] **Step 4: 接入两条查询**

在 `noj-core/src/domains/search/services/search.ts` 的两处查询（`:76` 与 `:133`）中，紧跟 `${communityVisibilityWhere(ctx)}` 之后各加一行：

```ts
        AND ${runningContestSolutionWhere()}
```

并 import：

```ts
import { communityVisibilityWhere, permissionWhere, runningContestSolutionWhere } from "./permission-filter.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain search`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
jj describe -m "feat(core): 搜索路径赛期题解门控"
jj new
```

---

### Task 10: 前端官方题解与赛后复盘

**Files:**
- Modify: `noj-ui/pages/problems/[id].vue`（官方徽章 + 赛期禁用态）
- Modify: `noj-ui/pages/contests/[contestId]/index.vue`（赛后复盘分区）
- Modify: `noj-ui/composables/useCommunity.ts`（如需暴露 `is_official` 字段类型）

**Interfaces:**
- Consumes: Task 7 的 `is_official` 字段；Task 8 的 `blocked_reason`
- Produces: 题目页官方徽章 + 赛期禁用文案；竞赛页赛后复盘分区

- [ ] **Step 1: 题目页官方徽章与赛期禁用**

在 `noj-ui/pages/problems/[id].vue` 的题解列表渲染处（`:354` 起的 section 内），为每条题解加官方徽章：

```html
                  <UBadge v-if="sol.is_official" color="primary" variant="subtle" class="mr-2">
                    官方题解
                  </UBadge>
```

并把 `publishBlockReason` 计算属性改为优先显示赛期原因：

```ts
const publishBlockReason = computed(() => {
  const el = eligibility.value
  if (!el) return null
  if (el.can_create) return null
  if (el.blocked_reason === 'running_contest') return '竞赛进行中，赛后开放题解'
  if (!el.enabled) return '题解区已关闭'
  if (config.value?.read_only) return '社区当前为只读模式'
  if (el.requires_accepted && !el.accepted) return '通过本题后可发布题解'
  return '当前账号没有发布题解的权限'
})
```

同时把 `eligibility` ref 的类型补上 `blocked_reason: string | null`。

- [ ] **Step 2: 竞赛页赛后复盘分区**

在 `noj-ui/pages/contests/[contestId]/index.vue` 的 tabs 定义（`:41`）中追加 `'review'`：

```ts
const TAB_NAMES = ['detail', 'problems', 'clarifications', 'ranking', 'review'] as const
```

在 tab 列表（`:66` 附近）追加赛后复盘项，并加模板 slot（放在 `problems` slot 之后）：

```html
      <template #review>
        <div class="rounded-xl border border-border bg-white p-6">
          <h2 class="text-base font-semibold text-text">赛后复盘</h2>
          <p class="mt-1 text-sm text-text-secondary">竞赛已结束，可查看题目、官方题解与本人提交结论。</p>
          <div v-if="problems.length" class="mt-4 divide-y divide-border">
            <div v-for="item in problems" :key="item.problem_id" class="flex items-center justify-between gap-3 py-3">
              <div class="min-w-0">
                <span class="font-mono text-xs text-text-muted">{{ item.label }}</span>
                <span class="ml-2 text-sm font-medium text-text">{{ item.title }}</span>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="outline"
                :to="`/problems/${item.problem_id}`"
              >
                查看题解
              </UButton>
            </div>
          </div>
          <p v-else class="mt-4 text-sm text-text-muted">暂无题目</p>
        </div>
      </template>
```

并保证 tab 列表在 `contest.status === 'ended'` 时才包含 `review`（计算属性化 tab 列表；`detail` 等到 `ranking` 四项沿用该文件已有的中文 label）：

```ts
const tabs = computed(() => {
  const base = [
    { value: 'detail', label: '详情', icon: 'i-lucide-info', slot: 'detail' },
    { value: 'problems', label: '题目', icon: 'i-lucide-list-checks', slot: 'problems' },
    { value: 'clarifications', label: '答疑', icon: 'i-lucide-message-circle-question', slot: 'clarifications' },
    { value: 'ranking', label: '排名', icon: 'i-lucide-trophy', slot: 'ranking' },
  ]
  if (contest.value?.status === 'ended') {
    base.push({ value: 'review', label: '赛后复盘', icon: 'i-lucide-book-open-check', slot: 'review' })
  }
  return base
})
```

（把模板中对 tabs 数组的引用替换为 `tabs`；`problems` 在 `ended` 时也应加载——检查 `loadProblems` 的守卫条件 `contest.value.status === 'pending'` 是否已允许 ended，必要时放宽为仅排除 pending。）

- [ ] **Step 3: 校验**

Run: `cd noj-ui && deno task lint && deno task test`
Expected: PASS

- [ ] **Step 4: 手工验收（端到端）**

Expected:
1. 题目 owner 在题目页发布/标记一条官方题解 → 题解区该条带"官方题解"徽章且排在最前；
2. 把该题加入一场进行中的竞赛 → 该题题解区为空、发布按钮禁用并显示"竞赛进行中，赛后开放题解"；搜索该题解标题无结果；
3. 把竞赛 `end_time` 改到过去 → 题解立即恢复可见、按钮恢复可用、搜索恢复；
4. 竞赛页在 `ended` 状态出现"赛后复盘"tab，列出题目与"查看题解"入口。

- [ ] **Step 5: 提交**

```bash
jj describe -m "feat(ui): 官方题解徽章与竞赛赛后复盘"
jj new
```

---

### Task 11: 文档与 Agent Note

**Files:**
- Modify: `noj-docs/docs/features/contests.md`
- Modify: `noj-docs/docs/reference/changelog.md`
- Create: `.agents/notes/implemented/feature/2026-09-14-<topic>.md`

- [ ] **Step 1: 更新文档**

`noj-docs/docs/features/contests.md` 增加一段说明：赛期题解门控（进行中竞赛的题目其题解对普通用户不可见，赛后自动恢复）、赛后复盘入口。

`noj-docs/docs/reference/changelog.md` 在"预发布版本"段追加：

```markdown
- 出题人与选手体验：竞赛风控新增相似提交复核界面；题目通过率对所有人公开（竞赛进行中隐藏），出题人可查看评测状态分布与用例失败分布；题解支持官方标记，竞赛赛期自动隐藏题解并在赛后提供复盘入口。
```

- [ ] **Step 2: 写 Agent Note**

新建 `.agents/notes/implemented/feature/2026-09-14-problem-setter-and-solver-experience.md`，格式为：

```markdown
# Agent Note: 出题人与选手体验增强（风控接线 / 数据洞察 / 官方题解）

Status: implemented

## Problem

（描述三个问题：相似度检测后端已完成但前端未接线；题目无任何统计数据且用例级结果从未聚合；
题解读路径不感知竞赛窗口，导致竞赛进行中可读到该题已有题解 —— 附 path:line 证据）

## Decision

（描述三个决策：W1 前端接线复用既有端点与提交详情；W2 公开通过率+赛中隐藏+隐藏用例匿名化+
2000 条上限不静默截断；W3 社区形态的官方题解 + 服务层门控 + 自包含搜索谓词 + 赛期实时判定不引入调度）

## Alternatives considered

（题解进题包（已否决）、题解 AST/结构化形态、用定时任务翻转竞赛状态、把门控放在路由层）

## Consequences

（进行中竞赛的题目其题解对所有人隐藏，包括日常练习场景；5 分钟统计缓存为单副本专用；
2000 条样本上限意味着超大数据集下统计为近似值）
```

- [ ] **Step 3: 校验格式与链接**

Run:
```bash
deno run -A scripts/verify-agent-note-format.ts
deno run -A scripts/verify-md-links.ts
```
Expected: PASS

- [ ] **Step 4: 全量门禁**

Run: `deno run -A scripts/check-ci.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
jj describe -m "docs(root): 出题人与选手体验增强的文档与决策记录"
jj new
```

---

## 完成标准

- [ ] W1：管理员可在风控面板复核相似提交，并能跳转到含 code 的详情页
- [ ] W2：通过率对所有用户公开（赛期隐藏）；出题人可见状态分布与用例失败分布（隐藏用例无真实 case_id）
- [ ] W3：官方题解可标记并置顶；赛期题解在读路径 5 处与搜索路径均不可见，发布入口禁用；赛后自动恢复；竞赛页提供赛后复盘入口
- [ ] `deno run -A scripts/check-ci.ts` 通过
- [ ] 三个工作流的 Agent Note 与文档已更新
