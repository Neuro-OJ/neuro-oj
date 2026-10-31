<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { contestPenaltyText } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
import { contestCountdown, contestPhase } from '~/utils/contestWindow';
import type { DomainContestRanking, DomainContestRankingRow } from '~/composables/useDomainContests';
import { useDomainContestStream, type DomainContestRankingEvent } from '~/composables/useDomainContestStream';

/**
 * 域比赛成绩榜。
 *
 * 数据来源分三层，不要混用：
 * 1. **REST 首屏**（`useAsyncData`）：SSR 可用，提供权威的 `classrooms`/分区/封榜字段；
 * 2. **SSE 实时事件**：连通时替代周期性榜单请求；事件载荷与 REST `/ranking` 同构
 *    （后端在域入口额外下发 `classrooms` / `classroom_rows` / `other_rows`）；
 * 3. **正式成绩快照**：切到「正式成绩」或事件声明 `view: 'official'` 时只认 REST
 *    快照 —— 已发布的成绩版本不随实时重测变化。
 *
 * 时间推进用**本地**阶段计算（`start_time` / `end_time`），不靠轮询服务端拿状态；
 * 只有跨越边界或 `revision` 变化时才主动重取。
 */
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute();
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainContests();
const id = computed(() => String(route.params.contestId));
const official = ref(false), group = ref<'classroom' | 'other' | 'all'>('classroom'), classroomId = ref('');
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-ranking', id.value));
const { data: contest, refresh: refreshContest } = await useAsyncData(
  computed(() => `${key.value}:contest`),
  () => api.detail(slug.value!, id.value),
);
const { data: snapshot, error, status: loadStatus, refresh } = await useAsyncData(
  computed(() => `${key.value}:${official.value}:${classroomId.value}`),
  () => api.ranking(slug.value!, id.value, official.value, classroomId.value || undefined),
);
// 班级筛选只对「关联班级学生」有意义；切到其他分组时清空，避免带着旧筛选取数。
watch(group, (next) => {
  if (next !== 'classroom') classroomId.value = '';
});
useSeoMeta({ title: '比赛成绩榜' });

// ── 本地阶段计算 ─────────────────────────────────────────────
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (clock) clearInterval(clock);
  clock = null;
});
/** 赛前 / 赛中 / 赛后：只依赖赛程时间，本地即可判定。 */
const phase = computed(() => contestPhase(contest.value?.data, now.value));
const countdown = computed(() => {
  const row = contest.value?.data;
  if (!row) return null;
  const target = phase.value === 'pending' ? row.start_time : row.end_time;
  return contestCountdown(target, now.value);
});
// 跨越开赛 / 结束边界，或服务端 revision 变化（公告、报名、赛制）→ 立即重取。
watch(
  [phase, () => contest.value?.data.status, () => contest.value?.data.revision],
  (next, previous) => {
    if (
      !previous || next[0] !== previous[0] || next[1] !== previous[1] ||
      next[2] !== previous[2]
    ) {
      void refreshContest();
      void refresh();
    }
  },
);

// ── 实时榜数据 ───────────────────────────────────────────────
const liveRanking = ref<DomainContestRankingEvent | null>(null);
/** 当前展示的榜单视图：正式成绩只认快照，实时榜优先用事件。 */
const view = computed<DomainContestRanking | null>(() => {
  if (official.value) return snapshot.value ?? null;
  return (liveRanking.value as unknown as DomainContestRanking | null) ?? snapshot.value ?? null;
});
const rows = computed<DomainContestRankingRow[]>(() => {
  const current = view.value;
  if (!current) return [];
  // 有班级分区时才提供分组；「全部参赛者」直接取未分区的完整榜。
  if (!official.value && current.classrooms?.length && group.value !== 'all') {
    return group.value === 'classroom' ? current.classroom_rows ?? [] : current.other_rows ?? [];
  }
  return current.data ?? [];
});

/**
 * 赛后还没发布正式成绩时后端返回 409（`竞赛已结束，正式成绩尚未发布`）。
 * 那是**流程状态**而不是故障，必须降级成说明文案，不能渲染成红色错误块。
 */
const pendingPublish = computed(() => {
  if (!error.value) return false;
  const info = extractApiError(error.value);
  return info.status === 409 || /正式成绩尚未发布/.test(info.message);
});
const errorMessage = computed(() => {
  if (!error.value || pendingPublish.value) return undefined;
  return extractApiError(error.value).message;
});

const stream = useDomainContestStream({
  slug,
  contestId: id,
  viewerId: computed(() => user.value?.id ?? null),
  // 班级筛选在服务端建连时固定：切换筛选重建连接，保证分区与 REST 同源。
  classroomId: computed(() => classroomId.value || null),
  // 正式成绩与已结束的比赛不接收实时事件。
  enabled: computed(() => !official.value && phase.value !== 'ended'),
  onRanking: (payload) => {
    if (official.value) return;
    if (payload.view === 'official') {
      // 正式成绩已发布：交回 REST 快照，避免把实时行当成正式版本。
      liveRanking.value = null;
      void refresh();
      return;
    }
    liveRanking.value = payload;
  },
  // 降级兜底必须是静默刷新：不能把表格打回骨架屏。
  fetchFn: () => refresh().then(() => undefined),
  fallbackIntervalMs: 5000,
});

/**
 * 降级轮询只在 SSE 不可用时启用；连通时置 null。
 *
 * 边界：SSE 按连接即时计算榜单，服务端不共享缓存，所以「连通」消除的是
 * **静默期的重复查询**，不是把榜单计算变成全员共享。
 */
usePolling({
  intervalMs: computed(() => (!stream.connected.value && !official.value && phase.value === 'running' ? 5000 : null)),
  immediate: false,
  fetcher: () => refresh().then(() => undefined),
});
// 详情（报名状态、公告、revision）低频同步；跨越边界和操作后已有即时刷新。
usePolling({
  intervalMs: computed(() => (phase.value !== 'ended' ? 30000 : null)),
  immediate: false,
  fetcher: () => refreshContest(),
});
// 页面重新可见时补一次：后台 tab 期间可能错过事件。
const onVisible = () => {
  if (document.hidden) return;
  void refreshContest();
  if (!stream.connected.value) void refresh();
};
onMounted(() => document.addEventListener('visibilitychange', onVisible));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisible));
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="text-xl font-semibold">{{ contest?.data.title }} · 成绩榜</h2>
      <div class="flex flex-wrap items-center gap-2">
        <p v-if="countdown && !countdown.expired" class="text-xs tabular-nums text-text-muted">
          {{ phase === 'pending' ? '距开赛' : '距结束' }} {{ countdown.text }}
        </p>
        <UButton :variant="official ? 'outline' : 'solid'" @click="official = false">实时榜</UButton>
        <UButton :variant="official ? 'solid' : 'outline'" @click="official = true">正式成绩</UButton>
        <UButton icon="i-lucide-refresh-cw" variant="ghost" aria-label="刷新榜单" @click="refresh()" />
      </div>
    </div>
    <div v-if="(view?.classrooms?.length ?? 0) > 0" class="flex flex-wrap items-center gap-3">
      <USelect v-model="group" :items="[{ label: '关联班级学生', value: 'classroom' }, { label: '其他选手', value: 'other' }, { label: '全部参赛者', value: 'all' }]" aria-label="榜单分组" />
      <USelect v-if="group === 'classroom'" v-model="classroomId" :items="[{ label: '全部关联班级', value: '' }, ...(view?.classrooms ?? []).map(room => ({ label: room.name, value: room.id }))]" aria-label="班级筛选" />
      <p class="text-xs text-text-muted">按当前学生名单分组，赛后练习不计入比赛成绩。</p>
    </div>
    <UAlert v-if="view?.view === 'frozen' || view?.frozen" color="warning"
      title="榜单已封榜，封榜后的提交显示待揭榜。本人结果仍按赛制显示。" />
    <UAlert v-if="view?.snapshot" color="info"
      :title="`正式成绩 V${view.snapshot.version} · ${view.snapshot.note || '首次发布'}`" />
    <UAlert v-if="pendingPublish" color="info"
      title="正式成绩待组织者发布"
      description="比赛已结束，组织者尚未发布正式成绩快照。可先查看实时榜；正式成绩发布后此处会自动切换。" />
    <AsyncContent
      :status="errorMessage ? 'error' : loadStatus === 'pending' ? 'loading' : rows.length ? 'data' : 'empty'"
      :error="errorMessage" empty-text="暂无可展示的成绩" @retry="refresh()">
      <div class="overflow-auto rounded border border-border bg-bg-panel">
        <table class="w-full min-w-[720px] text-sm">
          <thead class="sticky top-0 bg-bg-sunken">
            <tr>
              <th scope="col" class="p-3 text-left">名次</th>
              <th scope="col" class="p-3 text-left">选手</th>
              <th scope="col" class="p-3 text-right">{{ contest?.data.type === 'acm' ? '解题数' : '总分' }}</th>
              <th v-if="contest?.data.type === 'acm'" scope="col" class="p-3 text-right">总罚时</th>
              <th scope="col" class="p-3 text-left">各题成绩</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.user_id" class="border-t border-border">
              <td class="p-3 tabular-nums">{{ row.rank }}</td>
              <td class="p-3">{{ row.username }}</td>
              <td
                class="p-3 text-right tabular-nums">{{ row.pending && view?.view !== 'frozen' ? '待处理' : contest?.data.type === 'acm' ? row.solved : (row.total_score / 100).toFixed(2) }}</td>
              <td v-if="contest?.data.type === 'acm'"
                class="p-3 text-right tabular-nums">{{ contestPenaltyText(row.penalty_ms ?? 0) }}</td>
              <td class="p-3">
                <span v-for="score in row.problem_scores" :key="score.label" class="mr-3 inline-block tabular-nums">
                  {{ score.label }}:
                  <template v-if="contest?.data.type === 'acm'">{{ score.accepted ? 'AC' : score.attempts ? `${score.attempts} 次未通过` : '未提交' }}<span v-if="score.accepted"> · {{ contestPenaltyText(score.penalty_ms ?? 0) }}</span></template>
                  <template v-else>{{ score.best_score == null ? '待处理' : (score.best_score / 100).toFixed(2) }}</template>
                  <span v-if="score.pending" class="ml-1 text-text-muted">{{ view?.view === 'frozen' ? '待揭榜' : '待处理' }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncContent>
  </div>
</template>
