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
  role: WorkspaceRole;
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
    role: m.role,
    is_owner: m.is_owner,
    raw: m,
  }))
);

const rolesOpen = ref(false);
const editingMember = ref<WorkspaceMember | null>(null);
const editingRole = ref<WorkspaceRole>('member');
const roleOptions = computed(() => Object.entries(WORKSPACE_ROLE_LABELS).filter(([value]) =>
  value !== 'owner' && (value !== 'coach' || context.domain.value?.preset === 'education')
).map(([value, label]) => ({ value: value as WorkspaceRole, label })));
const busy = ref(false);

watch([domainSlug, () => user.value?.id], () => {
  page.value = 1;
  search.value = '';
  keyword.value = '';
  rolesOpen.value = false;
  editingMember.value = null;
  editingRole.value = 'member';
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
  editingRole.value = editingMember.value.role;
  rolesOpen.value = true;
}

async function saveRoles() {
  if (!editingMember.value || !domainSlug.value || busy.value) return;
  busy.value = true;
  const action = captureAction();
  try {
    await api.put(
      `/api/v1/domains/${action.slug}/members/${encodeURIComponent(editingMember.value.user_id)}/role`,
      { role: editingRole.value },
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

      <!-- 待审核申请卡片 -->
      <UCard v-if="writable && pendingRequests.length" class="border-warning/40">
        <template #header>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-user-plus" class="size-5 text-warning" />
              <h2 class="font-semibold text-text">待审核的加入申请</h2>
            </div>
            <UBadge color="warning" variant="subtle" size="sm">
              {{ pendingRequests.length }} 条待处理
            </UBadge>
          </div>
        </template>

        <ul class="divide-y divide-border -my-2">
          <li
            v-for="request in pendingRequests"
            :key="request.id"
            class="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <UserIdentity :user="request.user ?? { id: request.user_id, username: request.username, avatar_url: request.avatar_url }" :domain="domainSlug" size="sm" />
              <p class="text-xs text-text-muted mt-0.5">{{ request.reason || '未填写申请理由' }}</p>
            </div>
            <div class="flex items-center gap-2">
              <UButton
                :disabled="busy || !request.can_approve"
                size="sm"
                color="primary"
                @click="reviewRequest(request, true)"
              >
                批准加入
              </UButton>
              <UButton
                :disabled="busy"
                size="sm"
                color="neutral"
                variant="outline"
                @click="reviewRequest(request, false)"
              >
                拒绝
              </UButton>
            </div>
          </li>
        </ul>
      </UCard>

      <p v-if="requests.error.value" class="text-sm text-error-text" role="alert">
        {{ extractApiError(requests.error.value).message }}
      </p>

      <!-- 搜索与条数筛选卡片栏 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white dark:bg-bg-panel p-3.5 shadow-card">
        <form class="flex flex-wrap items-center gap-2 grow max-w-md" @submit.prevent="onSearch">
          <UInput
            v-model="search"
            placeholder="搜索用户名或邮箱"
            icon="i-lucide-search"
            class="grow"
            aria-label="搜索成员"
          />
          <UButton type="submit" variant="outline" color="neutral">搜索</UButton>
          <UButton v-if="keyword" type="button" variant="ghost" color="neutral" @click="search = ''; onSearch()">清除</UButton>
        </form>

        <div class="flex items-center gap-2 text-xs text-text-muted">
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
      <div class="rounded-lg border border-border bg-white dark:bg-bg-panel shadow-card overflow-hidden">
        <AdminTable
          :columns="[
            { key: 'username', label: '账号' },
            { key: 'email', label: '邮箱' },
            { key: 'role', label: '角色' },
            { key: 'status', label: '状态' },
            { key: 'actions', label: '操作' }
          ]"
          :items="memberRows"
          :loading="members.status.value === 'pending'"
          :error="members.error.value ? extractApiError(members.error.value).message : ''"
        >
          <template #cell="{ row, column }">
            <UserIdentity v-if="column.key === 'username'" :user="(row.raw as WorkspaceMember).user ?? { id: String(row.user_id), username: String(row.username), avatar_url: (row.raw as WorkspaceMember).avatar_url }" :domain="domainSlug" size="sm" />
            <UBadge v-else-if="column.key === 'role'" :color="row.role === 'owner' ? 'primary' : row.role === 'coach' ? 'info' : 'neutral'" variant="subtle" size="xs">
              {{ WORKSPACE_ROLE_LABELS[row.role as WorkspaceRole] }}
            </UBadge>
            <span v-else-if="column.key === 'status'">
              <UBadge :color="row.status === 'active' ? 'success' : 'neutral'" variant="subtle" size="xs">
                {{ row.status === 'active' ? '当前成员' : '历史成员' }}
              </UBadge>
            </span>
            <span v-else-if="column.key === 'email'" class="text-xs text-text-secondary font-mono">
              {{ row.email || '-' }}
            </span>
            <span v-else class="font-medium text-text">{{ row[column.key] }}</span>
          </template>
          <template #actions="{ row }">
            <div v-if="writable && !row.is_owner && row.status === 'active' && row.email" class="flex items-center gap-1">
              <UButton color="neutral" variant="ghost" size="xs" @click="editRoles(row.raw as WorkspaceMember)">调整角色</UButton>
              <UButton color="error" variant="ghost" size="xs" @click="remove(row.raw as WorkspaceMember)">移除</UButton>
            </div>
          </template>
        </AdminTable>
      </div>

      <!-- 分页栏 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white dark:bg-bg-panel px-4 py-3 shadow-card text-sm">
        <p class="text-xs text-text-muted tabular-nums">
          共 <strong class="text-text">{{ totalCount }}</strong> 位成员 · 第 {{ page }} / {{ totalPages }} 页
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
            <USelect v-model="editingRole" :items="roleOptions" class="w-full" aria-label="域内角色" />
            <UButton type="submit" :loading="busy" >保存角色</UButton>
          </form>
        </template>
      </UModal>
    </div>
    <UAlert v-else-if="context.status.value !== 'pending' && context.domain.value" color="neutral" variant="subtle" title="你没有管理此空间成员的权限" />
  </DomainSettingsShell>
</template>
