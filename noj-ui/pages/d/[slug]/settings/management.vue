<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import type { WorkspaceMember, WorkspaceDetail } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const { user } = useAuth();
const { api } = useApi();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();

const domain = computed(() => context.domain.value);
const slug = computed(() => context.slug.value ?? '');
const writable = context.writable;

const canTransfer = computed(() => context.can('domain:transfer'));
const canManageStatus = computed(() =>
  (context.can('domain:archive') || domain.value?.platform_admin) && domain.value?.slug !== 'main'
);
const permitted = computed(() => canTransfer.value || canManageStatus.value);

interface ManagementMembersResponse {
  data: WorkspaceMember[];
  page: number;
  per_page: number;
  pagination?: { page: number; per_page: number; total: number; total_pages: number };
}

const members = await useAsyncData<ManagementMembersResponse>(
  () => `domain-management-members:${slug.value}:${user.value?.id}`,
  () =>
    canTransfer.value && slug.value
      ? workspaces.members(slug.value, { page: 1, per_page: 100 })
      : Promise.resolve({ data: [] as WorkspaceMember[], page: 1, per_page: 100 }),
  { watch: [canTransfer] },
);

const newOwnerId = ref('');
const busy = ref(false);
const error = ref('');

async function transfer() {
  const action = captureAction();
  if (
    !newOwnerId.value ||
    !await dialog.confirm('新负责人将取得空间最高管理能力，你将保留管理员身份。确认转交？', { title: '转交负责人' })
  ) return;
  if (!action.isCurrent()) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post(`/api/v1/domains/${action.slug}/transfer`, { user_id: newOwnerId.value });
    if (!action.isCurrent()) return;
    newOwnerId.value = '';
    toast.success('负责人已转交');
    await context.refresh();
    await members.refresh();
  } catch (err) {
    if (action.isCurrent()) error.value = extractApiError(err).message;
  } finally {
    if (action.isCurrent()) busy.value = false;
  }
}

async function setStatus(status: WorkspaceDetail['status']) {
  if (!domain.value || busy.value) return;
  const revision = domain.value.revision;
  const action = captureAction();
  const label = status === 'active' ? '恢复使用' : status === 'archived' ? '归档' : '暂停';
  if (
    !await dialog.confirm(
      status === 'archived'
        ? '归档后空间保留授权历史读取，停止新业务写入。确认归档？'
        : status === 'suspended'
        ? '暂停后普通成员将无法进入此空间。确认暂停？'
        : '恢复此空间的正常业务使用？',
      { title: `${label}空间`, danger: status !== 'active' },
    )
  ) return;
  if (!action.isCurrent()) return;
  busy.value = true;
  error.value = '';
  try {
    await workspaces.status(action.slug, status, revision);
    if (!action.isCurrent()) return;
    toast.success(`空间已${label}`);
    await context.refresh();
  } catch (err) {
    if (action.isCurrent()) error.value = extractApiError(err).message;
  } finally {
    if (action.isCurrent()) busy.value = false;
  }
}

useSeoMeta({ title: '交接与归档 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="permitted && domain" class="space-y-6 max-w-[768px]">
      <AdminPageHeader title="交接与空间治理" description="转交空间负责人权限，或对空间进行归档、暂停与恢复。" icon="i-lucide-shield-alert" />

      <UAlert v-if="error" color="error" :title="error" class="mb-4" />

      <!-- 转交负责人 -->
      <UCard v-if="writable && canTransfer" class="rounded">
        <h2 class="mb-2 font-semibold text-text">转交空间负责人</h2>
        <p class="mb-4 text-sm text-text-secondary">
          将空间最高管理权转移给另一位当前已激活成员。转交后新负责人拥有全部配置权限，你将保留普通管理员身份。
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <USelect
            v-model="newOwnerId"
            :items="(members.data.value?.data ?? []).filter(m => m.status === 'active' && !m.is_owner && m.email).map(m => ({ value: m.user_id, label: `${m.username} (${m.email})` }))"
            placeholder="选择接任负责人的成员"
            class="min-w-64 max-w-sm"
            aria-label="新负责人"
          />
          <UButton :disabled="!newOwnerId || busy" :loading="busy" color="neutral" variant="outline" @click="transfer">
            确认转交
          </UButton>
        </div>
      </UCard>

      <!-- 空间生命周期治理 -->
      <UCard v-if="canManageStatus" class="rounded">
        <h2 class="mb-2 font-semibold text-text">空间生命周期治理</h2>
        <p class="mb-4 text-sm text-text-secondary">
          当前空间状态：
          <UBadge :color="domain.status === 'active' ? 'primary' : domain.status === 'archived' ? 'neutral' : 'error'" variant="subtle">
            {{ domain.status === 'active' ? '正常使用' : domain.status === 'archived' ? '已归档' : '已暂停' }}
          </UBadge>
        </p>
        <div class="flex flex-wrap gap-3">
          <UButton
            v-if="domain.status !== 'active'"
            variant="outline"
            :loading="busy"
            @click="setStatus('active')"
          >
            恢复正常使用
          </UButton>
          <UButton
            v-if="domain.status === 'active'"
            color="neutral"
            variant="outline"
            :loading="busy"
            @click="setStatus('archived')"
          >
            归档此空间
          </UButton>
          <UButton
            v-if="domain.platform_admin && domain.status !== 'suspended'"
            color="error"
            variant="outline"
            :loading="busy"
            @click="setStatus('suspended')"
          >
            暂停访问
          </UButton>
        </div>
      </UCard>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && domain" color="neutral" variant="subtle" title="你没有此空间的交接或治理权限" />
  </DomainSettingsShell>
</template>
