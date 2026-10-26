<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; assignmentId: string }>();
const actor = useState<{ id: string } | null>('auth:user', () => null), page = ref(1), education = useEducationApi();
const { data, status, error, refresh } = await useViewAsyncData(
  'history',
  () => educationCacheKey(props.slug, actor.value?.id ?? null, props.assignmentId, 'history', page.value),
  () => education.history(props.slug, props.assignmentId, page.value),
);
</script>
<template>
  <section class="overflow-hidden rounded-md border border-border bg-bg-panel" aria-labelledby="assignment-history">
    <div class="border-b border-border px-4 py-3">
      <h2 id="assignment-history" class="font-semibold">版本与策略变化依据</h2>
      <p class="mt-1 text-xs text-text-muted">
        题目集合和达标要求在发布时固定；作答版本、有效策略和重测成绩持续跟随本域题库。
      </p>
    </div>
    <AsyncContent
      :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无变化记录" @retry="refresh()">
      <article v-for="entry in data?.data.data" :key="entry.id"
        class="border-b border-border px-4 py-3 text-sm last:border-0">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono text-xs text-text-secondary">{{ entry.display_ref }}</span>
          <span class="text-xs text-text-muted tabular-nums">作答版本 {{ entry.answer_version ?? '暂不可用' }} · 策略 {{ entry.policy_revision }}</span>
        </div>
        <p class="mt-1">{{ entry.policy_mode === 'any' ? '允许任一有效版本' : '仅采用选定版本成绩' }} · {{ entry.reason }}</p>
        <p class="mt-1 text-xs text-text-muted">{{ entry.actor_name }} · {{ new Date(entry.created_at).toLocaleString() }}</p>
      </article>
    </AsyncContent>
    <div v-if="(data?.data.total ?? 0) > 50" class="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
      <UButton :disabled="page <= 1" variant="ghost" color="neutral" size="sm" icon="i-lucide-chevron-left"
        aria-label="上一页变化记录" @click="page--" />
      <span class="text-xs text-text-muted tabular-nums">{{ page }}</span>
      <UButton :disabled="page * 50 >= (data?.data.total ?? 0)" variant="ghost" color="neutral" size="sm"
        trailing-icon="i-lucide-chevron-right" aria-label="下一页变化记录" @click="page++" />
    </div>
  </section>
</template>
