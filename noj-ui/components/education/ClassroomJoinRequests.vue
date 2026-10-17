<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; classroomId: string; revision: number; writable: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null),
  page = ref(1),
  state = ref<'pending' | 'approved' | 'rejected'>('pending');
const error = ref(''), busy = ref(false);
const requests = await useAsyncData(
  () =>
    educationCacheKey(props.slug, actor.value?.id ?? null, props.classroomId, 'join-requests', page.value, state.value),
  () => education.joinRequests(props.slug, props.classroomId, page.value, state.value),
);
watch(state, () => {
  page.value = 1;
});
async function review(requestId: string, approve: boolean) {
  if (busy.value || !props.writable) return;
  const scope = capture(),
    classId = props.classroomId,
    revision = props.revision,
    decision = approve ? 'approve' : 'reject';
  busy.value = true;
  error.value = '';
  try {
    await education.reviewJoin(
      scope.slug,
      classId,
      requestId,
      decision,
      revision,
      `review:${requestId}:${decision}:${revision}`,
    );
    if (scope.isCurrent() && props.classroomId === classId) {
      await requests.refresh();
      emit('changed');
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UCard>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
    <h2 class="font-semibold text-text">班级加入申请</h2>
    <AdminFormField label="审核状态" class="w-full sm:w-40">
    <USelect v-model="state" class="w-full"
      :items="[{ label: '待审核', value: 'pending' }, { label: '已批准', value: 'approved' }, { label: '已拒绝', value: 'rejected' }]"
      aria-label="申请审核状态" />
    </AdminFormField>
    </div>
    <UAlert v-if="error" class="mb-3" color="error" :title="error" />
    <AsyncContent
      :status="requests.error.value ? 'error' : requests.status.value === 'pending' ? 'loading' : requests.data.value?.data.data.length ? 'data' : 'empty'"
      :error="requests.error.value ? extractApiError(requests.error.value).message : undefined"
      empty-text="暂无此状态的申请" @retry="requests.refresh()">
    <div class="divide-y divide-border">
    <article v-for="request in requests.data.value?.data.data" :key="request.id"
      class="py-4 first:pt-0 last:pb-0">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <p class="break-all font-medium">{{ request.username }}</p>
          <p class="mt-1 break-words whitespace-pre-wrap text-sm text-text-secondary">{{ request.reason || '未填写申请理由' }}</p>
        </div>
        <div v-if="request.status === 'pending' && writable" class="flex flex-wrap gap-2">
          <UButton :disabled="busy" @click="review(request.id, true)">批准为学生</UButton>
          <UButton variant="outline" color="error" :disabled="busy" @click="review(request.id, false)">拒绝</UButton>
        </div>
      </div>
    </article>
    </div>
    </AsyncContent>
    <div v-if="(requests.data.value?.data.total ?? 0) > 50" class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <span class="mr-auto text-sm tabular-nums text-text-muted">第 {{ page }} 页</span>
      <UButton :disabled="page <= 1" variant="ghost" @click="page--">上一页</UButton>
      <UButton :disabled="page * 50 >= (requests.data.value?.data.total ?? 0)" variant="ghost"
        @click="page++">下一页</UButton>
    </div>
  </UCard>
</template>
