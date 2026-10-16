<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useApi } from '~/composables/useApi';
import { useDialog } from '~/composables/useDialog';
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/apiError';
import {
  formatInvitationCode,
  getInvitationStatus,
  WORKSPACE_INVITATION_MODE_LABELS,
  WORKSPACE_INVITATION_STATUS_LABELS,
  workspaceInvitationLink,
} from '~/utils/workspace';
import type {
  WorkspaceInvitation,
  WorkspaceInvitationCreated,
  WorkspaceInvitationStatus,
} from '~/utils/workspace';

interface Props {
  domainSlug: string;
  classroomId?: string;
  writable: boolean;
}

const props = defineProps<Props>();

const { api } = useApi();
const { dialog } = useDialog();
const { toast } = useToast();

const invitations = ref<WorkspaceInvitation[]>([]);
const loading = ref(false);
const error = ref('');
const revokingId = ref<string | null>(null);

const pagination = reactive({
  page: 1,
  per_page: 25,
  total: 0,
  total_pages: 1,
});

const basePath = computed(() =>
  props.classroomId
    ? `/api/v1/domains/${encodeURIComponent(props.domainSlug)}/classrooms/${encodeURIComponent(props.classroomId)}/invitations`
    : `/api/v1/domains/${encodeURIComponent(props.domainSlug)}/invitations`
);

// 表单状态
const mode = ref<'general' | 'email' | 'once'>('general');
const email = ref('');
const maxUsesOption = ref<'unlimited' | 'limit'>('unlimited');
const maxUsesCount = ref<number | null>(10);
const expiryPreset = ref<'1' | '7' | '30' | 'custom'>('7');
const customExpiry = ref('');
const formError = ref('');
const creating = ref(false);

// 新创建凭据展示
const createdResult = ref<WorkspaceInvitationCreated | null>(null);
const createdLink = computed(() => {
  if (!createdResult.value || typeof window === 'undefined') return '';
  try {
    return workspaceInvitationLink(window.location.origin, createdResult.value.token);
  } catch {
    return '';
  }
});

async function copyText(text: string, label: string) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`);
    } else {
      toast.error('浏览器不支持自动复制，请手动选中复制');
    }
  } catch {
    toast.error('复制失败，请手动复制');
  }
}

async function fetchInvitations(page = pagination.page) {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.get<{
      data: WorkspaceInvitation[];
      pagination: { page: number; per_page: number; total: number; total_pages: number };
    }>(basePath.value, {
      query: { page, per_page: pagination.per_page },
      silent: true,
    });
    invitations.value = res.data ?? [];
    pagination.page = res.pagination.page;
    pagination.per_page = res.pagination.per_page;
    pagination.total = res.pagination.total;
    pagination.total_pages = res.pagination.total_pages;
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    loading.value = false;
  }
}

function calculateExpiry(): string {
  if (expiryPreset.value === 'custom') {
    if (!customExpiry.value) {
      throw new Error('请选择自定义到期时间');
    }
    const ms = Date.parse(customExpiry.value);
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      throw new Error('自定义到期时间须晚于当前时间');
    }
    return new Date(ms).toISOString();
  }
  const days = Number(expiryPreset.value);
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function createInvitation() {
  if (creating.value || !props.writable) return;
  formError.value = '';

  let calculatedExpiresAt = '';
  try {
    calculatedExpiresAt = calculateExpiry();
  } catch (err: unknown) {
    formError.value = (err as Error).message;
    return;
  }

  const payload: {
    mode: 'general' | 'email' | 'once';
    email?: string;
    max_uses?: number | null;
    expires_at: string;
  } = {
    mode: mode.value,
    expires_at: calculatedExpiresAt,
  };

  if (mode.value === 'email') {
    const trimmed = email.value.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      formError.value = '请输入合法的邮箱地址';
      return;
    }
    payload.email = trimmed;
    payload.max_uses = 1;
  } else if (mode.value === 'once') {
    payload.max_uses = 1;
  } else if (mode.value === 'general') {
    if (maxUsesOption.value === 'limit') {
      const count = Number(maxUsesCount.value);
      if (!Number.isInteger(count) || count < 1) {
        formError.value = '使用人数限制须为正整数';
        return;
      }
      payload.max_uses = count;
    } else {
      payload.max_uses = null;
    }
  }

  creating.value = true;
  try {
    const res = await api.post<{ data: WorkspaceInvitationCreated }>(basePath.value, payload, { silent: true });
    createdResult.value = res.data;
    toast.success('邀请创建成功');
    // 重置表单输入
    email.value = '';
    await fetchInvitations(1);
  } catch (cause) {
    formError.value = extractApiError(cause).message;
  } finally {
    creating.value = false;
  }
}

async function revokeInvitation(id: string) {
  if (revokingId.value || !props.writable) return;
  const confirmed = await dialog.confirm('确定要撤销此邀请吗？撤销后凭据立即失效，无法继续加入。', {
    danger: true,
    confirmText: '撤销邀请',
  });
  if (!confirmed) return;

  revokingId.value = id;
  try {
    await api.delete(`${basePath.value}/${encodeURIComponent(id)}`, { silent: true });
    toast.success('已撤销邀请');
    await fetchInvitations();
  } catch (cause) {
    toast.error(extractApiError(cause).message);
  } finally {
    revokingId.value = null;
  }
}

function onPageChange(newPage: number) {
  pagination.page = newPage;
  fetchInvitations(newPage);
}

const tableColumns = [
  { key: 'mode', label: '类型' },
  { key: 'target', label: '受邀对象' },
  { key: 'usage', label: '使用人数' },
  { key: 'status', label: '状态' },
  { key: 'expires_at', label: '到期时间' },
  { key: 'actions', label: '操作' },
];

const tableRows = computed(() => {
  return invitations.value.map((inv) => {
    const status = getInvitationStatus(inv);
    return {
      ...inv,
      status,
      target: inv.mode === 'email' ? inv.email ?? '-' : '无需邮箱',
      usage: `${inv.used_count} / ${inv.max_uses ?? '不限'}`,
    };
  });
});

const statusBadgeClasses: Record<WorkspaceInvitationStatus, string> = {
  active: 'bg-green-50 text-success-600 border-green-200',
  used_up: 'bg-bg-sunken text-text-muted border-border',
  expired: 'bg-amber-50 text-amber-700 border-amber-200',
  revoked: 'bg-red-50 text-error-text border-red-200',
};

watch(
  [() => props.domainSlug, () => props.classroomId],
  () => {
    createdResult.value = null;
    formError.value = '';
    pagination.page = 1;
    fetchInvitations(1);
  },
  { immediate: true }
);

onMounted(() => {
  // 设置自定义默认日期为 7 天后
  const d = new Date(Date.now() + 7 * 86400000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  customExpiry.value = d.toISOString().slice(0, 16);
});
</script>

<template>
  <div class="space-y-6">
    <!-- 创建成功结果展示横幅（仅展示一次） -->
    <div
      v-if="createdResult"
      class="rounded border border-primary/30 bg-primary-bg/20 p-4 space-y-3"
      role="region"
      aria-label="新创建的邀请凭据"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-check-circle" class="size-5 text-signal" />
            <h3 class="font-semibold text-text">邀请凭据已生成</h3>
          </div>
          <p class="text-xs text-text-secondary">
            完整凭据仅在此展示一次，离开或刷新后无法再次查看。系统不会自动发送邮件，请复制后自行分发给受邀人。
          </p>
        </div>
        <UButton
          variant="ghost"
          color="neutral"
          size="xs"
          icon="i-lucide-x"
          aria-label="关闭凭据提示"
          @click="createdResult = null"
        />
      </div>

      <!-- 链接与邀请码 -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <label class="text-xs font-medium text-text-muted">邀请链接</label>
          <div class="flex gap-2">
            <UInput
              :model-value="createdLink"
              readonly
              class="grow font-mono text-xs"
              aria-label="生成的邀请链接"
            />
            <UButton
              color="primary"
              variant="outline"
              size="xs"
              icon="i-lucide-copy"
              @click="copyText(createdLink, '链接')"
            >
              复制链接
            </UButton>
          </div>
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-text-muted">邀请短码</label>
          <div class="flex gap-2">
            <UInput
              :model-value="formatInvitationCode(createdResult.code)"
              readonly
              class="grow font-mono text-xs font-semibold tracking-wider tabular-nums"
              aria-label="生成的邀请短码"
            />
            <UButton
              color="primary"
              variant="outline"
              size="xs"
              icon="i-lucide-copy"
              @click="copyText(formatInvitationCode(createdResult.code), '邀请码')"
            >
              复制邀请码
            </UButton>
          </div>
        </div>
      </div>

      <div class="flex justify-end pt-1">
        <UButton size="xs" variant="ghost" color="neutral" @click="createdResult = null">
          已保存，关闭提示
        </UButton>
      </div>
    </div>

    <!-- 创建邀请区域（受 host 权限 writable 控制） -->
    <UCard v-if="writable" class="rounded">
      <div class="space-y-4">
        <div>
          <h2 class="text-base font-semibold text-text">创建新邀请</h2>
          <p class="mt-1 text-xs text-text-muted">
            生成加入此空间的邀请凭据。支持指定邮箱、通用人数或单次使用的短码与链接。
          </p>
        </div>

        <UAlert v-if="formError" color="error" :title="formError" />

        <form class="space-y-4" @submit.prevent="createInvitation">
          <!-- 邀请模式选择 -->
          <AdminFormField label="邀请类型" required>
            <div class="grid grid-cols-3 gap-2">
              <button
                type="button"
                :class="[
                  'rounded border px-3 py-2 text-left text-xs transition-colors',
                  mode === 'general'
                    ? 'border-primary bg-primary-bg/30 font-semibold text-primary'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="mode = 'general'"
              >
                <div class="font-medium text-text">通用邀请</div>
                <div class="mt-0.5 text-text-muted text-[11px]">无需邮箱，可设人数上限</div>
              </button>
              <button
                type="button"
                :class="[
                  'rounded border px-3 py-2 text-left text-xs transition-colors',
                  mode === 'email'
                    ? 'border-primary bg-primary-bg/30 font-semibold text-primary'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="mode = 'email'"
              >
                <div class="font-medium text-text">指定邮箱</div>
                <div class="mt-0.5 text-text-muted text-[11px]">需匹配受邀邮箱，限 1 人</div>
              </button>
              <button
                type="button"
                :class="[
                  'rounded border px-3 py-2 text-left text-xs transition-colors',
                  mode === 'once'
                    ? 'border-primary bg-primary-bg/30 font-semibold text-primary'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="mode = 'once'"
              >
                <div class="font-medium text-text">一次性邀请</div>
                <div class="mt-0.5 text-text-muted text-[11px]">无需邮箱，限 1 人兑换</div>
              </button>
            </div>
          </AdminFormField>

          <!-- 指定邮箱输入 -->
          <div v-if="mode === 'email'">
            <AdminFormField label="受邀人邮箱" required hint="仅允许拥有此邮箱的用户通过此邀请加入">
              <UInput
                v-model="email"
                type="email"
                placeholder="user@example.com"
                class="w-full max-w-md font-mono"
                aria-label="受邀人邮箱"
                required
              />
            </AdminFormField>
          </div>

          <!-- 通用邀请人数限制 -->
          <div v-if="mode === 'general'" class="space-y-2">
            <AdminFormField label="使用人数限制">
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-1.5 text-xs text-text cursor-pointer">
                  <input
                    v-model="maxUsesOption"
                    type="radio"
                    value="unlimited"
                    name="max_uses_option"
                    class="accent-primary"
                  />
                  不限人数
                </label>
                <label class="flex items-center gap-1.5 text-xs text-text cursor-pointer">
                  <input
                    v-model="maxUsesOption"
                    type="radio"
                    value="limit"
                    name="max_uses_option"
                    class="accent-primary"
                  />
                  限制人数
                </label>
                <UInput
                  v-if="maxUsesOption === 'limit'"
                  v-model.number="maxUsesCount"
                  type="number"
                  min="1"
                  class="w-28 tabular-nums font-mono text-xs"
                  aria-label="最大使用人数"
                  placeholder="正整数"
                />
              </div>
            </AdminFormField>
          </div>

          <!-- 有效期设置 -->
          <AdminFormField label="有效期" required>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                :class="[
                  'rounded px-2.5 py-1 text-xs border transition-colors',
                  expiryPreset === '1'
                    ? 'border-primary bg-primary text-white font-medium'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="expiryPreset = '1'"
              >
                1 天
              </button>
              <button
                type="button"
                :class="[
                  'rounded px-2.5 py-1 text-xs border transition-colors',
                  expiryPreset === '7'
                    ? 'border-primary bg-primary text-white font-medium'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="expiryPreset = '7'"
              >
                7 天（默认）
              </button>
              <button
                type="button"
                :class="[
                  'rounded px-2.5 py-1 text-xs border transition-colors',
                  expiryPreset === '30'
                    ? 'border-primary bg-primary text-white font-medium'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="expiryPreset = '30'"
              >
                30 天
              </button>
              <button
                type="button"
                :class="[
                  'rounded px-2.5 py-1 text-xs border transition-colors',
                  expiryPreset === 'custom'
                    ? 'border-primary bg-primary text-white font-medium'
                    : 'border-border bg-bg-panel text-text-secondary hover:bg-bg-sunken',
                ]"
                @click="expiryPreset = 'custom'"
              >
                自定义日期
              </button>
              <UInput
                v-if="expiryPreset === 'custom'"
                v-model="customExpiry"
                type="datetime-local"
                class="text-xs"
                aria-label="自定义到期时间"
              />
            </div>
          </AdminFormField>

          <div class="flex items-center justify-between pt-2">
            <span class="text-xs text-text-muted">
              创建后请自行将链接或短码发送给受邀者。新成员加入后拥有普通成员基础权限。
            </span>
            <UButton type="submit" color="primary" :loading="creating">生成邀请</UButton>
          </div>
        </form>
      </div>
    </UCard>

    <!-- 已有邀请列表 -->
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold text-text">已有邀请</h2>
        <UButton
          variant="ghost"
          color="neutral"
          size="xs"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          @click="fetchInvitations()"
        >
          刷新列表
        </UButton>
      </div>

      <AdminTable
        :columns="tableColumns"
        :items="tableRows"
        :loading="loading"
        :error="error"
        :current-page="pagination.page"
        :total-pages="pagination.total_pages"
        :total-items="pagination.total"
        @update:page="onPageChange"
      >
        <template #cell="{ row, column }">
          <span v-if="column.key === 'mode'">
            <UBadge color="neutral" variant="subtle" size="sm">
              {{ WORKSPACE_INVITATION_MODE_LABELS[row.mode as keyof typeof WORKSPACE_INVITATION_MODE_LABELS] ?? row.mode }}
            </UBadge>
          </span>
          <span v-else-if="column.key === 'target'" class="font-mono text-xs">
            {{ row.target }}
          </span>
          <span v-else-if="column.key === 'usage'" class="tabular-nums font-mono text-xs">
            {{ row.usage }}
          </span>
          <span v-else-if="column.key === 'status'">
            <span
              :class="[
                'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border tabular-nums',
                statusBadgeClasses[row.status as WorkspaceInvitationStatus],
              ]"
            >
              {{ WORKSPACE_INVITATION_STATUS_LABELS[row.status as WorkspaceInvitationStatus] ?? row.status }}
            </span>
          </span>
          <span v-else-if="column.key === 'expires_at'" class="tabular-nums text-xs text-text-secondary">
            {{ new Date(row.expires_at as string).toLocaleString() }}
          </span>
          <span v-else>{{ row[column.key] }}</span>
        </template>

        <template #actions="{ row }">
          <UButton
            v-if="writable && row.status === 'active'"
            variant="ghost"
            color="error"
            size="xs"
            :loading="revokingId === row.id"
            @click="revokeInvitation(row.id as string)"
          >
            撤销
          </UButton>
          <span v-else class="text-text-muted text-xs">-</span>
        </template>
      </AdminTable>
    </div>
  </div>
</template>
