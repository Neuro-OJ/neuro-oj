<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; assignmentId: string }>();
const actor = useState<{ id: string } | null>('auth:user', () => null), page = ref(1), education = useEducationApi();
const { data, status, error, refresh } = await useAsyncData(
  () => educationCacheKey(props.slug, actor.value?.id ?? null, props.assignmentId, 'history', page.value),
  () => education.history(props.slug, props.assignmentId, page.value),
);
</script>
<template>
  <UCard id="assignment-history">
    <h2 class="mb-3 font-semibold">版本与策略变化依据</h2>
    <p
      class="mb-3 text-sm text-text-muted">题目集合和达标要求在发布时固定；作答版本、有效策略和重测成绩持续跟随本域题库。</p>
    <AsyncContent
      :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无变化记录" @retry="refresh()">
      <article v-for="entry in data?.data.data" :key="entry.id" class="border-t border-border py-3 text-sm">
        <div
          class="flex flex-wrap justify-between gap-2"><span class="font-medium">{{ entry.display_ref }}</span><span class="tabular-nums">作答版本 {{ entry.answer_version ?? '暂不可用' }} · 策略 {{ entry.policy_revision }}</span></div>
        <p
          class="mt-1">{{ entry.policy_mode === 'any' ? '允许任一有效版本' : '仅采用选定版本成绩' }} · {{ entry.reason }}</p>
        <p
          class="mt-1 text-xs text-text-muted">{{ entry.actor_name }} · {{ new Date(entry.created_at).toLocaleString() }}</p>
      </article>
    </AsyncContent>
    <div v-if="(data?.data.total ?? 0) > 50" class="mt-3 flex gap-2">
      <UButton :disabled="page <= 1" variant="ghost" @click="page--">上一页</UButton>
      <UButton :disabled="page * 50 >= (data?.data.total ?? 0)" variant="ghost" @click="page++">下一页</UButton>
    </div>
  </UCard>
</template>
