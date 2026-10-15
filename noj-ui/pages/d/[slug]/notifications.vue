<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { TEACHING_NOTICE_LABELS, teachingNoticeTarget } from '~/utils/education-notifications';
import type { TeachingNotice } from '~/utils/education-notifications';
import { extractApiError } from '~/utils/apiError';
import { useEducationNotifications } from '~/composables/useEducationNotifications';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug } = useWorkspace(), education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null), page = ref(1), opening = ref('');
const { data, status, error, refresh } = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, 'notifications', page.value),
  () => education.notifications(slug.value!, page.value),
);
const stream = useEducationNotifications(() => refresh());
async function open(notice: TeachingNotice) {
  if (opening.value) return;
  const scope = capture();
  opening.value = notice.id;
  try {
    await education.readNotification(scope.slug, notice.id);
    if (scope.isCurrent()) await navigateTo(teachingNoticeTarget(scope.slug, notice));
  } finally {
    opening.value = '';
  }
}
watch([() => slug.value, () => actor.value?.id], () => {
  page.value = 1;
});
useSeoMeta({ title: '教学通知' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="教学通知" :description="`未读 ${data?.data.unread ?? 0} 条`" icon="i-lucide-bell">
      <template #actions>
        <UButton variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">刷新</UButton>
      </template>
    </AdminPageHeader>
    <p v-if="stream.state.value === 'fallback'"
      class="text-xs text-text-muted">实时连接暂不可用，每 15 秒重新读取授权通知，并自动尝试恢复连接。</p>
    <AsyncContent
      :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无获授权的教学通知" @retry="refresh()">
      <UCard v-for="notice in data?.data.data" :key="notice.id" class="mb-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p
              class="font-medium">{{ TEACHING_NOTICE_LABELS[notice.type] }} <UBadge v-if="!notice.read_at" size="sm" variant="subtle">未读</UBadge></p>
            <p class="mt-1 text-xs text-text-muted">{{ new Date(notice.created_at).toLocaleString() }}</p>
          </div>
          <UButton variant="outline" :loading="opening === notice.id" :disabled="!!opening"
            @click="open(notice)">查看详情</UButton>
        </div>
      </UCard>
    </AsyncContent>
    <div
      class="flex gap-3"><UButton :disabled="page <= 1" variant="ghost" @click="page--">上一页</UButton><span class="text-sm tabular-nums">{{ page }}</span><UButton :disabled="page * 50 >= (data?.data.total ?? 0)" variant="ghost" @click="page++">下一页</UButton></div>
  </div>
</template>
