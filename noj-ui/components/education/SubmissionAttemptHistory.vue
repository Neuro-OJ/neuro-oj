<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { teachingAttemptLabel } from '~/utils/education-submissions';
import type { TeachingSubmission } from '~/utils/education-submissions';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; classroomId: string; submissionId: string; kind: TeachingSubmission['kind'] }>();
const api = useEducationApi(), { user } = useAuth(), page = ref(1);
const key = computed(() => educationCacheKey(props.slug, user.value?.id ?? null, props.classroomId, `${props.kind}:${props.submissionId}:attempts`));
const records = await useAsyncData(() => `${key.value}:${page.value}`, () => api.submissionAttempts(props.slug, props.classroomId, props.kind, props.submissionId, page.value));
watch(() => key.value, () => { page.value = 1; });
</script>
<template>
  <section class="flex flex-col gap-3">
    <h3 class="font-semibold">正式评测沿革</h3>
    <p class="text-xs text-text-muted">按尝试顺序展示。重测失败不会替代已有正式判定；当前正式结果仍需符合使用域版本策略。</p>
    <AsyncContent :status="records.error.value ? 'error' : records.status.value === 'pending' ? 'loading' : records.data.value?.data.data.length ? 'data' : 'empty'"
      :error="records.error.value ? extractApiError(records.error.value).message : undefined" empty-text="暂无评测尝试" @retry="records.refresh()">
      <UAlert v-if="records.data.value && !records.data.value.data.resource_available" color="warning" title="资源已不可用，仅保留历史成绩摘要" />
      <article v-for="attempt in records.data.value?.data.data" :key="attempt.id" class="space-y-2 rounded border border-border p-3">
        <p class="text-sm tabular-nums">第 {{ attempt.sequence + 1 }} 次 · {{ teachingAttemptLabel(attempt) }}</p>
        <p class="text-xs text-text-muted">{{ new Date(attempt.created_at).toLocaleString() }} · {{ attempt.source === 'initial' ? '首次评测' : attempt.source === 'rejudge' ? '重测' : attempt.source }} · {{ attempt.problem_version_id ? `版本 ${attempt.problem_version_id.slice(0, 8)}` : '版本未知' }}</p>
        <p class="text-xs">{{ attempt.current_formal ? '该版本当前正式判定' : '历史尝试' }} · {{ attempt.matches_policy ? '符合当前版本策略' : '不符合当前版本策略' }}</p>
        <div v-if="attempt.oi" class="space-y-3 overflow-x-auto">
          <div v-for="task in attempt.oi.subtasks" :key="task.id" class="space-y-2">
            <p class="text-sm tabular-nums">子任务 {{ task.id }} · {{ task.verdict ?? task.status ?? '—' }} · {{ task.score ?? '—' }}/{{ task.max_score ?? '—' }}</p>
            <table v-if="task.cases?.length" class="w-full text-left text-xs tabular-nums"><thead><tr><th>测试点</th><th>判定</th><th>得分</th><th>时间 / 内存</th></tr></thead><tbody><tr v-for="(test, index) in task.cases" :key="index"><td>{{ test.case_id ?? test.id ?? index + 1 }}</td><td>{{ test.verdict ?? test.status ?? '—' }}</td><td>{{ test.score ?? '—' }}/{{ test.max_score ?? '—' }}</td><td>{{ test.time_ms ?? '—' }} ms / {{ test.memory_kb ?? '—' }} KiB</td></tr></tbody></table>
          </div>
          <table v-if="attempt.oi.cases?.length" class="w-full text-left text-xs tabular-nums"><thead><tr><th>测试点</th><th>判定</th><th>得分</th><th>时间 / 内存</th></tr></thead><tbody><tr v-for="(test, index) in attempt.oi.cases" :key="index"><td>{{ test.case_id ?? test.id ?? index + 1 }}</td><td>{{ test.verdict ?? test.status ?? '—' }}</td><td>{{ test.score ?? '—' }}/{{ test.max_score ?? '—' }}</td><td>{{ test.time_ms ?? '—' }} ms / {{ test.memory_kb ?? '—' }} KiB</td></tr></tbody></table>
        </div>
      </article>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((records.data.value?.data.total ?? 0) / 25)" @page-change="page = $event" />
    </AsyncContent>
  </section>
</template>
