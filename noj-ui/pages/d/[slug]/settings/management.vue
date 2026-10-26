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
      <AdminPageHeader
        title="交接与空间治理"
        description="转交空间最高所有权，或对空间进行归档保护、暂停与恢复访问。"
        icon="i-lucide-shield-alert"
      />

      <UAlert v-if="error" color="error" :title="error" class="mb-4" />

      <!-- 转交负责人卡片 -->
      <UCard v-if="writable && canTransfer">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-user-check" class="size-5 text-primary" />
            <h2 class="font-semibold text-text">转交空间所有权</h2>
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-text-secondary leading-relaxed">
            将本空间的最高管理权限转移给另一位当前已激活成员。转交后，新负责人将获得空间所有管理与配置能力，你将保留管理员（Admin）角色。
          </p>

          <div class="flex flex-wrap items-center gap-3 pt-1">
            <USelect
              v-model="newOwnerId"
              :items="(members.data.value?.data ?? []).filter(m => m.status === 'active' && !m.is_owner && m.email).map(m => ({ value: m.user_id, label: `${m.username} (${m.email})` }))"
              placeholder="选择接任负责人的成员"
              class="w-full sm:w-80"
              aria-label="新负责人"
            />
            <UButton
              :disabled="!newOwnerId || busy"
              :loading="busy"
              color="primary"
              variant="outline"
              @click="transfer"
            >
              确认转交所有权
            </UButton>
          </div>
        </div>
      </UCard>

      <!-- 危险区域：空间生命周期治理卡片 -->
      <UCard v-if="canManageStatus" class="border-error/40">
        <template #header>
          <div class="flex items-center gap-2 text-error">
            <UIcon name="i-lucide-alert-triangle" class="size-5" />
            <h2 class="font-semibold text-text">空间生命周期治理（危险操作）</h2>
          </div>
        </template>

        <div class="space-y-4">
          <div class="flex items-center gap-2 text-sm">
            <span class="text-text-secondary">当前空间状态：</span>
            <UBadge :color="domain.status === 'active' ? 'success' : domain.status === 'archived' ? 'neutral' : 'error'" variant="subtle">
              {{ domain.status === 'active' ? '正常运行中' : domain.status === 'archived' ? '已归档（只读）' : '已暂停访问' }}
            </UBadge>
          </div>

          <p class="text-xs text-text-muted leading-relaxed">
            归档操作将冻结所有新提交、新作业与成员变更，但保留历史记录供查阅；暂停操作将使非平台管理员无法访问本域。
          </p>

          <div class="flex flex-wrap gap-3 pt-2">
            <UButton
              v-if="domain.status !== 'active'"
              variant="outline"
              color="primary"
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
              暂停全域访问
            </UButton>
          </div>
        </div>
      </UCard>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && domain" color="neutral" variant="subtle" title="你没有此空间的交接或治理权限" />
  </DomainSettingsShell>
</template>
