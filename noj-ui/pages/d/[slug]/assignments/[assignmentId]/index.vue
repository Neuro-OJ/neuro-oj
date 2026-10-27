<script setup lang="ts">
import { onScopeDispose } from 'vue';
import { assignmentPhase, classroomCan, educationCacheKey, teachingCellLabel } from '~/utils/education';
import type { TeachingCapability, TeachingCell } from '~/utils/education';
import { workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.assignmentId));
const scope = ref<'on_time' | 'current'>('on_time');
const page = ref(1), recipients = ref('current'), statusFilter = ref('all'), search = ref('');
const searchDraft = ref(''), itemFilter = ref('all'), verdictFilter = ref('all');
const filtersOpen = ref(false);
const selected = ref<{ userId: string; username: string; reference: string; cell: TeachingCell } | null>(null),
  drawer = ref(false),
  downloading = ref(false);
const manageOpen = ref(false), feedbackSignal = ref(0);
const feedbackTarget = ref<{ userId: string; username: string } | null>(null);
const askSignal = ref(0), askItemId = ref<string | null>(null);
const pendingHelp = ref(0);
const key = computed(() => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value));
const task = await useAsyncData(() => `${key.value}:task`, () => education.assignment(slug.value!, id.value));
const room = await useAsyncData(
  () => `${key.value}:classroom:${task.data.value?.data.classroom_id ?? ''}`,
  () => task.data.value ? education.classroom(slug.value!, task.data.value.data.classroom_id) : Promise.resolve(null),
);
const can = (cap: TeachingCapability) =>
  !room.error.value && !!room.data.value && classroomCan(room.data.value.data, cap);
const isStudent = computed(() =>
  room.data.value?.data.membership?.role === 'student' ||
  room.data.value?.data.historical_student === true
);
const canReadProgress = computed(() => can('progress:read'));
const canManage = computed(() => can('assignments:manage'));
const query = computed(() => ({
  scope: scope.value,
  page: page.value,
  recipients: recipients.value,
  search: search.value || undefined,
  status: statusFilter.value === 'all' ? undefined : statusFilter.value,
  item_id: itemFilter.value === 'all' ? undefined : itemFilter.value,
  verdict: verdictFilter.value === 'all' ? undefined : verdictFilter.value,
}));
const matrix = await useAsyncData(
  () =>
    `${key.value}:matrix:${JSON.stringify(query.value)}:${can('progress:read')}:${!!task.data.value?.data
      .published_at}`,
  () =>
    can('progress:read') && task.data.value?.data.published_at
      ? education.matrix(slug.value!, id.value, query.value)
      : Promise.resolve(null),
  { watch: [query, task.data, room.data] },
);
const progress = await useAsyncData(
  () => `${key.value}:progress:${scope.value}:${isStudent.value}:${!!task.data.value?.data.published_at}`,
  () =>
    isStudent.value && task.data.value?.data.published_at
      ? education.progress(slug.value!, id.value, scope.value)
      : Promise.resolve(null),
  { watch: [scope, isStudent, task.data] },
);
const itemPage = ref(1);
const allItems = computed(() => progress.data.value?.data.items ?? []);
const visibleItems = computed(() => allItems.value.slice((itemPage.value - 1) * 20, itemPage.value * 20));
const summaries = await useProblemSummaries(() => slug.value!, () => isStudent.value ? visibleItems.value.map(item => item.reference.qualified_ref) : (task.data.value?.data.items ?? []).slice(0, 20).map(item => item.reference.qualified_ref));
const titles = computed(() => Object.fromEntries((summaries.data.value?.items ?? []).filter(item => item.title).map(item => [item.reference, item.title!])));
const progressCells = computed(() => Object.fromEntries((progress.data.value?.data.cells ?? []).map(cell => [cell.item_id, cell])));
const conversationItems = computed(() =>
  (task.data.value?.data.items ?? []).map((item) => ({
    id: item.id,
    displayRef: item.reference.display_ref,
    qualifiedRef: item.reference.qualified_ref,
    title: titles.value[item.reference.qualified_ref] ?? null,
  })),
);
const progressSummary = computed(() => {
  const data = progress.data.value?.data;
  if (!data) return '';
  if (data.updating || data.cells.some(cell => cell.updating)) return '进度正在更新';
  return `已达标 ${data.cells.filter(cell => cell.status === 'achieved').length} / ${data.items.length} 题`;
});

// 页面阶段与作业元信息
const phase = computed(() => task.data.value ? assignmentPhase(task.data.value.data) : '');
const phaseColor = computed<'primary' | 'neutral' | 'warning' | 'info' | 'success'>(() => {
  const state = task.data.value?.data.state;
  if (state === 'draft') return 'warning';
  if (state === 'scheduled') return 'info';
  if (state === 'archived') return 'neutral';
  if (phase.value === '进行中') return 'success';
  if (phase.value === '已提前结束') return 'warning';
  return 'neutral';
});
function formatDateTime(value: string | null | undefined) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}
const deadlineLabel = computed(() => formatDateTime(task.data.value?.data.deadline_at));
const publishedLabel = computed(() => task.data.value?.data.published_at ? `发布于 ${formatDateTime(task.data.value.data.published_at)}` : '');
const itemCount = computed(() => task.data.value?.data.items?.length ?? 0);
const classroomName = computed(() => room.data.value?.data.name ?? '');
const classroomPath = computed(() =>
  task.data.value ? workspacePath(slug.value!, `classrooms/${task.data.value.data.classroom_id}`) : workspacePath(slug.value!, 'classrooms'),
);
const recipientsOptions = [
  { label: '当前学生', value: 'current' },
  { label: '历史学生', value: 'historical' },
  { label: '全部目标学生', value: 'all' },
];
const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '未开始', value: 'not_started' },
  { label: '未达标', value: 'below_target' },
  { label: '已达标', value: 'achieved' },
  { label: '评测中', value: 'judging' },
  { label: '资源不可用', value: 'unavailable' },
  { label: '更新中', value: 'updating' },
];
const verdictOptions = ['AC', 'WA', 'CE', 'TLE', 'MLE', 'RE', 'OLE'];
const itemFilterOptions = computed(() => [
  { label: '全部题目', value: 'all' },
  ...(matrix.data.value?.data.items ?? []).map(item => ({ label: item.reference.display_ref, value: item.id })),
]);
const activeFilterCount = computed(() =>
  [recipients.value !== 'current', statusFilter.value !== 'all', itemFilter.value !== 'all', verdictFilter.value !== 'all',
    !!search.value.trim()].filter(Boolean).length
);
const matrixTotal = computed(() => matrix.data.value?.data.total ?? 0);
const matrixSummary = computed(() =>
  matrix.data.value ? `${matrixTotal.value} 名学生 · ${matrix.data.value.data.items.length} 道题` : ''
);
const totalMatrixPages = computed(() => Math.max(1, Math.ceil(matrixTotal.value / 50)));

// 角色可见范围 / 反馈定位 / 历史定位
const requestedHelp = computed(() => typeof route.query.help === 'string' ? route.query.help : undefined);
const requestedFeedback = computed(() => typeof route.query.feedback === 'string' ? route.query.feedback : undefined);
const canSeeFeedbackTab = computed(() => isStudent.value || can('feedback:write') || can('help:manage'));
const tab = ref<'matrix' | 'progress' | 'feedback'>(
  canReadProgress.value ? 'matrix' : isStudent.value ? 'progress' : canSeeFeedbackTab.value ? 'feedback' : 'matrix',
);
const tabItems = computed(() => {
  const items: Array<{ label: string; value: string; icon: string; badge?: { label: string; color: 'warning'; variant: 'subtle' } }> = [];
  if (canReadProgress.value) items.push({ label: '学情矩阵', value: 'matrix', icon: 'i-lucide-table-2' });
  else if (isStudent.value) items.push({ label: '题目与进度', value: 'progress', icon: 'i-lucide-list-checks' });
  if (canSeeFeedbackTab.value) {
    const badge = can('help:manage') && pendingHelp.value > 0
      ? { label: String(pendingHelp.value), color: 'warning' as const, variant: 'subtle' as const }
      : undefined;
    items.push({ label: '反馈与求助', value: 'feedback', icon: 'i-lucide-messages-square', ...(badge ? { badge } : {}) });
  }
  return items;
});
watch(tabItems, (items) => {
  if (!items.some((item) => item.value === tab.value)) {
    tab.value = (items[0]?.value ?? 'matrix') as typeof tab.value;
  }
}, { immediate: true });
if (canSeeFeedbackTab.value && (requestedHelp.value || requestedFeedback.value)) tab.value = 'feedback';
watch([requestedHelp, requestedFeedback], ([help, feedback]) => {
  if (canSeeFeedbackTab.value && (help || feedback)) tab.value = 'feedback';
});

watch([matrix.data, progress.data], ([matrixValue, progressValue]) => {
  const current = selected.value;
  if (!current) return;
  const row = matrixValue?.data.rows.find((row) => row.user_id === current.userId);
  const cell = row?.cells.find((cell) => cell.item_id === current.cell.item_id) ??
    (current.userId === actor.value?.id
      ? progressValue?.data.cells.find((cell) => cell.item_id === current.cell.item_id)
      : undefined);
  if (cell) selected.value = { ...current, username: row?.username ?? current.username, cell };
});
const classroomWritable = computed(() =>
  domain.value?.status === 'active' && domain.value.configuration.features.classroom &&
  domain.value.configuration.features.assignment && room.data.value?.data.status === 'active'
);
const writable = computed(() => classroomWritable.value && task.data.value?.data.state !== 'archived');
const capture = useWorkspaceActionScope();
usePolling({
  intervalMs: computed(() => matrix.data.value?.data.updating || progress.data.value?.data.updating ? 3000 : null),
  immediate: false,
  fetcher: async () => {
    await Promise.all([
      can('progress:read') ? matrix.refresh() : Promise.resolve(),
      isStudent.value ? progress.refresh() : Promise.resolve(),
    ]);
  },
});
useEducationNotifications(async () => {
  await task.refresh();
  if (task.error.value) return;
  await room.refresh();
  await Promise.all([
    can('progress:read') ? matrix.refresh() : Promise.resolve(),
    isStudent.value ? progress.refresh() : Promise.resolve(),
  ]);
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(searchDraft, (value) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { search.value = value.trim(); }, 350);
});
onScopeDispose(() => clearTimeout(searchTimer));
function commitSearch() {
  clearTimeout(searchTimer);
  search.value = searchDraft.value.trim();
}
watch([scope, recipients, statusFilter, search, itemFilter, verdictFilter], () => {
  page.value = 1;
});
watch([() => slug.value, () => id.value, () => actor.value?.id], () => {
  itemPage.value = 1;
  scope.value = 'on_time';
  recipients.value = 'current';
  statusFilter.value = 'all';
  search.value = searchDraft.value = '';
  itemFilter.value = verdictFilter.value = 'all';
  selected.value = null;
  feedbackTarget.value = null;
  askItemId.value = null;
  drawer.value = false;
  manageOpen.value = false;
  page.value = 1;
  tab.value = canReadProgress.value ? 'matrix' : isStudent.value ? 'progress' : 'feedback';
});
function resetFilters() {
  recipients.value = 'current';
  statusFilter.value = 'all';
  itemFilter.value = 'all';
  verdictFilter.value = 'all';
  search.value = searchDraft.value = '';
}
function select(userId: string, cell: TeachingCell) {
  selected.value = {
    userId,
    username: matrix.data.value?.data.rows.find((row) => row.user_id === userId)?.username ?? '本人',
    reference:
      (matrix.data.value?.data.items ?? progress.data.value?.data.items ?? []).find((item) => item.id === cell.item_id)
        ?.reference.display_ref ?? '',
    cell,
  };
  feedbackTarget.value = null;
  drawer.value = true;
}
function selectOwnSubmission(cell: TeachingCell) {
  if (!actor.value) return;
  select(actor.value.id, cell);
}
function cellTone(cell: TeachingCell) {
  if (cell.updating) return 'text-text-muted';
  if (cell.status === 'achieved') return 'text-signal-deep';
  if (cell.status === 'below_target') return 'text-text';
  if (cell.status === 'unavailable') return 'text-error-text';
  return 'text-text-secondary';
}
function giveFeedbackFromDrawer() {
  if (!selected.value) return;
  feedbackTarget.value = { userId: selected.value.userId, username: selected.value.username };
  drawer.value = false;
  tab.value = 'feedback';
  feedbackSignal.value++;
}
function clearFeedbackTarget() {
  feedbackTarget.value = null;
}
function askFromItem(itemId: string) {
  askItemId.value = itemId;
  tab.value = 'feedback';
  askSignal.value++;
}
function progressCell(itemId: string) {
  return progressCells.value[itemId];
}
function progressTone(cell: TeachingCell | undefined) {
  if (!cell || cell.updating || cell.status === 'not_started') return 'text-text-muted';
  if (cell.status === 'achieved') return 'text-signal-deep';
  if (cell.status === 'below_target') return 'text-text';
  if (cell.status === 'unavailable') return 'text-error-text';
  return 'text-info-text';
}
function requirementLabel(item: { requirement: 'accepted' | 'min_score'; minimum_score: number | null }) {
  return item.requirement === 'accepted' ? '正式通过' : `至少 ${(item.minimum_score ?? 0) / 100} 分`;
}
async function download() {
  if (downloading.value) return;
  const scope = capture(), taskId = id.value;
  downloading.value = true;
  try {
    const csv = await education.csv(scope.slug, taskId, { ...query.value, page: undefined });
    if (!scope.isCurrent() || id.value !== taskId) return;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
      link = document.createElement('a');
    link.href = url;
    link.download = `assignment-${taskId}-${query.value.scope}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    downloading.value = false;
  }
}
function onPendingHelp(count: number) {
  pendingHelp.value = count;
}
useBreadcrumbParams({ assignmentId: () => task.data.value?.data.title });
useSeoMeta({ title: () => task.data.value?.data.title ?? '作业' });
</script>
<template>
  <div class="flex flex-col gap-6">
    <AsyncContent
      :status="task.error.value ? 'error' : task.data.value ? 'data' : task.status.value === 'pending' ? 'loading' : 'empty'"
      :error="task.error.value ? extractApiError(task.error.value).message : undefined" @retry="task.refresh()">
      <div v-if="task.data.value" class="flex flex-col gap-6">
        <header class="flex flex-col gap-3 sm:gap-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <NuxtLink :to="classroomPath"
                class="mb-2 inline-flex max-w-full items-center gap-1 text-sm text-text-secondary transition-colors hover:text-primary">
                <UIcon name="i-lucide-arrow-left" class="size-4 shrink-0" />
                <span class="truncate">返回班级<span v-if="classroomName"> · {{ classroomName }}</span></span>
              </NuxtLink>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 class="break-words text-2xl font-bold leading-tight text-text">{{ task.data.value.data.title }}</h1>
                <UBadge :color="phaseColor" variant="subtle" size="sm">{{ phase }}</UBadge>
              </div>
              <p class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-text-secondary">
                <span class="inline-flex items-center gap-1.5 tabular-nums">
                  <UIcon name="i-lucide-list-checks" class="size-4 text-text-muted" />{{ itemCount }} 道题
                </span>
                <span v-if="deadlineLabel" class="inline-flex items-center gap-1.5 tabular-nums">
                  <UIcon name="i-lucide-clock" class="size-4 text-text-muted" />截止 {{ deadlineLabel }}
                </span>
                <span v-if="publishedLabel" class="hidden items-center gap-1.5 text-13px text-text-secondary tabular-nums sm:inline-flex">
                  <UIcon name="i-lucide-send" class="size-3.5" />{{ publishedLabel }}
                </span>
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <UButton v-if="canManage" class="hidden sm:inline-flex"
                :color="task.data.value.data.state === 'draft' ? 'primary' : 'neutral'"
                :variant="task.data.value.data.state === 'draft' ? 'solid' : 'outline'"
                :icon="task.data.value.data.state === 'draft' ? 'i-lucide-send' : 'i-lucide-settings-2'"
                @click="manageOpen = true">
                {{ task.data.value.data.state === 'draft' ? '发布与设置' : '管理作业' }}
              </UButton>
              <UButton v-if="canManage" class="sm:hidden"
                :color="task.data.value.data.state === 'draft' ? 'primary' : 'neutral'"
                :variant="task.data.value.data.state === 'draft' ? 'solid' : 'outline'"
                :icon="task.data.value.data.state === 'draft' ? 'i-lucide-send' : 'i-lucide-settings-2'"
                :aria-label="task.data.value.data.state === 'draft' ? '发布与设置' : '管理作业'"
                @click="manageOpen = true" />
            </div>
          </div>

          <div v-if="task.data.value.data.description" aria-label="作业说明"
            class="rounded-md border border-border bg-bg-panel px-4 py-3 text-sm sm:px-5">
            <MarkdownRenderer :content="task.data.value.data.description" />
          </div>

          <UAlert v-if="task.data.value.data.publish_error" color="warning" title="定时发布失败"
            :description="task.data.value.data.publish_error" />
          <p v-if="task.data.value.data.state === 'scheduled'" class="text-sm text-text-muted tabular-nums">
            预定发布时间：{{ formatDateTime(task.data.value.data.publish_at) }}
          </p>
        </header>

        <template v-if="task.data.value.data.published_at">
          <UTabs v-if="tabItems.length > 1" v-model="tab" :items="tabItems" :content="false" variant="link"
            class="w-full sm:w-fit" />

          <!-- 学情矩阵：域教练 -->
          <section v-if="tab === 'matrix' && canReadProgress" aria-label="学生成绩"
            class="flex flex-col gap-3">
            <AsyncContent
              :status="matrix.error.value ? 'error' : matrix.data.value ? 'data' : matrix.status.value === 'pending' ? 'loading' : 'empty'"
              :error="matrix.error.value ? extractApiError(matrix.error.value).message : undefined" @retry="matrix.refresh()">
              <template #loading>
                <div class="animate-pulse space-y-3 rounded-md border border-border bg-bg-panel p-4">
                  <div class="h-8 w-64 max-w-full rounded bg-bg-sunken" />
                  <div class="h-40 rounded bg-bg-sunken" />
                </div>
              </template>
              <div class="overflow-hidden rounded-md border border-border bg-bg-panel">
                <div class="flex flex-col gap-3 border-b border-border px-4 py-3 sm:px-5">
                  <div class="flex flex-wrap items-center gap-2">
                    <div role="group" aria-label="统计范围"
                      class="inline-flex rounded border border-border bg-bg-sunken p-0.5">
                      <button type="button" :aria-pressed="scope === 'on_time'"
                        class="min-h-8 rounded-sm px-3 text-sm transition-colors"
                        :class="scope === 'on_time' ? 'bg-bg-panel font-medium text-text shadow-card' : 'text-text-secondary hover:text-text'"
                        @click="scope = 'on_time'">按时成绩</button>
                      <button type="button" :aria-pressed="scope === 'current'"
                        class="min-h-8 rounded-sm px-3 text-sm transition-colors"
                        :class="scope === 'current' ? 'bg-bg-panel font-medium text-text shadow-card' : 'text-text-secondary hover:text-text'"
                        @click="scope = 'current'">当前补做</button>
                    </div>
                    <UTooltip
                      text="按时成绩只统计截止前受理、且符合发布版本策略的提交；当前补做跟随最新有效成绩，用于课后补练。">
                      <UButton variant="ghost" color="neutral" size="xs" icon="i-lucide-info"
                        class="text-text-muted" aria-label="统计范围说明" />
                    </UTooltip>
                    <span v-if="matrixSummary" class="text-xs text-text-muted tabular-nums">{{ matrixSummary }}</span>
                    <div class="ml-auto flex flex-wrap items-center gap-1.5">
                      <UInput v-model="searchDraft" icon="i-lucide-search" placeholder="搜索学生" size="sm"
                        class="w-40 sm:w-48" aria-label="搜索学生用户名" @keyup.enter="commitSearch" />
                      <UButton variant="outline" color="neutral" size="sm" icon="i-lucide-list-filter"
                        :aria-expanded="filtersOpen" aria-controls="assignment-filters"
                        @click="filtersOpen = !filtersOpen">
                        筛选
                        <span v-if="activeFilterCount"
                          class="ml-1 rounded-sm bg-primary-dark px-1 text-11px font-medium text-white tabular-nums">{{ activeFilterCount }}</span>
                      </UButton>
                      <UTooltip text="导出当前筛选结果为 CSV">
                        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-download"
                          :loading="downloading" aria-label="导出当前筛选结果为 CSV" @click="download" />
                      </UTooltip>
                      <UTooltip text="重新读取成绩">
                        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-refresh-cw"
                          :loading="matrix.status.value === 'pending'" aria-label="刷新成绩" @click="matrix.refresh()" />
                      </UTooltip>
                    </div>
                  </div>
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <p class="hidden text-xs text-text-muted sm:block">
                      按时成绩按截止与发布版本统计；补做进度独立计算，不改变按时成绩。
                    </p>
                    <p v-if="activeFilterCount" class="flex items-center gap-2 text-xs text-text-muted">
                      已筛选 {{ activeFilterCount }} 项
                      <button type="button" class="text-primary-dark hover:underline" @click="resetFilters">清除筛选</button>
                    </p>
                  </div>
                  <div v-show="filtersOpen" id="assignment-filters"
                    class="grid gap-3 rounded bg-bg-sunken/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
                    <AdminFormField label="学生范围">
                      <USelect v-model="recipients" size="sm" :items="recipientsOptions" aria-label="学生范围"
                        class="w-full" />
                    </AdminFormField>
                    <AdminFormField label="完成状态">
                      <USelect v-model="statusFilter" size="sm" :items="statusOptions" aria-label="完成状态筛选"
                        class="w-full" />
                    </AdminFormField>
                    <AdminFormField label="题目">
                      <USelect v-model="itemFilter" size="sm" :items="itemFilterOptions" aria-label="题目筛选"
                        class="w-full" />
                    </AdminFormField>
                    <AdminFormField label="正式判定">
                      <USelect v-model="verdictFilter" size="sm"
                        :items="[{ label: '全部判定', value: 'all' }, ...verdictOptions.map(value => ({ label: value, value }))]"
                        aria-label="正式判定筛选" class="w-full" />
                    </AdminFormField>
                  </div>
                </div>

                <div v-if="matrix.data.value && !matrix.data.value.data.rows.length"
                  class="flex flex-col items-center px-4 py-12 text-center">
                  <UIcon name="i-lucide-search-x" class="size-8 text-text-muted" aria-hidden="true" />
                  <p class="mt-3 font-medium">没有符合条件的学生</p>
                  <p class="mt-1 text-xs text-text-muted">调整搜索或筛选条件后再试。</p>
                  <UButton class="mt-4" variant="outline" color="neutral" size="sm" @click="resetFilters">
                    清除筛选
                  </UButton>
                </div>
                <AssignmentMatrix v-else-if="matrix.data.value" :matrix="matrix.data.value.data" :titles="titles"
                  @select="select" />

                <div v-if="matrixTotal > 50"
                  class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
                  <p class="text-xs text-text-muted tabular-nums">
                    第 {{ matrix.data.value?.data.page ?? page }} 页 / {{ totalMatrixPages }} · 共 {{ matrixTotal }} 名学生
                  </p>
                  <div class="flex items-center gap-2">
                    <UButton variant="outline" color="neutral" size="sm" :disabled="page <= 1"
                      icon="i-lucide-chevron-left" @click="page--">上一页</UButton>
                    <UButton variant="outline" color="neutral" size="sm" :disabled="page >= totalMatrixPages"
                      trailing-icon="i-lucide-chevron-right" @click="page++">下一页</UButton>
                  </div>
                </div>
              </div>
            </AsyncContent>
          </section>

          <!-- 学生的题目与进度 -->
          <section v-show="tab === 'progress' && isStudent" aria-label="题目与进度" class="flex flex-col gap-4">
            <AsyncContent
              :status="progress.error.value ? 'error' : progress.data.value ? 'data' : progress.status.value === 'pending' ? 'loading' : 'empty'"
              :error="progress.error.value ? extractApiError(progress.error.value).message : undefined"
              @retry="progress.refresh()">
              <div class="overflow-hidden rounded-md border border-border bg-bg-panel">
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
                  <div class="min-w-0">
                    <h2 class="font-semibold">本作业题目</h2>
                    <p v-if="progressSummary" class="mt-0.5 text-sm text-text-secondary tabular-nums">
                      {{ progressSummary }}</p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <div role="group" aria-label="统计范围"
                      class="inline-flex rounded border border-border bg-bg-sunken p-0.5">
                      <button type="button" :aria-pressed="scope === 'on_time'"
                        class="min-h-8 rounded-sm px-3 text-sm transition-colors"
                        :class="scope === 'on_time' ? 'bg-bg-panel font-medium text-text shadow-card' : 'text-text-secondary hover:text-text'"
                        @click="scope = 'on_time'">按时成绩</button>
                      <button type="button" :aria-pressed="scope === 'current'"
                        class="min-h-8 rounded-sm px-3 text-sm transition-colors"
                        :class="scope === 'current' ? 'bg-bg-panel font-medium text-text shadow-card' : 'text-text-secondary hover:text-text'"
                        @click="scope = 'current'">当前补做</button>
                    </div>
                    <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-refresh-cw"
                      :loading="progress.status.value === 'pending'" aria-label="刷新进度"
                      @click="progress.refresh()" />
                  </div>
                </div>
                <ol class="divide-y divide-border">
                  <li v-for="(item, index) in visibleItems" :key="item.id"
                    class="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5">
                    <span class="w-6 shrink-0 text-sm text-text-muted tabular-nums">{{ index + 1 }}</span>
                    <div class="min-w-0 flex-1 basis-[60%]">
                      <p class="break-words font-medium">{{ titles[item.reference.qualified_ref] ?? `题目 ${item.reference.display_ref}` }}</p>
                      <p class="mt-0.5 text-xs text-text-secondary">
                        <span class="font-mono">{{ item.reference.display_ref }}</span>
                        · {{ requirementLabel(item) }}
                      </p>
                    </div>
                    <span class="inline-flex shrink-0 items-center gap-1.5 text-sm tabular-nums"
                      :class="progressTone(progressCell(item.id))">
                      <UIcon v-if="progressCell(item.id)?.status === 'achieved'" name="i-lucide-check" class="size-4" />
                      {{ progressCell(item.id) ? teachingCellLabel(progressCell(item.id)!) : '未开始' }}
                    </span>
                    <div class="flex flex-wrap items-center gap-2">
                      <UButton v-if="progressCell(item.id)?.source_kind === 'submission'" variant="ghost" color="neutral"
                        size="sm" @click="selectOwnSubmission(progressCell(item.id)!)">查看原提交</UButton>
                      <UButton v-if="writable" variant="ghost" color="neutral" size="sm"
                        icon="i-lucide-message-circle-question-mark" @click="askFromItem(item.id)">求助</UButton>
                      <UButton v-if="item.resource_available" :to="{
                        path: workspaceProblemPath(slug!, item.reference.qualified_ref),
                        query: writable && task.data.value?.data.state === 'published' && progress.data.value?.data.recipient_status === 'active'
                          ? { assignment_id: id, assignment_item_id: item.id }
                          : undefined,
                      }" variant="outline" color="primary" size="sm">
                        {{ progressCell(item.id) ? '继续练习' : '开始练习' }}
                      </UButton>
                      <UBadge v-else color="warning" variant="subtle">资源不可用</UBadge>
                    </div>
                  </li>
                </ol>
                <nav v-if="allItems.length > 20" class="flex items-center justify-between gap-3 border-t border-border p-4"
                  aria-label="作业题目分页">
                  <UButton variant="outline" color="neutral" size="sm" :disabled="itemPage <= 1"
                    icon="i-lucide-chevron-left" @click="itemPage--">上一页</UButton>
                  <span class="text-sm text-text-muted tabular-nums">{{ itemPage }} / {{ Math.ceil(allItems.length / 20) }}</span>
                  <UButton variant="outline" color="neutral" size="sm" :disabled="itemPage * 20 >= allItems.length"
                    trailing-icon="i-lucide-chevron-right" @click="itemPage++">下一页</UButton>
                </nav>
              </div>
            </AsyncContent>
          </section>

          <!-- 反馈与求助：按角色决定是否挂载；挂载但切走时保留角标数据 -->
          <section v-if="canSeeFeedbackTab" v-show="tab === 'feedback'" aria-label="反馈与求助">
            <AssignmentConversation :key="key" :slug="slug!" :assignment-id="id" :is-student="isStudent"
              :can-feedback="can('feedback:write')" :can-help="can('help:manage')" :writable="!!writable"
              :target-user-id="feedbackTarget?.userId" :target-user-name="feedbackTarget?.username"
              :help-id="requestedHelp" :feedback-id="requestedFeedback" :feedback-signal="feedbackSignal"
              :items="conversationItems" :ask-item-id="askItemId" :ask-signal="askSignal"
              @pending-help="onPendingHelp" @clear-target="clearFeedbackTarget" />
          </section>
        </template>

        <template v-else>
          <AssignmentDraftPreview v-if="canManage" :key="`${key}:${task.data.value.data.revision}`" :slug="slug!"
            :task="task.data.value.data" />
        </template>
      </div>
    </AsyncContent>

    <USlideover v-model:open="drawer"
      :title="selected ? `${selected.username} · ${selected.reference}` : '学生提交与反馈'"
      :ui="{ content: 'w-full sm:max-w-xl' }">
      <template #body>
        <div v-if="selected" class="space-y-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="inline-flex items-center gap-1.5 text-sm tabular-nums" :class="cellTone(selected.cell)">
              <UIcon v-if="selected.cell.status === 'achieved' && !selected.cell.updating" name="i-lucide-check"
                class="size-4" aria-hidden="true" />
              <span v-else-if="!selected.cell.updating && selected.cell.status === 'below_target'"
                class="size-1.5 rounded-full bg-warning-text" aria-hidden="true" />
              {{ teachingCellLabel(selected.cell) }}
            </p>
            <UBadge v-if="selected.cell.late" color="warning" variant="subtle" size="sm">逾期提交</UBadge>
          </div>
          <AssignmentCellSubmissions v-if="!isStudent && can('submissions:read')"
            :key="`${key}:${selected.userId}:${selected.cell.item_id}:${scope}`" :slug="slug!" :assignment-id="id"
            :classroom-id="task.data.value!.data.classroom_id" :user-id="selected.userId"
            :item-id="selected.cell.item_id" :scope="scope" :can-annotate="!!writable && can('feedback:write')" />
          <SubmissionReview
            v-if="isStudent && selected.cell.source_submission_id && selected.cell.source_kind === 'submission'"
            :key="selected.cell.source_submission_id" :slug="slug!" :classroom-id="task.data.value!.data.classroom_id"
            :submission-id="selected.cell.source_submission_id" :can-annotate="!!writable && can('feedback:write')" />
          <p v-else-if="isStudent" class="text-sm text-text-muted">
            {{ selected.cell.updating ? '成绩更新后可查看来源提交。' : selected.cell.source_kind === 'objective' ? '此项为客观题提交。' : '当前没有可查看的代码提交。' }}
          </p>
          <div v-if="!isStudent && can('feedback:write') && writable"
            class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p class="text-xs text-text-muted">需要说明下一步改进时，可直接给这名学生写反馈。</p>
            <UButton variant="outline" icon="i-lucide-pen-line" @click="giveFeedbackFromDrawer">
              写反馈给该生
            </UButton>
          </div>
        </div>
      </template>
    </USlideover>

    <USlideover v-if="canManage" v-model:open="manageOpen" title="管理作业" :ui="{ content: 'w-full sm:max-w-lg' }">
      <template #body>
        <div class="space-y-6">
          <section v-if="task.data.value && writable" class="space-y-3">
            <h3 class="text-sm font-semibold">发布与生命周期</h3>
            <AssignmentActions :key="key" :slug="slug!" :task="task.data.value.data" :writable="!!classroomWritable"
              @changed="task.refresh()" />
            <p class="text-xs text-text-muted">
              发布后题目集合与达标要求固定；版本与有效成绩仍跟随本域题库。
            </p>
          </section>
          <section v-if="task.data.value && writable" class="space-y-3">
            <h3 class="text-sm font-semibold">派生新作业</h3>
            <div class="flex flex-col gap-3">
              <AssignmentCopy :key="`${key}:copy`" :slug="slug!" :task="task.data.value.data"
                :matrix="matrix.data.value?.data" :writable="!!classroomWritable" />
              <AssignmentRemediation :key="`${key}:remediation`" :slug="slug!" :task="task.data.value.data"
                :writable="!!classroomWritable" :can-read-progress="can('progress:read')" />
            </div>
          </section>
        </div>
      </template>
    </USlideover>
  </div>
</template>
