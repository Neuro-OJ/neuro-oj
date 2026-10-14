<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { teachingSubmissionResult } from '~/utils/education-submissions';
import type { TeachingSubmission } from '~/utils/education-submissions';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; assignmentId: string; classroomId: string; userId: string; itemId: string; scope: 'on_time' | 'current'; canAnnotate: boolean }>();
const api = useEducationApi(), { user } = useAuth(), page = ref(1), selected = ref<TeachingSubmission | null>(null);
const key = computed(() => educationCacheKey(props.slug, user.value?.id ?? null, props.assignmentId, `${props.userId}:${props.itemId}:${props.scope}:evidence`));
const records = await useAsyncData(() => `${key.value}:${page.value}`, () => api.assignmentItemSubmissions(props.slug, props.assignmentId, props.userId, props.itemId, props.scope, page.value));
watch(() => key.value, () => { page.value = 1; selected.value = null; });
</script>
<template>
  <section class="space-y-3">
    <h3 class="font-semibold">{{ scope === 'on_time' ? '按时成绩' : '补做进度' }}提交依据</h3>
    <AsyncContent :status="records.error.value ? 'error' : records.status.value === 'pending' ? 'loading' : records.data.value?.data.data.length ? 'data' : 'empty'"
      :error="records.error.value ? extractApiError(records.error.value).message : undefined" empty-text="此统计范围暂无获授权提交" @retry="records.refresh()">
      <p v-if="records.data.value" class="text-xs text-text-muted">版本策略：{{ records.data.value.data.policy.mode === 'any' ? '任一正式版本' : `固定版本 ${records.data.value.data.policy.required_version_id?.slice(0, 8)}` }} · 修订 {{ records.data.value.data.policy.revision }}</p>
      <div class="divide-y divide-border rounded border border-border"><button v-for="row in records.data.value?.data.data" :key="`${row.kind}:${row.id}`" class="block w-full space-y-1 p-3 text-left hover:bg-primary-bg" @click="selected = row"><p class="text-sm tabular-nums">{{ teachingSubmissionResult(row) }}</p><p class="text-xs text-text-muted">{{ new Date(row.created_at).toLocaleString() }} · {{ row.kind === 'objective' ? '客观题' : row.has_artifact ? '产物' : row.language }} · {{ row.candidate_attempt_ids.length ? '存在当前正式候选' : '暂无当前正式候选' }}</p></button></div>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((records.data.value?.data.total ?? 0) / 25)" @page-change="page = $event" />
      <template v-if="selected">
        <SubmissionAttemptHistory :key="`${key}:${selected.kind}:${selected.id}`" :slug="slug" :classroom-id="classroomId" :submission-id="selected.id" :kind="selected.kind" />
        <SubmissionReview v-if="selected.kind === 'submission'" :key="selected.id" :slug="slug" :classroom-id="classroomId" :submission-id="selected.id" :can-annotate="canAnnotate" />
      </template>
    </AsyncContent>
  </section>
</template>
