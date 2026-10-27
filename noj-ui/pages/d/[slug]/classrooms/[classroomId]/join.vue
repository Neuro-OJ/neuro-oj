<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

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
  <div class="flex flex-col gap-6">
      <NuxtLink
        :to="workspacePath(slug!, 'classrooms')"
        class="inline-flex self-start items-center gap-1 text-text-secondary hover:text-primary transition-colors font-medium"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        <span>我的班级</span>
      </NuxtLink>

    <LibraryPageHeader
      title="申请加入班级"
      :description="state.data.value?.data.name ? `申请加入「${state.data.value.data.name}」` : '向班级教练提交加入申请'"
      icon="i-lucide-door-open"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <AsyncContent
      :status="state.error.value ? 'error' : state.status.value === 'pending' ? 'loading' : state.data.value ? 'data' : 'empty'"
      :error="state.error.value ? extractApiError(state.error.value).message : undefined"
      @retry="state.refresh()">
    <div v-if="state.data.value" class="max-w-2xl">
      <!-- 已经是班级成员 -->
      <UCard v-if="state.data.value.data.is_member">
        <div class="text-center py-6 space-y-3">
          <div class="flex size-12 items-center justify-center rounded-full bg-success-bg text-success-text mx-auto">
            <UIcon name="i-lucide-check-circle-2" class="size-6" />
          </div>
          <h2 class="text-lg font-semibold text-text">你已是该班级成员</h2>
          <p class="text-sm text-text-secondary">无需重复提交申请，可以直接进入班级查看作业与训练进展。</p>
          <div class="pt-2">
            <UButton :to="workspacePath(slug!, `classrooms/${id}`)" color="primary" size="lg">
              进入班级主页
            </UButton>
          </div>
        </div>
      </UCard>

      <!-- 未加入：显示申请状态或申请表单 -->
      <UCard v-else>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-clipboard-pen" class="size-5 text-primary" />
              <h2 class="font-semibold text-text">提交学生入班申请</h2>
            </div>
            <UBadge
              v-if="state.data.value.data.request"
              :color="state.data.value.data.request.status === 'approved' ? 'success' : state.data.value.data.request.status === 'rejected' ? 'error' : 'warning'"
              variant="subtle"
            >
              {{ ({ pending: '等待审核中', approved: '申请已批准', rejected: '申请已被拒绝' })[state.data.value.data.request.status] }}
            </UBadge>
          </div>
        </template>

        <div class="space-y-4">
          <div v-if="state.data.value.data.request" class="rounded-lg bg-bg-sunken p-3.5 text-sm space-y-1">
            <div class="flex items-center justify-between text-xs text-text-muted">
              <span>申请提交时间：{{ new Date(state.data.value.data.request.created_at).toLocaleString() }}</span>
            </div>
            <p v-if="state.data.value.data.request.reason" class="break-words whitespace-pre-wrap text-text-secondary text-sm">
              附言：{{ state.data.value.data.request.reason }}
            </p>
          </div>

          <form v-if="state.data.value.data.can_apply" class="space-y-4" @submit.prevent="apply">
            <AdminFormField label="申请理由或备注" hint="域教练将在审核时查看">
              <UTextarea
                v-model="reason"
                class="w-full"
                :maxlength="2000"
                placeholder="例如说明你的学校、年级或算法学习基础"
                aria-label="班级申请理由"
              />
            </AdminFormField>
            <div class="flex justify-end pt-2">
              <UButton type="submit" color="primary" size="lg" :loading="busy">
                提交加入申请
              </UButton>
            </div>
          </form>

          <p v-else class="text-sm text-text-muted py-3 text-center">
            当前暂不能提交新申请，请等待审核处理或联系域教练。
          </p>
        </div>
      </UCard>
    </div>
    </AsyncContent>
  </div>
</template>
