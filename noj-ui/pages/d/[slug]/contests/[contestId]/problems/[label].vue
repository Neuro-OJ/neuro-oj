<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { toContestProblemView } from '~/utils/problemView';
import { contestDurationText, contestPhase, scoreboardScopeText } from '~/utils/contestWindow';
import { formatDateTime } from '~/utils/submissionFormat';

/**
 * 域比赛赛题页。
 *
 * 与普通题目详情页（`/d/:slug/problems/:ref`）共用同一套版式组件：
 * `ProblemHeader`（题号/题型/难度/标题 + 操作区）、`ProblemStatement`（题面工具条 +
 * 示例）、`ProblemAnswerPanel`（作答面板，经 `DomainContestAnswer` 注入比赛提交入口）。
 * 两处差异只体现在这里显式声明的比赛约束：
 *
 * - **固定版本**：题面标题与工具条展示比赛固定版本，提交原样回传（不随题库换版）；
 * - **报名与时间**：未报名/未开赛时后端拒绝读取，页面给出对应说明；
 * - **成绩保密**：赛时不展示通过率与判定细节，仅提示按赛制公布；
 * - **自测限制**：比赛不做代码自测，避免提前暴露隐藏判定。
 */
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], workspaceWidth: 'problem', breadcrumbWidth: '1280px' });

const route = useRoute();
const { slug, domain } = useWorkspace();
const { user } = useAuth();
const api = useDomainContestAnswers();
const contestApi = useDomainContests();

const id = computed(() => String(route.params.contestId));
const label = computed(() => String(route.params.label));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-answer', id.value, label.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.problem(slug.value!, id.value, label.value));
const contest = await useAsyncData(
  () => `${key.value}:contest`,
  () => contestApi.detail(slug.value!, id.value),
);

const contestRow = computed(() => contest.data.value?.data ?? null);

/**
 * 受理窗口用本地阶段判定，详情只做低频同步。
 *
 * 本地阶段只影响「是否给出编码入口 / 是否显示受理状态」，**不是授权**：真正的受理
 * 判定由后端在提交时复核（受理窗口 + 报名关系）。因此这里去掉 5 秒轮询不会放松任何
 * 服务端约束，只是把「服务器每 5 秒被观众敲一次」换成「边界时刻重取一次」。
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (clock) clearInterval(clock);
  clock = null;
});
const phase = computed(() => contestPhase(contestRow.value, now.value));
// 跨越受理边界或 revision 变化（换版、报名）→ 重读赛题与比赛事实。
watch([phase, () => contestRow.value?.status, () => contestRow.value?.revision], (next, previous) => {
  if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) {
    void contest.refresh();
    void refresh();
  }
});
usePolling({
  intervalMs: computed(() => (phase.value !== 'ended' ? 30000 : null)),
  immediate: false,
  fetcher: () => contest.refresh().then(() => undefined),
});
const problemView = computed(() => data.value ? toContestProblemView(data.value.data) : null);
const contestProblem = computed(() => data.value?.data ?? null);
const inlineAnswer = computed(() =>
  !!contestProblem.value &&
  (contestProblem.value.is_objective === true || ['artifact', 'prediction'].includes(contestProblem.value.submission_mode ?? ''))
);
const solveTo = computed(() =>
  `/d/${slug.value}/contests/${encodeURIComponent(id.value)}/solve/${encodeURIComponent(label.value)}`
);
const active = computed(() =>
  phase.value === 'running' && contestRow.value?.is_registered === true
);
const statementExpanded = ref(true);
const submissionsPanel = ref<{ refresh: () => Promise<unknown> } | null>(null);

/** 提交受理后同步刷新「本场我的提交」，避免提示"还没有提交过本题"。 */
async function refreshAfterSubmit() {
  await Promise.all([refresh(), submissionsPanel.value?.refresh()]);
}
const contestHome = computed(() => `/d/${slug.value}/contests/${id.value}`);

const durationText = computed(() =>
  contestRow.value ? contestDurationText(contestRow.value.start_time, contestRow.value.end_time) : null
);
const scoreboardHint = computed(() =>
  contestRow.value ? scoreboardScopeText(contestRow.value.type, contestRow.value.config?.scoreboard_scope) : ''
);

/**
 * 相邻题目导航依赖赛题列表。
 *
 * 此前这里用 `.catch(() => null)` 把失败静默吞掉：列表请求抖一次，上一题/下一题与
 * 题号位置就会无声消失，用户还会误以为「已经是第一题」。现在失败写进 error ref，
 * 页面给出可重试的提示。
 */
const problemsError = ref<string | null>(null);
const problems = await useAsyncData(
  () => `${key.value}:list`,
  async () => {
    problemsError.value = null;
    if (!contestRow.value) return null;
    try {
      return await contestApi.problems(slug.value!, id.value);
    } catch (e) {
      problemsError.value = extractApiError(e).message;
      return null;
    }
  },
);
async function retryProblems() {
  await problems.refresh();
}
const position = computed(() => {
  const list = problems.data.value?.data ?? [];
  const index = list.findIndex((item) => item.label === label.value);
  return index >= 0 ? { index: index + 1, total: list.length } : null;
});
const previous = computed(() => {
  const list = problems.data.value?.data ?? [];
  const index = list.findIndex((item) => item.label === label.value);
  return index > 0 ? list[index - 1] : null;
});
const next = computed(() => {
  const list = problems.data.value?.data ?? [];
  const index = list.findIndex((item) => item.label === label.value);
  return index >= 0 && index < list.length - 1 ? list[index + 1] : null;
});
const problemTo = (target: { label: string }) =>
  `/d/${slug.value}/contests/${encodeURIComponent(id.value)}/problems/${encodeURIComponent(target.label)}`;

useSeoMeta({ title: () => contestProblem.value ? `${contestProblem.value.label} · ${contestProblem.value.title}` : '比赛题目' });
</script>

<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data && problemView" class="space-y-5">
      <!-- 与普通题目页一致的页内导航：比赛内定位 + 返回比赛 -->
      <nav aria-label="比赛题目导航" class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <NuxtLink :to="contestHome" class="inline-flex items-center gap-1 text-text-secondary no-underline hover:text-primary">
          <UIcon name="i-lucide-arrow-left" class="size-3.5" />返回比赛
        </NuxtLink>
        <a href="#statement" class="text-text-secondary no-underline hover:text-primary">题面</a>
        <a v-if="inlineAnswer" href="#answer" class="text-text-secondary no-underline hover:text-primary">作答</a>
        <span v-if="position" class="ml-auto font-mono text-xs tabular-nums text-text-muted">
          第 {{ position.index }} / {{ position.total }} 题
        </span>
      </nav>

      <div class="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div class="min-w-0 space-y-6 lg:col-span-8">
          <ProblemHeader :problem="problemView" :show-owner="false">
            <template #leading>
              <span
                class="inline-flex items-center rounded-full border border-primary/20 bg-primary-bg px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                {{ contestProblem?.label }}
              </span>
            </template>
            <template #titleSuffix>
              <span class="text-xs text-text-muted">{{ contestRow?.title }}</span>
            </template>
            <template #actions>
              <!-- 只有受理中（且已报名）才提供编码入口；赛后是只读复盘，避免给出空编辑器 -->
              <UButton v-if="!inlineAnswer && active" :to="solveTo" size="lg"
                :icon="contestProblem?.submission_mode === 'ui' ? 'i-lucide-panels-top-left' : 'i-lucide-code-2'">
                {{ contestProblem?.submission_mode === 'ui' ? '打开作答界面' : '开始编码' }}
              </UButton>
              <UButton :to="`/d/${slug}/contests/${id}/ranking`" size="lg" color="neutral" variant="outline"
                icon="i-lucide-trophy">
                成绩榜
              </UButton>
            </template>
          </ProblemHeader>

          <UAlert v-if="!active" color="info"
            :title="phase === 'pending'
              ? '比赛尚未开始，赛题可在开赛后作答'
              : phase === 'ended'
                ? '比赛已结束，仅可查看题面'
                : '仅在比赛受理时间内且已报名时可提交'" />

          <ProblemStatement v-model:expanded="statementExpanded" :content="problemView.description"
            :editor-to="!inlineAnswer && active ? solveTo : null" :editor-label="'在比赛编辑器打开'"
            :editor-icon="contestProblem?.submission_mode === 'ui' ? 'i-lucide-panels-top-left' : 'i-lucide-code-2'"
            :edit-to="null">
            <template #toolbar>
              <span class="rounded border border-border bg-bg-sunken px-2 py-1 text-xs tabular-nums text-text-muted">
                固定版本 V{{ contestProblem?.version ?? '—' }}
              </span>
              <span class="inline-flex items-center gap-1.5 text-xs"
                :class="active ? 'text-signal-deep' : 'text-text-muted'">
                <UIcon :name="active ? 'i-lucide-radio' : 'i-lucide-lock'" class="size-3.5" />
                {{ active ? '受理中' : contestRow?.status === 'ended' ? '已结束' : contestRow?.status === 'pending' ? '未开赛' : '未报名' }}
              </span>
            </template>
            <template #after-content>
              <ProblemSamples :samples="problemView.samples ?? []" />
            </template>
          </ProblemStatement>

          <!-- 赛后复盘：官方题解入口。赛中不给（会提前泄露判定思路）。 -->
          <div v-if="phase === 'ended' && contestProblem?.problem_id"
            class="rounded border border-border bg-bg-panel px-4 py-3">
            <OfficialSolutionEntry :slug="slug!" :problem-id="contestProblem.problem_id"
              :enabled="domain?.configuration.features.community !== false" />
          </div>

          <div v-if="inlineAnswer" id="answer" class="scroll-mt-24">
            <DomainContestAnswer v-if="contestProblem?.version_id" :key="`${key}:${contestProblem.version_id}`"
              :slug="slug!" :contest-id="id" :problem="{ ...contestProblem, version_id: contestProblem.version_id }"
              :active="active" @refresh="refreshAfterSubmit()" />
            <UAlert v-else color="warning" title="本场题目尚未固定作答版本，请联系组织者" />
          </div>

          <!-- 赛题列表失败时不能让导航静默消失：给出可重试的提示。 -->
          <div v-if="problemsError" role="status"
            class="flex flex-wrap items-center justify-between gap-2 rounded border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text">
            <span>赛题列表暂不可用，上一题/下一题与题号位置暂时无法显示。</span>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="retryProblems()">
              重试
            </UButton>
          </div>
          <nav v-if="position && position.total > 1" class="flex flex-wrap items-center justify-between gap-3" aria-label="赛题切换">
            <UButton v-if="previous" :to="problemTo(previous)" color="neutral" variant="outline" icon="i-lucide-arrow-left"
              class="justify-start">
              {{ previous.label }} · {{ previous.title }}
            </UButton>
            <span v-else class="text-xs text-text-muted">已经是第一题</span>
            <UButton v-if="next" :to="problemTo(next)" color="neutral" variant="outline" trailing-icon="i-lucide-arrow-right"
              class="justify-end">
              {{ next.label }} · {{ next.title }}
            </UButton>
            <span v-else class="text-xs text-text-muted">已经是最后一题</span>
          </nav>
        </div>

        <aside class="min-w-0 space-y-5 lg:col-span-4">
          <section class="rounded-xl border border-border bg-bg-panel p-5">
            <h2 class="mb-3 text-sm font-semibold text-text">本场信息</h2>
            <dl class="space-y-2.5 text-sm">
              <div class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">比赛</dt>
                <dd class="min-w-0 truncate text-right text-text">
                  <NuxtLink :to="contestHome" class="text-primary no-underline hover:underline">
                    {{ contestRow?.title ?? '—' }}
                  </NuxtLink>
                </dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">赛题编号</dt>
                <dd class="font-mono text-xs text-text">{{ contestProblem?.label }} · {{ contestProblem?.display_id }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">固定版本</dt>
                <dd class="tabular-nums text-text">V{{ contestProblem?.version ?? '—' }}</dd>
              </div>
              <div v-if="contestProblem?.score" class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">本题分值</dt>
                <dd class="tabular-nums text-text">{{ (contestProblem.score / 100).toFixed(0) }} 分</dd>
              </div>
              <div v-if="contestProblem?.limits" class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">限制</dt>
                <dd class="tabular-nums text-text">
                  {{ contestProblem.limits.time_limit_ms }}ms · {{ contestProblem.limits.memory_limit_mb }}MB
                </dd>
              </div>
              <div v-if="durationText" class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">赛程</dt>
                <dd class="tabular-nums text-text">{{ durationText }}</dd>
              </div>
              <div v-if="contestRow" class="flex items-center justify-between gap-3">
                <dt class="text-text-secondary">结束</dt>
                <dd class="tabular-nums text-xs text-text">{{ formatDateTime(contestRow.end_time) }}</dd>
              </div>
            </dl>
          </section>

          <section class="rounded-xl border border-border bg-bg-panel p-5">
            <h2 class="mb-2 text-sm font-semibold text-text">成绩与判定</h2>
            <p class="text-xs leading-5 text-text-secondary">{{ scoreboardHint }}</p>
            <p class="mt-2 text-xs leading-5 text-text-muted">
              赛时不提供代码自测；提交按比赛固定版本评测，结果公开范围由赛制决定。
            </p>
            <div class="mt-3 flex flex-col gap-2">
              <UButton :to="`/d/${slug}/contests/${id}/ranking`" color="neutral" variant="outline" icon="i-lucide-trophy"
                class="justify-start">
                成绩榜
              </UButton>
            </div>
          </section>

          <DomainProblemSubmissions ref="submissionsPanel" :key="`${key}:submissions`" :slug="slug!"
            :problem-id="contestProblem?.problem_id ?? ''" :contest-id="id" title="本场我的提交" />
        </aside>
      </div>
    </div>
  </AsyncContent>
</template>
