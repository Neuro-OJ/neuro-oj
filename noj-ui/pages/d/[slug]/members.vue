<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_ROLE_LABELS, workspaceCacheKey, workspaceInvitationLink } from '~/utils/workspace';
import type { WorkspaceInvitation, WorkspaceJoinRequest, WorkspaceMember, WorkspaceRole } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const { user } = useAuth();
const { api } = useApi();
const { toast } = useToast();
const { dialog } = useDialog();
const page = ref(1);
const managing = computed(() => context.can('domain:members'));
const writable = computed(() => context.domain.value?.status === 'active');
const domainSlug = computed(() => context.slug.value ?? '');
const key = computed(() => workspaceCacheKey(domainSlug.value, user.value?.id ?? null, `members-${page.value}`));
const members = await useAsyncData(
  key,
  () =>
    managing.value
      ? api.get<{ data: WorkspaceMember[] }>(`/api/v1/domains/${domainSlug.value}/members`, {
        params: { page: page.value },
        silent: true,
      })
      : Promise.resolve({ data: [] }),
  { watch: [managing] },
);
const invitationKey = computed(() => workspaceCacheKey(domainSlug.value, user.value?.id ?? null, 'invitations'));
const invitations = await useAsyncData(
  invitationKey,
  () =>
    context.can('domain:invitations')
      ? api.get<{ data: WorkspaceInvitation[] }>(`/api/v1/domains/${domainSlug.value}/invitations`, { silent: true })
      : Promise.resolve({ data: [] }),
  { watch: [() => context.can('domain:invitations')] },
);
const requestKey = computed(() => workspaceCacheKey(domainSlug.value, user.value?.id ?? null, 'join-requests'));
const requests = await useAsyncData(
  requestKey,
  () =>
    managing.value
      ? api.get<{ data: WorkspaceJoinRequest[] }>(`/api/v1/domains/${domainSlug.value}/join-requests`, { silent: true })
      : Promise.resolve({ data: [] }),
  { watch: [managing] },
);
const pendingRequests = computed(() =>
  (requests.data.value?.data ?? []).filter((request) => request.status === 'pending')
);
const tableRows = computed(() => (members.data.value?.data ?? []).map((row) => ({ ...row })));
const rolesOpen = ref(false);
const editingMember = ref<WorkspaceMember | null>(null);
const editingRoles = ref<WorkspaceRole[]>([]);
const roleOptions = Object.entries(WORKSPACE_ROLE_LABELS).filter(([value]) => value !== 'owner').map((
  [value, label],
) => ({ value: value as WorkspaceRole, label }));
const busy = ref(false);
const inviteEmail = ref('');
const invitationLink = ref('');
const invitationId = ref('');
const newOwnerId = ref('');
watch([domainSlug, () => user.value?.id], () => {
  page.value = 1;
  rolesOpen.value = false;
  editingMember.value = null;
  editingRoles.value = [];
  invitationLink.value = '';
  invitationId.value = '';
  inviteEmail.value = '';
  newOwnerId.value = '';
});
async function reviewRequest(request: WorkspaceJoinRequest, approved: boolean) {
  const action = captureAction();
  if (
    busy.value ||
    !await dialog.confirm(`${approved ? '允许' : '拒绝'} ${request.username} 加入此空间？`, { title: '审核加入申请' })
  ) return;
  if (!action.isCurrent()) return;
  busy.value = true;
  try {
    await api.post(`/api/v1/domains/${action.slug}/join-requests/${encodeURIComponent(request.id)}/review`, {
      approved,
    });
    if (!action.isCurrent()) return;
    await requests.refresh();
    await members.refresh();
    toast.success('加入申请已处理');
  } finally {
    busy.value = false;
  }
}
function editRoles(row: Record<string, unknown>) {
  editingMember.value = row as unknown as WorkspaceMember;
  editingRoles.value = [...editingMember.value.roles];
  rolesOpen.value = true;
}
async function saveRoles() {
  if (!editingMember.value || !domainSlug.value || busy.value) return;
  busy.value = true;
  const action = captureAction();
  try {
    await api.put(
      `/api/v1/domains/${action.slug}/members/${encodeURIComponent(editingMember.value.user_id)}/roles`,
      { roles: editingRoles.value },
    );
    if (!action.isCurrent()) return;
    rolesOpen.value = false;
    toast.success('成员角色已更新');
    await members.refresh();
  } finally {
    busy.value = false;
    if (action.isCurrent()) await context.refresh();
  }
}
async function remove(row: Record<string, unknown>) {
  const action = captureAction();
  if (
    !await dialog.confirm(`移除 ${String(row.username)} 的当前成员权限？已有历史记录会保留。`, {
      title: '移除成员',
      danger: true,
    })
  ) return;
  if (!action.isCurrent()) return;
  await api.delete(`/api/v1/domains/${action.slug}/members/${encodeURIComponent(String(row.user_id))}`);
  if (!action.isCurrent()) return;
  toast.success('成员已移除');
  await context.refresh();
  await members.refresh();
}
async function invite() {
  if (busy.value) return;
  busy.value = true;
  invitationLink.value = '';
  const action = captureAction();
  try {
    const response = await api.post<{ data: { id: string; token: string } }>(
      `/api/v1/domains/${action.slug}/invitations`,
      { email: inviteEmail.value },
    );
    if (!action.isCurrent()) return;
    invitationLink.value = workspaceInvitationLink(window.location.origin, response.data.token);
    invitationId.value = response.data.id;
    inviteEmail.value = '';
    await invitations.refresh();
  } finally {
    busy.value = false;
  }
}
async function revoke(id: string) {
  const action = captureAction();
  await api.delete(`/api/v1/domains/${action.slug}/invitations/${encodeURIComponent(id)}`);
  if (!action.isCurrent()) return;
  if (id === invitationId.value) invitationLink.value = '';
  await invitations.refresh();
  toast.success('邀请已撤销');
}
async function copyInvitation() {
  try {
    await navigator.clipboard.writeText(invitationLink.value);
    toast.success('已复制邀请链接');
  } catch {
    toast.error('复制失败，请手动复制链接');
  }
}
async function transfer() {
  const action = captureAction();
  if (
    !newOwnerId.value ||
    !await dialog.confirm('新负责人将取得空间管理能力，你将保留管理员身份。', { title: '转交负责人' })
  ) return;
  if (!action.isCurrent()) return;
  await api.post(`/api/v1/domains/${action.slug}/transfer`, { user_id: newOwnerId.value });
  if (!action.isCurrent()) return;
  newOwnerId.value = '';
  toast.success('负责人已转交');
  await context.refresh();
  await members.refresh();
}
function invitationState(invite: WorkspaceInvitation) {
  return invite.revoked_at
    ? '已撤销'
    : invite.used_at
    ? '已接受'
    : Date.parse(invite.expires_at) <= Date.now()
    ? '已过期'
    : '待接受';
}
useSeoMeta({ title: '空间成员' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="managing" class="space-y-6">
      <AdminPageHeader title="成员" description="域内角色可组合；成员权限不会延伸到其他空间。" icon="i-lucide-users" />
      <UCard v-if="writable && pendingRequests.length" class="rounded">
        <h2 class="mb-3 font-semibold text-text">待审核的加入申请</h2>
        <ul class="divide-y divide-border">
          <li v-for="request in pendingRequests" :key="request.id"
            class="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p class="text-sm font-medium text-text">{{ request.username }}</p>
              <p class="text-sm text-text-secondary">{{ request.reason || '未填写理由' }}</p>
            </div>
            <div class="flex gap-2">
              <UButton :disabled="busy || !request.can_approve" size="sm"
                @click="reviewRequest(request, true)">批准</UButton>
              <UButton :disabled="busy" size="sm" color="neutral" variant="outline"
                @click="reviewRequest(request, false)">拒绝</UButton>
            </div>
          </li>
        </ul>
      </UCard>
      <p v-if="requests.error.value" class="text-sm text-error-text"
        role="alert">{{ extractApiError(requests.error.value).message }}</p>
      <AdminTable
        :columns="[{ key: 'username', label: '账号' }, { key: 'email', label: '邮箱' }, { key: 'roles', label: '角色' }, { key: 'status', label: '状态' }]"
        :items="tableRows" :loading="members.status.value === 'pending'"
        :error="members.error.value ? extractApiError(members.error.value).message : ''">
        <template
          #cell="{ row, column }"><div v-if="column.key === 'roles'" class="flex flex-wrap gap-1"><UBadge v-for="role in (row.roles as WorkspaceRole[])" :key="role" color="neutral" variant="subtle">{{ WORKSPACE_ROLE_LABELS[role] }}</UBadge></div><span v-else-if="column.key === 'status'">{{ row.status === 'active' ? '当前成员' : '历史成员' }}</span><span v-else>{{ row[column.key] }}</span></template>
        <template #actions="{ row }">
          <template v-if="writable && !row.is_owner && row.status === 'active' && row.email">
            <UButton color="neutral" variant="ghost" size="sm" @click="editRoles(row)">角色</UButton>
            <UButton color="error" variant="ghost" size="sm" @click="remove(row)">移除</UButton>
          </template>
        </template>
      </AdminTable>
      <div
        class="flex items-center justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="page === 1" @click="page--">上一页</UButton><span class="text-sm tabular-nums">第 {{ page }} 页</span><UButton color="neutral" variant="outline" :disabled="(members.data.value?.data.length ?? 0) < 100" @click="page++">下一页</UButton></div>
      <UCard v-if="context.can('domain:invitations')" class="rounded">
        <h2 class="mb-3 font-semibold text-text">邀请成员</h2>
        <form v-if="writable" class="flex flex-wrap gap-3" @submit.prevent="invite">
          <UInput v-model="inviteEmail" type="email" placeholder="受邀人的邮箱" aria-label="受邀邮箱" required
            class="min-w-64" />
          <UButton type="submit" :loading="busy">生成邀请</UButton>
        </form>
        <div v-if="invitationLink" class="mt-4 space-y-2">
          <p class="text-sm text-text-secondary">将链接发送给受邀人。链接仅在创建时显示，请及时复制。</p>
          <UInput :model-value="invitationLink" readonly class="w-full" aria-label="新邀请链接" />
          <UButton size="sm" variant="outline" @click="copyInvitation">复制链接</UButton>
        </div>
        <p v-if="invitations.error.value" class="mt-3 text-error-text"
          role="alert">{{ extractApiError(invitations.error.value).message }}</p>
        <ul class="mt-4 divide-y divide-border">
          <li v-for="invitation in invitations.data.value?.data" :key="invitation.id"
            class="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <p class="text-sm text-text">{{ invitation.email }}</p>
              <p
                class="text-xs text-text-muted">{{ invitationState(invitation) }} · {{ new Date(invitation.expires_at).toLocaleString() }} 到期</p>
            </div>
            <UButton v-if="writable && invitationState(invitation) === '待接受'" color="neutral" variant="outline"
              size="sm" @click="revoke(invitation.id)">撤销</UButton>
          </li>
        </ul>
      </UCard>
      <UCard v-if="writable && context.can('domain:transfer')" class="rounded">
        <h2 class="mb-3 font-semibold text-text">转交负责人</h2>
        <div class="flex flex-wrap gap-3">
          <USelect v-model="newOwnerId"
            :items="(members.data.value?.data ?? []).filter(m => m.status === 'active' && !m.is_owner && m.email).map(m => ({ value: m.user_id, label: m.username }))"
            placeholder="选择当前成员" class="min-w-64" aria-label="新负责人" />
          <UButton :disabled="!newOwnerId" color="neutral" variant="outline" @click="transfer">转交</UButton>
        </div>
      </UCard>
      <UModal v-model:open="rolesOpen" title="调整域内角色">
        <template #body>
          <form class="space-y-4" @submit.prevent="saveRoles">
            <p class="text-sm text-text-secondary">{{ editingMember?.username }}</p>
            <USelect v-model="editingRoles" multiple :items="roleOptions" class="w-full" aria-label="域内角色" />
            <UButton type="submit" :loading="busy" :disabled="!editingRoles.length">保存角色</UButton>
          </form>
        </template>
      </UModal>
    </div>
    <UAlert v-else-if="context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间成员的权限" />
  </DomainSettingsShell>
</template>
