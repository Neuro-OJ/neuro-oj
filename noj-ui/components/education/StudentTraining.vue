<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import type { ClassroomDetail, ClassroomMember } from '~/utils/education';
import { teachingSubmissionResult } from '~/utils/education-submissions';
import type { TeachingSubmission } from '~/utils/education-submissions';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<
  { slug: string; classroom: ClassroomDetail; studentId: string; student?: ClassroomMember; writable: boolean }
>();
const education = useEducationApi(), { user } = useAuth();
const read = computed(() => classroomCan(props.classroom, 'submissions:read'));
const progress = computed(() => classroomCan(props.classroom, 'progress:read'));
const feedback = computed(() => classroomCan(props.classroom, 'feedback:write'));
const page = ref(1),
  taskPage = ref(1),
  kind = ref<'all' | TeachingSubmission['kind']>('all'),
  open = ref(false),
  selected = ref<TeachingSubmission | null>(null);
const base = computed(() =>
  educationCacheKey(props.slug, user.value?.id ?? null, props.classroom.id, `student:${props.studentId}`)
);
const records = await useAsyncData(
  () => `${base.value}:submissions:${page.value}:${kind.value}:${read.value}`,
  () =>
    read.value
      ? education.studentSubmissions(
        props.slug,
        props.classroom.id,
        props.studentId,
        page.value,
        kind.value === 'all' ? undefined : kind.value,
      )
      : Promise.resolve(null),
);
const detail = await useAsyncData(
  () => `${base.value}:detail:${selected.value?.kind}:${selected.value?.id}:${read.value}`,
  () =>
    read.value && selected.value
      ? education.studentSubmission(props.slug, props.classroom.id, selected.value.kind, selected.value.id)
      : Promise.resolve(null),
);
const tasks = await useAsyncData(
  () => `${base.value}:tasks:${taskPage.value}:${progress.value}:${feedback.value}`,
  () =>
    progress.value || feedback.value
      ? education.assignments(props.slug, props.classroom.id, taskPage.value)
      : Promise.resolve(null),
);
watch(kind, () => {
  page.value = 1;
});
watch([() => props.slug, () => props.classroom.id, () => props.studentId, () => user.value?.id], () => {
  selected.value = null;
  open.value = false;
  page.value = taskPage.value = 1;
});
function select(row: TeachingSubmission) {
  selected.value = row;
  open.value = true;
}
useSeoMeta({ title: () => `${props.student?.username ?? '学生'} · 训练详情` });
</script>
<template>
  <div class="flex flex-col gap-5">
    <LibraryPageHeader :title="`${student?.username ?? '学生'} · 训练详情`" :description="classroom.name" icon="i-lucide-activity" />
    <UAlert v-if="student && (!student.effective_active || student.role !== 'student')" color="info"
      title="历史学生记录" description="仅保留本班已有作业或批注授权依据，不继续获取离班后的个人练习。" />
    <template v-if="read">
      <div class="flex flex-wrap items-end gap-3">
        <h2 class="mr-auto font-semibold">授权同域提交</h2>
        <AdminFormField label="提交类型">
        <USelect v-model="kind"
          :items="[{ label: '全部类型', value: 'all' }, { label: '代码／产物', value: 'submission' }, { label: '客观题', value: 'objective' }]"
          aria-label="学生提交类型" />
        </AdminFormField>
        <UButton variant="outline" color="neutral" :loading="records.status.value === 'pending'" @click="records.refresh()">刷新提交</UButton>
      </div>
      <p
        class="text-sm text-text-secondary">展示获授权的同域提交；进行中比赛的保密结果暂不显示。</p>
      <AsyncContent
        :status="records.error.value ? 'error' : records.status.value === 'pending' ? 'loading' : records.data.value?.data.data.length ? 'data' : 'empty'"
        :error="records.error.value ? extractApiError(records.error.value).message : undefined"
        empty-text="暂无获授权的同域提交" @retry="records.refresh()">
        <div
          class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
          <button v-for="row in records.data.value?.data.data" :key="`${row.kind}:${row.id}`"
            class="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-primary-bg focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
            @click="select(row)">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-3">
                <span class="break-all font-mono text-primary">{{ row.display_ref }}</span>
                <span class="text-sm text-text-secondary">{{ row.kind === 'objective' ? '客观题' : row.has_artifact ? '产物' : row.language }}</span>
              </div>
              <p class="mt-1 text-xs tabular-nums text-text-muted">{{ new Date(row.created_at).toLocaleString() }}{{ row.contest_id ? ' · 比赛提交' : '' }}</p>
            </div>
            <span class="flex items-center gap-2 text-sm tabular-nums">{{ teachingSubmissionResult(row) }}<UIcon name="i-lucide-chevron-right" class="size-4 text-text-muted" /></span>
          </button>
        </div>
        <PaginationNav :current-page="page" :total-pages="Math.ceil((records.data.value?.data.total ?? 0) / 50)"
          @page-change="page = $event" />
      </AsyncContent>
    </template>
    <UAlert v-else color="info" title="未授予学生提交读取能力"
      description="学情读取和提交读取分别授权，此页面不会读取或展示学生代码。" />
    <section v-if="progress || feedback" class="flex flex-col gap-3">
      <h2 class="font-semibold">本班作业{{ progress && feedback ? '学情与反馈' : progress ? '学情' : '反馈' }}</h2>
      <AsyncContent
        :status="tasks.error.value ? 'error' : tasks.status.value === 'pending' ? 'loading' : tasks.data.value?.data.length ? 'data' : 'empty'"
        :error="tasks.error.value ? extractApiError(tasks.error.value).message : undefined" @retry="tasks.refresh()">
        <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
        <div v-for="task in tasks.data.value?.data" :key="task.id" class="p-4">
          <div
            class="flex flex-wrap items-center justify-between gap-3"><span class="min-w-0 break-words font-medium">{{ task.title }}</span><UButton :to="workspacePath(slug, `assignments/${task.id}`)" variant="ghost">{{ progress ? '进入作业学情' : '进入作业反馈' }}</UButton></div>
        </div>
        </div>
        <div
          v-if="(tasks.data.value?.data.length ?? 0) >= 50 || taskPage > 1"
          class="flex flex-wrap items-center justify-between gap-3"><UButton variant="outline" :disabled="taskPage === 1" @click="taskPage--">上一页作业</UButton><span class="text-sm tabular-nums">第 {{ taskPage }} 页</span><UButton variant="outline" :disabled="(tasks.data.value?.data.length ?? 0) < 50" @click="taskPage++">下一页作业</UButton></div>
      </AsyncContent>
    </section>
    <USlideover v-model:open="open" title="原提交与教学批注" :ui="{ content: 'w-full sm:max-w-3xl' }">
      <template #body>
        <AsyncContent
          :status="detail.error.value ? 'error' : detail.status.value === 'pending' ? 'loading' : detail.data.value ? 'data' : 'empty'"
          :error="detail.error.value ? extractApiError(detail.error.value).message : undefined"
          @retry="detail.refresh()">
          <template v-if="detail.data.value">
            <p class="mb-3 font-mono">{{ detail.data.value.data.display_ref }}</p>
            <p class="mb-3 text-sm tabular-nums">{{ teachingSubmissionResult(detail.data.value.data) }}</p>
            <SubmissionAttemptHistory :key="`${base}:${detail.data.value.data.kind}:${detail.data.value.data.id}:attempts`" :slug="slug" :classroom-id="classroom.id" :submission-id="detail.data.value.data.id" :kind="detail.data.value.data.kind" class="mb-4" />
            <ArtifactDownload v-if="detail.data.value.data.kind === 'submission' && detail.data.value.data.has_artifact"
              :key="`${slug}:${classroom.id}:${detail.data.value.data.id}`"
              :endpoint="`/api/v1/domains/${encodeURIComponent(slug)}/classrooms/${encodeURIComponent(classroom.id)}/submissions/submission/${encodeURIComponent(detail.data.value.data.id)}/artifact`"
              :file-name="detail.data.value.data.file_name ?? `submission-${detail.data.value.data.id}.zip`" class="mb-4" />
            <p v-if="detail.data.value.data.time_ms !== null || detail.data.value.data.memory_kb !== null"
              class="mb-4 text-xs text-text-muted"><span v-if="detail.data.value.data.time_ms !== null">{{ detail.data.value.data.time_ms }} ms</span><span v-if="detail.data.value.data.memory_kb !== null" class="ml-3">{{ detail.data.value.data.memory_kb }} KiB</span></p>
            <SubmissionReview v-if="detail.data.value.data.kind === 'submission'"
              :key="`${base}:${detail.data.value.data.id}`" :slug="slug" :classroom-id="classroom.id"
              :submission-id="detail.data.value.data.id" :can-annotate="writable && feedback" />
            <div v-else class="space-y-3">
              <h3 class="font-semibold">学生原提交的客观题答案</h3>
              <p v-for="(answer, key, index) in detail.data.value.data.answers" :key="key"
                class="break-all text-sm"><span class="text-xs text-text-muted">答案条目 {{ index + 1 }}：</span>{{ answer.map((value) => typeof value === 'boolean' ? value ? '选择“对”' : '选择“错”' : value).join('、') || '未作答' }}</p>
              <p class="text-xs text-text-muted">此处仅显示原提交答案，不提供标准答案或逐题正确性。</p>
            </div>
          </template>
        </AsyncContent>
      </template>
    </USlideover>
  </div>
</template>
