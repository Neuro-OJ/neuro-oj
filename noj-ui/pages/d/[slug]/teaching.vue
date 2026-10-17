<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const { slug } = useWorkspace(), { user } = useAuth(), api = useEducationApi(), page = ref(1);
const key = computed(() => educationCacheKey(slug.value!, user.value?.id ?? null, 'teaching-dashboard', page.value));

const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.dashboard(slug.value!, 'teaching', page.value),
);

watch(slug, () => {
  page.value = 1;
});

usePolling({
  intervalMs: computed(() => data.value?.data.assignments.some((task) => task.summary.updating) ? 3000 : null),
  immediate: false,
  fetcher: () => refresh(),
});

useEducationNotifications(() => refresh());

useSeoMeta({ title: '教学工作台' });
</script>

<template>
  <div class="space-y-6">
    <!-- 架构统一整合指引横幅 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary-bg px-4 py-3 text-sm">
      <div class="flex items-center gap-2 text-text">
        <UIcon name="i-lucide-sparkles" class="size-4 text-primary shrink-0" />
        <span>教学工作台现已全面升级并整合至全新统一的「班级研练中心」。</span>
      </div>
      <UButton
        :to="{ path: workspacePath(slug!, 'classrooms'), query: { view: 'teaching' } }"
        color="primary"
        size="sm"
        trailing-icon="i-lucide-arrow-right"
      >
        前往班级研练中心
      </UButton>
    </div>

    <AdminPageHeader
      title="教学工作台"
      description="统一管理空间教学任务、追踪学员达标进展、诊断资源失效与处理求助反馈。"
      icon="i-lucide-presentation"
    >
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            :to="workspacePath(slug!, 'classrooms')"
            variant="outline"
            color="neutral"
            icon="i-lucide-graduation-cap"
          >
            班级研练中心
          </UButton>
          <UButton
            :to="workspacePath(slug!, 'notifications')"
            variant="outline"
            color="neutral"
            icon="i-lucide-bell"
          >
            教学通知
          </UButton>
          <UButton
            icon="i-lucide-refresh-cw"
            variant="ghost"
            color="neutral"
            aria-label="刷新工作台"
            @click="refresh()"
          />
        </div>
      </template>
    </AdminPageHeader>

    <AsyncContent
      :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      @retry="refresh()"
    >
      <TeachingDashboard v-if="data" :slug="slug!" :data="data.data" mode="teaching" />
    </AsyncContent>

    <!-- 分页 -->
    <div
      v-if="data && data.data.total > data.data.per_page"
      class="flex items-center justify-between rounded-lg border border-border bg-white dark:bg-bg-panel px-4 py-3 shadow-card"
    >
      <span class="text-xs text-text-muted">
        共 <strong class="text-text tabular-nums">{{ data.data.total }}</strong> 个任务
      </span>
      <UPagination
        v-model:page="page"
        :total="data.data.total"
        :items-per-page="data.data.per_page"
      />
    </div>
  </div>
</template>
