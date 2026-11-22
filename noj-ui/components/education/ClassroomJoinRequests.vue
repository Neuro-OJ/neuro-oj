<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import type { ClassroomJoinRequest } from '~/utils/education-enrollment';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';

const props = defineProps<{ slug: string; classroomId: string; revision: number; writable: boolean }>();
const emit = defineEmits<{
  changed: [];
  pendingCount: [count: number];
}>();

const education = useEducationApi();
const capture = useWorkspaceActionScope();
const { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null);

const page = ref(1);
const state = ref<'pending' | 'approved' | 'rejected'>('pending');
const error = ref('');
const busy = ref(false);
const progress = ref<{ current: number; total: number } | null>(null);
const selectedIds = ref<string[]>([]);

const requests = await useAsyncData(
  () =>
    educationCacheKey(
      props.slug,
      actor.value?.id ?? null,
      props.classroomId,
      'join-requests',
      page.value,
      state.value,
    ),
  () => education.joinRequests(props.slug, props.classroomId, page.value, state.value),
);

// 当在待审核状态时，向父级同步待处理申请总数
watch(
  [() => requests.data.value?.data.total, () => state.value],
  ([total, st]) => {
    if (st === 'pending' && typeof total === 'number') {
      emit('pendingCount', total);
    }
  },
  { immediate: true },
);

watch(state, () => {
  page.value = 1;
  selectedIds.value = [];
  error.value = '';
});

const currentList = computed<ClassroomJoinRequest[]>(() => {
  return (requests.data.value?.data.data ?? []) as ClassroomJoinRequest[];
});

const pendingList = computed(() => {
  return currentList.value.filter((r) => r.status === 'pending');
});

const isAllSelected = computed(() => {
  return pendingList.value.length > 0 && selectedIds.value.length === pendingList.value.length;
});

function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value = [];
  } else {
    selectedIds.value = pendingList.value.map((r) => r.id);
  }
}

function toggleSelect(id: string) {
  const index = selectedIds.value.indexOf(id);
  if (index >= 0) {
    selectedIds.value.splice(index, 1);
  } else {
    selectedIds.value.push(id);
  }
}

// 单条审核
async function review(requestId: string, approve: boolean) {
  if (busy.value || !props.writable) return;
  const scope = capture();
  const classId = props.classroomId;
  const revision = props.revision;
  const decision = approve ? 'approve' : 'reject';

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
      selectedIds.value = selectedIds.value.filter((id) => id !== requestId);
      await requests.refresh();
      emit('changed');
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    busy.value = false;
  }
}

// 批量审核
async function batchReview(ids: string[], approve: boolean) {
  if (busy.value || !props.writable || !ids.length) return;
  const scope = capture();
  const classId = props.classroomId;
  const revision = props.revision;
  const decision = approve ? 'approve' : 'reject';

  if (!approve && !(await dialog.confirm(`确定拒绝选中的 ${ids.length} 条入班申请？`))) {
    return;
  }

  busy.value = true;
  error.value = '';
  progress.value = { current: 0, total: ids.length };

  let successCount = 0;
  const errors: string[] = [];

  try {
    for (const reqId of ids) {
      if (!scope.isCurrent() || props.classroomId !== classId) break;
      try {
        const key = `review:${reqId}:${decision}:${Date.now()}`;
        await education.reviewJoin(
          scope.slug,
          classId,
          reqId,
          decision,
          revision,
          key,
        );
        successCount++;
      } catch (err) {
        errors.push(extractApiError(err).message);
      }
      if (progress.value) {
        progress.value.current++;
      }
    }

    if (errors.length > 0) {
      error.value = `处理完成：成功 ${successCount} 条，失败 ${errors.length} 条（${errors[0]}）`;
    }

    selectedIds.value = [];
    if (scope.isCurrent() && props.classroomId === classId) {
      await requests.refresh();
      emit('changed');
    }
  } finally {
    busy.value = false;
    progress.value = null;
  }
}

function handleBatchApproveAll() {
  const ids = pendingList.value.map((r) => r.id);
  if (ids.length) {
    batchReview(ids, true);
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- 控制栏与筛选 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-bg-panel p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-user-plus" class="size-5 text-primary" />
          <h2 class="font-semibold text-text">入班申请管理</h2>
        </div>
        <UBadge
          v-if="state === 'pending' && (requests.data.value?.data.total ?? 0) > 0"
          color="warning"
          variant="subtle"
          size="sm"
          class="tabular-nums"
        >
          {{ requests.data.value?.data.total }} 人待审核
        </UBadge>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <AdminFormField label="状态过滤" class="w-full sm:w-36">
          <USelect
            v-model="state"
            class="w-full"
            :items="[
              { label: '待审核', value: 'pending' },
              { label: '已批准', value: 'approved' },
              { label: '已拒绝', value: 'rejected' },
            ]"
            aria-label="申请审核状态"
          />
        </AdminFormField>
      </div>
    </div>

    <!-- 批量快捷操作栏 (当有待审核记录且可写时呈现) -->
    <div
      v-if="state === 'pending' && writable && pendingList.length > 0"
      class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-sunken px-4 py-2.5 text-sm"
    >
      <div class="flex items-center gap-3">
        <UCheckbox
          :model-value="isAllSelected"
          :disabled="busy"
          aria-label="全选当前页申请"
          @update:model-value="toggleSelectAll"
        />
        <span class="text-text-secondary select-none">
          <template v-if="selectedIds.length > 0">
            已勾选 <strong class="text-text tabular-nums">{{ selectedIds.length }}</strong> / {{ pendingList.length }} 条
          </template>
          <template v-else>
            全选本页（共 {{ pendingList.length }} 条）
          </template>
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <template v-if="selectedIds.length > 0">
          <UButton
            color="primary"
            size="sm"
            :loading="busy"
            icon="i-lucide-check-circle"
            @click="batchReview(selectedIds, true)"
          >
            批准所选 ({{ selectedIds.length }})
          </UButton>
          <UButton
            variant="outline"
            color="error"
            size="sm"
            :disabled="busy"
            icon="i-lucide-x-circle"
            @click="batchReview(selectedIds, false)"
          >
            拒绝所选 ({{ selectedIds.length }})
          </UButton>
        </template>
        <template v-else>
          <UButton
            variant="outline"
            color="primary"
            size="sm"
            :loading="busy"
            icon="i-lucide-check-check"
            @click="handleBatchApproveAll"
          >
            一键全部批准当前页 ({{ pendingList.length }})
          </UButton>
        </template>
      </div>
    </div>

    <UAlert v-if="error" color="error" :title="error" />

    <!-- 批量进度指示 -->
    <div v-if="busy && progress" class="flex items-center gap-2 rounded-lg bg-primary-bg px-4 py-2 text-sm text-primary">
      <UIcon name="i-lucide-loader-2" class="size-4 animate-spin shrink-0" />
      <span>正在批量处理入班申请 ({{ progress.current }} / {{ progress.total }})...</span>
    </div>

    <!-- 申请列表 -->
    <AsyncContent
      :status="requests.error.value ? 'error' : requests.status.value === 'pending' ? 'loading' : currentList.length ? 'data' : 'empty'"
      :error="requests.error.value ? extractApiError(requests.error.value).message : undefined"
      :empty-text="state === 'pending' ? '当前没有待审核的入班申请' : '暂无此状态的申请记录'"
      @retry="requests.refresh()"
    >
      <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
        <article
          v-for="request in currentList"
          :key="request.id"
          class="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between transition-colors hover:bg-bg-sunken/40"
        >
          <div class="flex items-start gap-3 min-w-0 flex-1">
            <!-- 勾选框 -->
            <UCheckbox
              v-if="state === 'pending' && writable"
              :model-value="selectedIds.includes(request.id)"
              :disabled="busy"
              class="mt-1"
              :aria-label="`选择申请：${request.username ?? request.user_id}`"
              @update:model-value="toggleSelect(request.id)"
            />

            <!-- 用户首字母头像 -->
            <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-text-secondary font-semibold text-sm">
              {{ (request.username ?? request.user_id).slice(0, 1).toUpperCase() }}
            </div>

            <!-- 核心申请信息 -->
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="break-all font-medium text-text">{{ request.username ?? request.user_id }}</span>
                <UBadge
                  :color="request.status === 'pending' ? 'warning' : request.status === 'approved' ? 'success' : 'error'"
                  variant="subtle"
                  size="sm"
                >
                  {{ ({ pending: '待审核', approved: '已批准', rejected: '已拒绝' })[request.status] }}
                </UBadge>
                <span v-if="request.created_at" class="text-xs text-text-muted tabular-nums">
                  申请时间: {{ formatDateTime(request.created_at) }}
                </span>
              </div>

              <!-- 申请理由气泡 -->
              <div class="rounded bg-bg-sunken px-3 py-2 text-sm text-text-secondary border border-border/40">
                <span class="text-xs text-text-muted select-none">理由：</span>
                <span class="break-words whitespace-pre-wrap">{{ request.reason || '未填写理由' }}</span>
              </div>
            </div>
          </div>

          <!-- 单条操作按钮 -->
          <div v-if="request.status === 'pending' && writable" class="flex flex-wrap items-center gap-2 sm:self-center shrink-0">
            <UButton
              color="primary"
              size="sm"
              :disabled="busy"
              icon="i-lucide-check"
              @click="review(request.id, true)"
            >
              批准为学生
            </UButton>
            <UButton
              variant="outline"
              color="error"
              size="sm"
              :disabled="busy"
              icon="i-lucide-x"
              @click="review(request.id, false)"
            >
              拒绝
            </UButton>
          </div>
        </article>
      </div>
    </AsyncContent>

    <!-- 分页控件 -->
    <div v-if="(requests.data.value?.data.total ?? 0) > 50" class="flex flex-wrap items-center justify-between gap-2 pt-2">
      <span class="text-sm tabular-nums text-text-muted">
        共 {{ requests.data.value?.data.total }} 条，当前第 {{ page }} 页
      </span>
      <div class="flex items-center gap-2">
        <UButton :disabled="page <= 1 || busy" variant="outline" size="sm" @click="page--">上一页</UButton>
        <UButton
          :disabled="page * 50 >= (requests.data.value?.data.total ?? 0) || busy"
          variant="outline"
          size="sm"
          @click="page++"
        >
          下一页
        </UButton>
      </div>
    </div>
  </div>
</template>
