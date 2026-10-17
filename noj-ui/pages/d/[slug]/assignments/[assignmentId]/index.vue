<script setup lang="ts">
import { assignmentPhase, classroomCan, educationCacheKey, teachingCellLabel } from '~/utils/education';
import type { TeachingCapability, TeachingCell } from '~/utils/education';
import { workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.assignmentId)), scope = ref<'on_time' | 'current'>('on_time');
const page = ref(1), recipients = ref('current'), statusFilter = ref('all'), search = ref('');
const searchDraft = ref(''), itemFilter = ref('all'), verdictFilter = ref('all');
const selected = ref<{ userId: string; username: string; reference: string; cell: TeachingCell } | null>(null),
  drawer = ref(false),
  downloading = ref(false);
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
);
const progress = await useAsyncData(
  () => `${key.value}:progress:${scope.value}:${isStudent.value}:${!!task.data.value?.data.published_at}`,
  () =>
    isStudent.value && task.data.value?.data.published_at
      ? education.progress(slug.value!, id.value, scope.value)
      : Promise.resolve(null),
);
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
const requestedHelp = computed(() => typeof route.query.help === 'string' ? route.query.help : undefined);
const requestedFeedback = computed(() => typeof route.query.feedback === 'string' ? route.query.feedback : undefined);
const showHistory = ref(route.query.history === '1');
watch(() => route.query.history, (value) => {
  if (value === '1') showHistory.value = true;
});
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
watch([scope, recipients, statusFilter, search, itemFilter, verdictFilter], () => {
  page.value = 1;
});
watch([() => slug.value, () => id.value, () => actor.value?.id], () => {
  scope.value = 'on_time';
  recipients.value = 'current';
  statusFilter.value = 'all';
  search.value = searchDraft.value = '';
  itemFilter.value = verdictFilter.value = 'all';
  selected.value = null;
  drawer.value = false;
  page.value = 1;
});
function select(userId: string, cell: TeachingCell) {
  selected.value = {
    userId,
    username: matrix.data.value?.data.rows.find((row) => row.user_id === userId)?.username ?? '本人',
    reference:
      (matrix.data.value?.data.items ?? progress.data.value?.data.items ?? []).find((item) => item.id === cell.item_id)
        ?.reference.display_ref ?? '',
    cell,
  };
  drawer.value = true;
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
useSeoMeta({ title: () => task.data.value?.data.title ?? '作业' });
</script>
<template>
  <div class="flex flex-col gap-5">
    <AsyncContent
      :status="task.error.value ? 'error' : task.data.value ? 'data' : task.status.value === 'pending' ? 'loading' : 'empty'"
      :error="task.error.value ? extractApiError(task.error.value).message : undefined" @retry="task.refresh()">
      <section v-if="task.data.value" class="flex flex-col gap-4">
        <UButton class="self-start" :to="workspacePath(slug!, `classrooms/${task.data.value.data.classroom_id}`)" variant="ghost"
          icon="i-lucide-arrow-left">返回班级</UButton>
        <AdminPageHeader :title="task.data.value.data.title"
          :description="assignmentPhase(task.data.value.data)" icon="i-lucide-clipboard-list" />
        <UAlert v-if="task.data.value.data.publish_error" color="warning" title="定时发布失败"
          :description="task.data.value.data.publish_error" />
        <p v-if="task.data.value.data.state === 'scheduled'"
          class="text-sm text-text-muted">预定发布时间：{{ new Date(task.data.value.data.publish_at!).toLocaleString() }}</p>
        <div v-if="can('assignments:manage')" class="flex flex-wrap gap-3">
          <ClientOnly>
            <AssignmentActions :key="key" :slug="slug!" :task="task.data.value.data" :writable="!!classroomWritable"
              @changed="task.refresh()" />
            <AssignmentCopy :key="`${key}:copy`" :slug="slug!" :task="task.data.value.data"
              :matrix="matrix.data.value?.data"
              :writable="!!classroomWritable" />
            <AssignmentRemediation :key="`${key}:remediation`" :slug="slug!" :task="task.data.value.data"
              :writable="!!classroomWritable" :can-read-progress="can('progress:read')" />
          </ClientOnly>
        </div>
        <AssignmentDraftPreview v-if="can('assignments:manage') && !task.data.value.data.published_at"
          :key="`${key}:${task.data.value.data.revision}`" :slug="slug!" :task="task.data.value.data" />
        <MarkdownRenderer v-if="task.data.value.data.description"
          :content="task.data.value.data.description" />
        <p v-if="task.data.value.data.deadline_at"
          class="text-sm text-text-muted">截止：{{ new Date(task.data.value.data.deadline_at).toLocaleString() }}。截止后可以继续练习，按时成绩与补做进度分别统计。</p>
      </section>
    </AsyncContent>
    <template v-if="task.data.value?.data.published_at && !task.error.value">
      <div class="flex flex-wrap items-end gap-3">
        <AdminFormField label="统计范围">
          <USelect v-model="scope"
            :items="[{ label: '按时成绩', value: 'on_time' }, { label: '当前补做进度', value: 'current' }]"
            aria-label="成绩统计范围" />
        </AdminFormField>
        <template v-if="can('progress:read')">
          <AdminFormField label="学生范围">
            <USelect v-model="recipients"
              :items="[{ label: '当前学生', value: 'current' }, { label: '历史学生', value: 'historical' }, { label: '全部目标学生', value: 'all' }]"
              aria-label="学生范围" />
          </AdminFormField>
          <AdminFormField label="完成状态">
            <USelect v-model="statusFilter"
              :items="[{ label: '全部', value: 'all' }, { label: '未开始', value: 'not_started' }, { label: '未达标', value: 'below_target' }, { label: '已达标', value: 'achieved' }, { label: '评测中', value: 'judging' }, { label: '资源不可用', value: 'unavailable' }, { label: '更新中', value: 'updating' }]"
              aria-label="完成状态筛选" />
          </AdminFormField>
          <AdminFormField label="学生搜索">
            <div class="flex items-center gap-2">
            <UInput v-model="searchDraft" aria-label="学生搜索" placeholder="学生用户名"
              @keyup.enter="search = searchDraft.trim()" />
            <UButton variant="ghost" @click="search = searchDraft.trim()">搜索</UButton>
            </div>
          </AdminFormField>
          <AdminFormField label="题目">
            <USelect v-model="itemFilter"
              :items="[{ label: '全部题目', value: 'all' }, ...(matrix.data.value?.data.items ?? []).map(i => ({ label: i.reference.display_ref, value: i.id }))]"
              aria-label="题目筛选" />
          </AdminFormField>
          <AdminFormField label="正式判定">
            <USelect v-model="verdictFilter"
              :items="[{ label: '全部判定', value: 'all' }, ...['AC', 'WA', 'CE', 'TLE', 'MLE', 'RE', 'OLE'].map(v => ({ label: v, value: v }))]"
              aria-label="正式判定筛选" />
          </AdminFormField>
          <UButton variant="outline" :loading="downloading" @click="download">导出 CSV</UButton>
        </template>
      </div>
      <AsyncContent v-if="can('progress:read')"
        :status="matrix.error.value ? 'error' : matrix.data.value ? 'data' : matrix.status.value === 'pending' ? 'loading' : 'empty'"
        :error="matrix.error.value ? extractApiError(matrix.error.value).message : undefined" @retry="matrix.refresh()">
        <AssignmentMatrix v-if="matrix.data.value" :matrix="matrix.data.value.data" @select="select" />
        <div
          class="flex flex-wrap items-center gap-3"><UButton :disabled="page <= 1" variant="outline" @click="page--">上一页</UButton><span class="text-sm tabular-nums">{{ page }} · {{ matrix.data.value?.data.total ?? 0 }} 名学生</span><UButton :disabled="page * 50 >= (matrix.data.value?.data.total ?? 0)" variant="outline" @click="page++">下一页</UButton><UButton variant="ghost" icon="i-lucide-refresh-cw" @click="matrix.refresh()">刷新成绩</UButton></div>
      </AsyncContent>
      <AsyncContent v-if="isStudent"
        :status="progress.error.value ? 'error' : progress.data.value ? 'data' : progress.status.value === 'pending' ? 'loading' : 'empty'"
        :error="progress.error.value ? extractApiError(progress.error.value).message : undefined"
        @retry="progress.refresh()">
        <UCard v-for="item in progress.data.value?.data.items" :key="item.id">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-medium">{{ item.reference.display_ref }}</p>
              <p
                class="mt-1 text-sm tabular-nums">{{ progress.data.value?.data.cells.find(c => c.item_id === item.id) ? teachingCellLabel(progress.data.value.data.cells.find(c => c.item_id === item.id)!) : '未开始' }}</p>
            </div>
            <div class="flex gap-2">
              <UButton
                v-if="progress.data.value?.data.cells.find(c => c.item_id === item.id)?.source_kind === 'submission'"
                variant="ghost"
                @click="select(actor!.id, progress.data.value!.data.cells.find(c => c.item_id === item.id)!)">查看原提交</UButton>
              <UButton v-if="item.resource_available" :to="{
                path: workspaceProblemPath(slug!, item.reference.qualified_ref),
                query: writable && task.data.value.data.state === 'published' && progress.data.value?.data.recipient_status === 'active'
                  ? { assignment_id: id, assignment_item_id: item.id }
                  : undefined,
              }"
                variant="outline">继续练习</UButton>
              <UBadge v-else color="warning">资源不可用</UBadge>
            </div>
          </div>
        </UCard>
      </AsyncContent>
      <TrainingComparison v-if="isStudent && actor" :key="`${key}:own-comparison`" :slug="slug!" :assignment-id="id"
        :user-id="actor.id" :anchor="task.data.value.data.published_at" />
      <div v-if="selected && can('feedback:write')"
        class="flex flex-wrap items-center gap-3 rounded border border-primary/30 bg-primary-bg p-3">
        <p
          class="text-sm">已选学生：<strong>{{ selected.username }}</strong> · 查看题目 {{ selected.reference }}。下方反馈发送给该学生，覆盖本份作业。</p>
        <UButton variant="outline" @click="selected = null">改为全体反馈</UButton>
      </div>
      <AssignmentConversation :key="key" :slug="slug!" :assignment-id="id" :is-student="isStudent"
        :can-feedback="can('feedback:write')" :can-help="can('help:manage')" :writable="!!writable"
        :target-user-id="selected?.userId" :target-user-name="selected?.username" :help-id="requestedHelp"
        :feedback-id="requestedFeedback" />
      <UButton class="self-start" variant="outline" icon="i-lucide-history"
        @click="showHistory = !showHistory">{{ showHistory ? '收起变化依据' : '查看版本与策略变化依据' }}</UButton>
      <AssignmentHistory v-if="showHistory" :key="`${key}:history`" :slug="slug!" :assignment-id="id" />
      <USlideover v-model:open="drawer"
        :title="selected ? `${selected.username} · ${selected.reference}` : '学生提交与反馈'">
        <template #body>
          <div v-if="selected" class="space-y-4">
            <p class="text-sm tabular-nums">{{ teachingCellLabel(selected.cell) }}</p>
            <AssignmentCellSubmissions v-if="!isStudent && can('submissions:read')"
              :key="`${key}:${selected.userId}:${selected.cell.item_id}:${scope}`" :slug="slug!" :assignment-id="id"
              :classroom-id="task.data.value.data.classroom_id" :user-id="selected.userId"
              :item-id="selected.cell.item_id" :scope="scope" :can-annotate="!!writable && can('feedback:write')" />
            <TrainingComparison v-if="can('progress:read') && !isStudent" :key="`${key}:${selected.userId}:comparison`"
              :slug="slug!" :assignment-id="id" :user-id="selected.userId"
              :anchor="task.data.value.data.published_at" />
            <SubmissionReview
              v-if="isStudent && selected.cell.source_submission_id && selected.cell.source_kind === 'submission'"
              :key="selected.cell.source_submission_id" :slug="slug!" :classroom-id="task.data.value.data.classroom_id"
              :submission-id="selected.cell.source_submission_id" :can-annotate="!!writable && can('feedback:write')" />
            <p v-else-if="isStudent"
              class="text-sm text-text-muted">{{ selected.cell.updating ? '成绩更新后可查看来源提交。' : selected.cell.source_kind === 'objective' ? '此项为客观题提交。' : '当前没有可查看的代码提交。' }}</p>
          </div>
        </template>
      </USlideover>
    </template>
  </div>
</template>
