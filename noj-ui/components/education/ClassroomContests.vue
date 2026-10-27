<script setup lang="ts">
import { formatDateTime } from '~/utils/submissionFormat';
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';

const props = defineProps<{ slug: string; classroomId?: string }>();
const { user } = useAuth();
const api = useDomainContests();
const page = ref(1);
watch(() => [props.slug, props.classroomId, user.value?.id], () => page.value = 1);
const key = computed(() => educationCacheKey(
  props.slug, user.value?.id ?? null, 'linked-contests', props.classroomId ?? 'my-learning', page.value,
));
const { data, error, status, refresh } = await useAsyncData(key, () => api.list(props.slug, page.value, {
  classroom_id: props.classroomId,
  my_classrooms: !props.classroomId,
}));
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-trophy" class="size-5 text-primary" />
      <h2 class="text-base font-semibold text-text">班级关联竞赛</h2>
      <span v-if="data" class="text-xs text-text-muted">共 {{ data.pagination.total }} 场</span>
    </div>
    <p class="text-sm text-text-secondary">{{ classroomId ? '本班关联的可见竞赛，可进入详情报名、作答与查看榜单。' : '汇总你当前所在班级的可见竞赛，同一竞赛只显示一次。' }}</p>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无可查看的班级关联竞赛" @retry="refresh()">
      <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
        <article v-for="contest in data?.data" :key="contest.id" class="flex flex-wrap items-center justify-between gap-4 p-4">
          <div class="min-w-0 space-y-2">
            <NuxtLink :to="`/d/${slug}/contests/${contest.id}`" class="font-semibold text-text hover:text-primary">{{ contest.title }}</NuxtLink>
            <UBadge class="ml-2" :color="contest.status === 'running' ? 'success' : 'neutral'" variant="subtle">{{ { pending: '未开始', running: '进行中', ended: '已结束' }[contest.status] }}</UBadge>
            <p class="text-xs text-text-secondary">{{ formatDateTime(contest.start_time) }} — {{ formatDateTime(contest.end_time) }}</p>
            <p class="text-xs text-text-muted">{{ contest.classrooms?.map(room => room.name).join('、') }} · {{ contest.problem_count }} 道题 · {{ contest.participant_count }} 人参赛</p>
          </div>
          <UButton :to="`/d/${slug}/contests/${contest.id}`" variant="outline" size="sm">进入竞赛</UButton>
        </article>
      </div>
    </AsyncContent>
    <PaginationNav v-if="data && data.pagination.total_pages > 1" :current-page="page" :total-pages="data.pagination.total_pages" @page-change="page = $event" />
  </section>
</template>
