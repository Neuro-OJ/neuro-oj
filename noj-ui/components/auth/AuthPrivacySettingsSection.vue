<script setup lang="ts">
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/server/apiError';

const { isLoggedIn } = useAuth();
const { api } = useApi();
const { toast } = useToast();

// ── 个人信息与隐私（PIPL：导出 + 删除/更正请求） ──
const exportingData = ref(false);
const exportError = ref('');

async function handleExportData() {
  exportingData.value = true;
  exportError.value = '';
  try {
    const res = await api.get<{ data: unknown }>('/api/v1/users/me/data-export', { silent: true });
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `noj-data-export-${Date.now()}.json`;
    a.click();
    // 延迟回收，避免下载尚未开始时提前失效（与恢复码下载一致）。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('数据导出已下载');
  } catch (error: unknown) {
    exportError.value = extractApiError(error).message;
  } finally {
    exportingData.value = false;
  }
}

const REQUEST_KINDS = [
  { label: '删除', value: 'delete' },
  { label: '更正', value: 'correct' },
];
const REQUEST_TARGETS = [
  { label: '帖子', value: 'post' },
  { label: '评论', value: 'comment' },
  { label: '提交', value: 'submission' },
  { label: '个人资料', value: 'profile' },
  { label: '其他', value: 'other' },
];

interface MyDataRequest {
  id: string;
  kind: string;
  target_type: string;
  status: string;
  detail: string;
  resolution: string | null;
  created_at: string;
}

const requestKind = ref('delete');
const requestTarget = ref('post');
const requestTargetId = ref('');
const requestDetail = ref('');
const submittingRequest = ref(false);
const requestError = ref('');
const myRequests = ref<MyDataRequest[]>([]);
const requestsLoaded = ref(false);
const requestsLoadError = ref('');

function requestStatusLabel(status: string): string {
  return { pending: '待处理', processing: '处理中', resolved: '已处理', rejected: '已驳回' }[status] ?? status;
}
function requestStatusColor(status: string): 'warning' | 'info' | 'success' | 'error' | 'neutral' {
  if (status === 'resolved') return 'success';
  if (status === 'rejected') return 'error';
  if (status === 'processing') return 'info';
  if (status === 'pending') return 'warning';
  return 'neutral';
}

async function loadMyRequests() {
  requestsLoadError.value = '';
  try {
    const res = await api.get<{ data: MyDataRequest[] }>('/api/v1/legal/data-requests', { silent: true });
    myRequests.value = res.data;
  } catch (error: unknown) {
    // 区分「加载失败」与「确无请求」，避免用户误以为历史请求丢失。
    requestsLoadError.value = extractApiError(error).message;
  } finally {
    requestsLoaded.value = true;
  }
}

async function handleSubmitRequest() {
  requestError.value = '';
  if (!requestDetail.value.trim()) {
    requestError.value = '请填写请求说明';
    return;
  }
  submittingRequest.value = true;
  try {
    await api.post('/api/v1/legal/data-requests', {
      kind: requestKind.value,
      target_type: requestTarget.value,
      target_id: requestTargetId.value.trim() || null,
      detail: requestDetail.value.trim(),
    }, { silent: true });
    requestDetail.value = '';
    requestTargetId.value = '';
    toast.success('请求已提交，运营者会尽快处理');
    await loadMyRequests();
  } catch (error: unknown) {
    requestError.value = extractApiError(error).message;
  } finally {
    submittingRequest.value = false;
  }
}

onMounted(() => {
  if (isLoggedIn.value) void loadMyRequests();
});
</script>

<template>
  <section
    id="settings-privacy"
    aria-label="个人信息与隐私"
    class="scroll-mt-32 overflow-hidden rounded border border-border bg-bg-panel"
  >
    <div class="border-b border-border px-6 py-5">
      <h2 class="flex items-center gap-2 text-xl font-bold text-text">
        <UIcon name="i-lucide-shield-check" class="size-5" />
        个人信息与隐私
      </h2>
    </div>
    <div class="flex flex-col gap-4 px-6 py-6">
      <div class="flex flex-col gap-2">
        <p class="text-sm text-text-secondary">
          下载本平台保存的、与你的账户相关的个人信息副本（账户资料、提交记录、社区内容与同意记录）。
        </p>
        <UButton
          color="neutral"
          variant="outline"
          class="self-start"
          :loading="exportingData"
          @click="handleExportData"
        >
          <UIcon name="i-lucide-download" class="size-4" />
          导出我的数据
        </UButton>
        <p v-if="exportError" class="text-sm text-error-text">{{ exportError }}</p>
      </div>

      <div class="border-t border-border pt-4 flex flex-col gap-2">
        <p class="text-sm text-text-secondary">
          请求删除或更正你在平台上的内容（帖子、评论、提交等）。账户注销请使用下方「危险区域」。
        </p>
        <div class="flex flex-wrap gap-2 items-center">
          <USelect v-model="requestKind" :items="REQUEST_KINDS" class="w-28" />
          <USelect v-model="requestTarget" :items="REQUEST_TARGETS" class="w-32" />
          <UInput v-model="requestTargetId" placeholder="对象 ID（可选）" class="max-w-xs" />
        </div>
        <UTextarea v-model="requestDetail" :rows="3" placeholder="请说明需要删除或更正的具体内容与原因" />
        <p v-if="requestError" class="text-sm text-error-text">{{ requestError }}</p>
        <UButton class="self-start" :loading="submittingRequest" @click="handleSubmitRequest">提交请求</UButton>
      </div>

      <div v-if="myRequests.length > 0" class="border-t border-border pt-4">
        <p class="text-sm font-semibold mb-2">我的请求</p>
        <div class="flex flex-col gap-2">
          <div
            v-for="r in myRequests"
            :key="r.id"
            class="flex flex-col gap-1 text-sm border border-border rounded-lg px-3 py-2"
          >
            <div class="flex items-center gap-3">
              <UBadge color="neutral" variant="subtle">{{ r.kind === 'delete' ? '删除' : '更正' }}</UBadge>
              <span class="text-text-muted text-xs tabular-nums">
                {{ r.created_at.slice(0, 16).replace('T', ' ') }}
              </span>
              <span class="flex-1 truncate">{{ r.detail }}</span>
              <UBadge :color="requestStatusColor(r.status)" variant="subtle">
                {{ requestStatusLabel(r.status) }}
              </UBadge>
            </div>
            <p v-if="r.resolution" class="text-xs text-text-muted pl-1">处理说明：{{ r.resolution }}</p>
          </div>
        </div>
      </div>
      <p v-else-if="requestsLoadError" class="text-xs text-error-text">{{ requestsLoadError }}</p>
      <p v-else-if="requestsLoaded" class="text-xs text-text-muted">暂无请求。</p>
    </div>
  </section>
</template>
