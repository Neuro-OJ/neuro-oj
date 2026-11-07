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

/** 零态与失败折叠：没有可见竞赛或首屏加载失败时只留一行提示，不占掉作业列表的首屏。 */
const showCompact = computed(() =>
  error.value
    ? (data.value?.data.length ?? 0) === 0
    : status.value !== 'pending' && (data.value?.data.length ?? 0) === 0
);
</script>

<template>
  <section v-if="showCompact" class="rounded-lg border border-border bg-bg-panel px-5 py-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-sm text-text-secondary">
        <UIcon :name="error ? 'i-lucide-alert-circle' : 'i-lucide-trophy'" class="size-4 text-text-muted" />
        <template v-if="error">
          <span>班级关联竞赛加载失败</span>
          <span class="text-xs text-text-muted">{{ extractApiError(error).message }}</span>
        </template>
        <template v-else>
          <span>暂无班级关联竞赛</span>
          <span class="text-xs text-text-muted">班级竞赛发布后会出现在这里</span>
        </template>
      </div>
      <div class="flex items-center gap-3">
        <UButton v-if="error" color="primary" variant="outline" size="sm" @click="refresh()">重试</UButton>
        <NuxtLink :to="`/d/${slug}/contests`" class="text-xs font-medium text-primary hover:underline">
          前往竞赛中心
        </NuxtLink>
      </div>
    </div>
  </section>
  <section v-else class="rounded-lg border border-border bg-bg-panel">
    <div class="border-b border-border px-5 py-4">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-trophy" class="size-5 text-primary" />
        <h2 class="text-base font-semibold text-text">班级关联竞赛</h2>
        <span v-if="data" class="text-xs text-text-muted tabular-nums">共 {{ data.pagination.total }} 场</span>
      </div>
      <p class="mt-1 text-xs text-text-secondary">{{ classroomId ? '本班关联的可见竞赛，可进入详情报名、作答与查看榜单。' : '汇总你当前所在班级的可见竞赛，同一竞赛只显示一次。' }}</p>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无可查看的班级关联竞赛" padding="none" @retry="refresh()">
      <div class="divide-y divide-border">
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
      <template #empty>
        <div class="flex items-center justify-center gap-2 px-5 py-6 text-sm text-text-muted">
          <UIcon name="i-lucide-trophy" class="size-4 opacity-50" />
          <span>暂无可查看的班级关联竞赛</span>
        </div>
      </template>
      <template #loading>
        <div class="px-5 py-6 text-center text-sm text-text-muted" role="status" aria-live="polite">加载中...</div>
      </template>
      <template #error="{ error: message }">
        <div class="flex flex-wrap items-center justify-center gap-3 px-5 py-6 text-sm text-text-muted">
          <span>{{ message || '加载竞赛失败' }}</span>
          <UButton color="primary" variant="outline" size="sm" @click="refresh()">重试</UButton>
        </div>
      </template>
    </AsyncContent>
    <div v-if="data && data.pagination.total_pages > 1" class="border-t border-border px-5 py-3">
      <PaginationNav :current-page="page" :total-pages="data.pagination.total_pages" @page-change="page = $event" />
    </div>
  </section>
</template>
