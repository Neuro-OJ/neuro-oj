<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null),
  id = computed(() => String(route.params.classroomId));
const state = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'join'),
  () => education.joinView(slug.value!, id.value),
);
const reason = ref(''), busy = ref(false), error = ref('');
async function apply() {
  if (busy.value) return;
  const scope = capture(), classId = id.value;
  busy.value = true;
  error.value = '';
  try {
    await education.requestJoin(scope.slug, classId, reason.value);
    if (scope.isCurrent() && id.value === classId) await state.refresh();
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    busy.value = false;
  }
}
useSeoMeta({ title: '申请加入班级' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="申请加入班级" :description="state.data.value?.data.name" />
    <UAlert v-if="error || state.error.value" color="error"
      :title="error || extractApiError(state.error.value).message" />
    <template v-if="state.data.value">
      <UButton v-if="state.data.value.data.is_member" :to="workspacePath(slug!, `classrooms/${id}`)">进入班级</UButton>
      <UCard v-else>
        <p v-if="state.data.value.data.request"
          class="mb-3 text-sm">申请状态：{{ ({ pending: '等待审核', approved: '已批准', rejected: '已拒绝' })[state.data.value.data.request.status] }}</p>
        <form v-if="state.data.value.data.can_apply" class="space-y-3" @submit.prevent="apply">
          <UTextarea v-model="reason" class="w-full" :maxlength="2000" placeholder="说明加入班级的理由"
            aria-label="班级申请理由" />
          <UButton type="submit" :loading="busy">提交学生加入申请</UButton>
        </form>
        <p v-else class="text-sm text-text-muted">当前不能提交新申请，请等待审核或联系教练。</p>
      </UCard>
    </template>
  </div>
</template>
