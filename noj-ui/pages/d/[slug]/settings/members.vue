<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { WORKSPACE_ROLE_LABELS, workspaceCacheKey } from '~/utils/workspace';
import type { WorkspaceJoinRequest, WorkspaceMember, WorkspaceRole } from '~/utils/workspace';
import { useToast } from '~/composables/useToast';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const context = useWorkspace();
const captureAction = useWorkspaceActionScope();
const { user } = useAuth();
const { api } = useApi();
const workspaces = useWorkspaceApi();
const { toast } = useToast();
const { dialog } = useDialog();

const managing = computed(() => context.can('domain:members'));
const writable = context.writable;
const domainSlug = computed(() => context.slug.value ?? '');

const page = ref(1);
const perPage = ref(25);
const search = ref('');
const keyword = ref('');

const key = computed(() =>
  workspaceCacheKey(domainSlug.value, user.value?.id ?? null, `members-${page.value}-${perPage.value}-${keyword.value}`)
);

interface MembersListResponse {
  data: WorkspaceMember[];
  page: number;
  per_page: number;
  pagination?: { page: number; per_page: number; total: number; total_pages: number };
}

const members = await useAsyncData<MembersListResponse>(
  key,
  () =>
    managing.value
      ? workspaces.members(domainSlug.value, {
        page: page.value,
        per_page: perPage.value,
        keyword: keyword.value,
      })
      : Promise.resolve({ data: [] as WorkspaceMember[], page: 1, per_page: 25 }),
  { watch: [managing] },
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

const totalCount = computed(() => members.data.value?.pagination?.total ?? members.data.value?.data.length ?? 0);
const totalPages = computed(() => members.data.value?.pagination?.total_pages ?? (Math.ceil(totalCount.value / perPage.value) || 1));

interface MemberRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  username: string;
  email: string;
  status: 'active' | 'removed';
  roles: WorkspaceRole[];
  is_owner: boolean;
  raw: WorkspaceMember;
}

const memberRows = computed<MemberRow[]>(() =>
  (members.data.value?.data ?? []).map((m) => ({
    id: m.id,
    user_id: m.user_id,
    username: m.username,
    email: m.email,
    status: m.status,
    roles: m.roles,
    is_owner: m.is_owner,
    raw: m,
  }))
);

const rolesOpen = ref(false);
const editingMember = ref<WorkspaceMember | null>(null);
const editingRoles = ref<WorkspaceRole[]>([]);
const roleOptions = Object.entries(WORKSPACE_ROLE_LABELS).filter(([value]) => value !== 'owner').map(
  ([value, label]) => ({ value: value as WorkspaceRole, label })
);
const busy = ref(false);

watch([domainSlug, () => user.value?.id], () => {
  page.value = 1;
  search.value = '';
  keyword.value = '';
  rolesOpen.value = false;
  editingMember.value = null;
  editingRoles.value = [];
});

function onSearch() {
  keyword.value = search.value.trim();
  page.value = 1;
}

function onPerPageChange(val: number) {
  perPage.value = Number(val);
  page.value = 1;
}

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

function editRoles(row: WorkspaceMember) {
  editingMember.value = row;
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

async function remove(row: WorkspaceMember) {
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

useSeoMeta({ title: '成员管理 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="managing" class="space-y-6">
      <AdminPageHeader title="成员管理" description="查看域内成员、分配角色及处理加入申请。" icon="i-lucide-users">
        <template #actions>
          <UButton :to="workspacePath(domainSlug, 'settings/invitations')" color="primary" icon="i-lucide-mail">
            邀请新成员
          </UButton>
        </template>
      </AdminPageHeader>

      <!-- 待审核申请 -->
      <UCard v-if="writable && pendingRequests.length" class="rounded">
        <h2 class="mb-3 font-semibold text-text">待审核的加入申请（{{ pendingRequests.length }}）</h2>
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
      <p v-if="requests.error.value" class="text-sm text-error-text" role="alert">
        {{ extractApiError(requests.error.value).message }}
      </p>

      <!-- 搜索与条数筛选 -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="onSearch">
          <UInput
            v-model="search"
            placeholder="搜索用户名或邮箱"
            icon="i-lucide-search"
            class="w-64"
            aria-label="搜索成员"
          />
          <UButton type="submit" variant="outline">搜索</UButton>
          <UButton v-if="keyword" type="button" variant="ghost" @click="search = ''; onSearch()">清除</UButton>
        </form>

        <div class="flex items-center gap-2 text-sm text-text-muted">
          <span>每页显示：</span>
          <USelect
            :model-value="perPage"
            :items="[
              { label: '25 条/页', value: 25 },
              { label: '50 条/页', value: 50 },
              { label: '100 条/页', value: 100 }
            ]"
            class="w-32"
            @update:model-value="onPerPageChange"
          />
        </div>
      </div>

      <!-- 成员表格 -->
      <AdminTable
        :columns="[
          { key: 'username', label: '账号' },
          { key: 'email', label: '邮箱' },
          { key: 'roles', label: '角色' },
          { key: 'status', label: '状态' },
          { key: 'actions', label: '操作' }
        ]"
        :items="memberRows"
        :loading="members.status.value === 'pending'"
        :error="members.error.value ? extractApiError(members.error.value).message : ''"
      >
        <template #cell="{ row, column }">
          <div v-if="column.key === 'roles'" class="flex flex-wrap gap-1">
            <UBadge v-for="role in (row.roles as WorkspaceRole[])" :key="role" color="neutral" variant="subtle">
              {{ WORKSPACE_ROLE_LABELS[role] }}
            </UBadge>
          </div>
          <span v-else-if="column.key === 'status'">
            {{ row.status === 'active' ? '当前成员' : '历史成员' }}
          </span>
          <span v-else-if="column.key === 'email'">
            {{ row.email || '-' }}
          </span>
          <span v-else>{{ row[column.key] }}</span>
        </template>
        <template #actions="{ row }">
          <template v-if="writable && !row.is_owner && row.status === 'active' && row.email">
            <UButton color="neutral" variant="ghost" size="sm" @click="editRoles(row.raw as WorkspaceMember)">角色</UButton>
            <UButton color="error" variant="ghost" size="sm" @click="remove(row.raw as WorkspaceMember)">移除</UButton>
          </template>
        </template>
      </AdminTable>

      <!-- 分页栏 -->
      <div class="flex flex-wrap items-center justify-between gap-3 pt-2 text-sm">
        <p class="text-text-muted tabular-nums">
          共 {{ totalCount }} 位成员 · 第 {{ page }} / {{ totalPages }} 页
        </p>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="outline" size="sm" :disabled="page <= 1" @click="page--">
            上一页
          </UButton>
          <UButton color="neutral" variant="outline" size="sm" :disabled="page >= totalPages" @click="page++">
            下一页
          </UButton>
        </div>
      </div>

      <!-- 角色编辑弹窗 -->
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
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间成员的权限" />
  </DomainSettingsShell>
</template>
