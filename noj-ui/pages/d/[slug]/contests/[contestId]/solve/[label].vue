<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import type { DomainCodeProblem } from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
import { contestPhase } from '~/utils/contestWindow';
definePageMeta({ layout: 'workspace-editor', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth();
const api = useDomainContestAnswers(), contestApi = useDomainContests();
const id = computed(() => String(route.params.contestId)), label = computed(() => String(route.params.label));
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-answer', id.value, label.value)
);
const { data, status, error, refresh } = await useAsyncData(key, () => api.problem(slug.value!, id.value, label.value));
const contest = await useAsyncData(() => `${key.value}:contest`, () => contestApi.detail(slug.value!, id.value));
useSeoMeta({ title: () => data.value?.data.title ?? '比赛题目' });

/**
 * 受理窗口用**本地**阶段判定：只依赖赛程时间，不需要 2 秒轮询详情。
 *
 * 注意本地阶段只决定「是否展示入口/是否显示倒计时」，**不是授权**：真正的受理判定
 * 仍在后端（`getDomainContestSubmissionTarget` 复核受理窗口与报名关系）。本地时钟
 * 被篡改最多让按钮多亮几秒，提交仍会被后端拒绝。
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
const row = computed(() => contest.data.value?.data ?? null);
const phase = computed(() => contestPhase(row.value, now.value));
/** 跨越受理边界或 revision 变化（报名、赛制）→ 重取事实。 */
watch([phase, () => row.value?.status, () => row.value?.revision], (next, previous) => {
  if (!previous || next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) {
    void contest.refresh();
    void refresh();
  }
});
/** 详情低频同步：赛程/报名变化由组织者或本人操作触发，不需要秒级轮询。 */
usePolling({
  intervalMs: computed(() => (phase.value !== 'ended' ? 30000 : null)),
  immediate: false,
  fetcher: () => contest.refresh().then(() => undefined),
});

/**
 * 题面模型。
 *
 * `model` 为 null 有两种原因：题面还没固定作答版本（迁移期的存量比赛题），或缺了
 * `reference`。两种情况都必须给出可读提示——此前模板要求 `data && model` 双真而
 * `AsyncContent` 的 status 只看 `data`，于是渲染出一个纯白页面。
 */
const model = computed<DomainCodeProblem | null>(() => {
  const p = data.value?.data;
  if (!p?.version_id || !p.reference) return null;
  return {
    reference: p.reference,
    version_id: p.version_id,
    version: p.version!,
    supported_languages: p.supported_languages,
    difficulty: p.difficulty,
    limits: p.limits,
    content: {
      kind: p.judge_type === 'oi' ? 'oi' : 'ai',
      title: p.title,
      description: p.description,
      samples: p.samples ?? [],
      submission_mode: p.submission_mode } };
});
const backUrl = computed(() =>
  `/d/${slug.value}/contests/${encodeURIComponent(id.value)}/problems/${encodeURIComponent(label.value)}`
);
const active = computed(() => phase.value === 'running' && row.value?.is_registered === true);
/** 状态口径与模板一致：`data` 有值但 `model` 为空必须走 empty 而不是 data。 */
const contentStatus = computed(() =>
  error.value ? 'error' : data.value && model.value ? 'data' : status.value === 'pending' ? 'loading' : 'empty'
);
const emptyText = computed(() =>
  data.value && !model.value
    ? '本场题目尚未固定作答版本，暂时无法进入作答；请返回赛题页查看题面，或联系组织者。'
    : '题目不存在或没有访问权限'
);
</script>
<template>
  <AsyncContent :status="contentStatus"
    :error="error ? extractApiError(error).message : undefined" :empty-text="emptyText" @retry="refresh()">
    <template v-if="data && model">
      <div v-if="data.data.is_objective || ['artifact','prediction'].includes(data.data.submission_mode)"
        class="flex min-h-dvh items-center justify-center">
        <UButton :to="backUrl">返回比赛题目页作答</UButton>
      </div>
      <div v-else-if="data.data.submission_mode==='ui'" class="mx-auto max-w-[1440px] space-y-4 p-4">
        <div class="flex items-center justify-between gap-3">
          <h1 class="text-xl font-semibold">{{ data.data.label }} · {{ data.data.title }}</h1>
          <UButton :to="backUrl" color="neutral" variant="outline">返回赛题</UButton>
        </div>
        <DomainContestAnswer :key="key" :slug="slug!" :contest-id="id"
          :problem="{...data.data,version_id:model.version_id}" :active="active" @refresh="refresh()" />
      </div>
      <DomainCodeWorkspace v-else :key="key" :slug="slug!" :problem="model" :back-url="backUrl"
        :contest="{id,label,title:row?.title ?? '比赛',active}" @refresh="refresh()" />
    </template>
    <template #empty>
      <div class="mx-auto max-w-prose space-y-3 py-12 text-center">
        <UIcon name="i-lucide-file-question" class="mx-auto size-6 text-text-muted" />
        <p class="text-sm text-text-secondary">{{ emptyText }}</p>
        <UButton :to="backUrl" color="neutral" variant="outline" icon="i-lucide-arrow-left">返回赛题页</UButton>
      </div>
    </template>
  </AsyncContent>
</template>
