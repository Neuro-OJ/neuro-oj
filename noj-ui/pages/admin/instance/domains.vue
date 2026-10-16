<script setup lang="ts">
import { DOMAIN_STATUS_LABELS } from '~/utils/instance-governance';
import type { InstanceDomain } from '~/utils/instance-governance';
import { WORKSPACE_PRESETS, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });

const route = useRoute();
const router = useRouter();
const api = useInstanceAdmin();
const workspaces = useWorkspaceApi();
const { user } = useAuth();
const { dialog } = useDialog();

// URL query state retention (Requirement 6: 用URL保留搜索状态页码)
const page = computed({
  get: () => Number(route.query.page || 1),
  set: (val) => router.replace({ query: { ...route.query, page: val === 1 ? undefined : String(val) } }),
});

const statusFilter = computed({
  get: () => (route.query.status as 'all' | InstanceDomain['status']) || 'all',
  set: (val) => router.replace({ query: { ...route.query, status: val === 'all' ? undefined : val, page: undefined } }),
});

const search = ref((route.query.keyword as string) || '');
const keyword = computed({
  get: () => (route.query.keyword as string) || '',
  set: (val) => router.replace({ query: { ...route.query, keyword: val || undefined, page: undefined } }),
});

const busy = ref('');
const failure = ref('');

const key = computed(
  () => `instance-domains:${user.value?.id}:${page.value}:${statusFilter.value}:${keyword.value}`
);

const { data: domains, status: loadStatus, error, refresh } = await useAsyncData(key, () =>
  api.domains({
    page: page.value,
    status: statusFilter.value === 'all' ? undefined : statusFilter.value,
    keyword: keyword.value || undefined,
  })
);

function onSearch() {
  keyword.value = search.value.trim();
}

interface DomainRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  preset: string;
  status: InstanceDomain['status'];
  owner_username: string;
  revision: number;
  raw: InstanceDomain;
}

const domainItems = computed<DomainRow[]>(() =>
  (domains.value?.data ?? []).map((domain) => ({
    id: domain.id,
    name: domain.name,
    slug: domain.slug,
    preset: domain.preset,
    status: domain.status,
    owner_username: domain.owner_username,
    revision: domain.revision,
    raw: domain,
  }))
);

const presetLabel = (preset: string) => WORKSPACE_PRESETS.find((item) => item.value === preset)?.label ?? preset;
const formatDomainStatus = (status: unknown) =>
  typeof status === 'string' && status in DOMAIN_STATUS_LABELS
    ? DOMAIN_STATUS_LABELS[status as InstanceDomain['status']]
    : String(status ?? '');

async function setStatus(row: InstanceDomain, status: InstanceDomain['status']) {
  if (busy.value) return;
  const target = { slug: row.slug, name: row.name, revision: row.revision };
  const actor = user.value?.id;
  const label = DOMAIN_STATUS_LABELS[status];
  const confirmed = await dialog.confirm(
    `将空间「${target.name}」(${target.slug})设为${label}？${
      status === 'suspended'
        ? '普通用户将停止访问。'
        : status === 'archived'
        ? '保留授权历史读取，停止新业务写入。'
        : '恢复按空间政策正常访问。'
    }`,
    { title: `${label}空间`, danger: status !== 'active' },
  );
  if (!confirmed) return;
  if (user.value?.id !== actor) return;
  busy.value = target.slug;
  failure.value = '';
  try {
    await workspaces.status(target.slug, status, target.revision);
    if (user.value?.id === actor) await refresh();
  } catch (err) {
    if (user.value?.id === actor) failure.value = extractApiError(err).message;
  } finally {
    busy.value = '';
  }
}

function getActions(row: InstanceDomain) {
  const items = [
    {
      label: '管理成员',
      icon: 'i-lucide-users',
      onSelect: () => navigateTo(workspacePath(row.slug, 'settings/members')),
    },
    {
      label: '管理 Provider',
      icon: 'i-lucide-bot',
      onSelect: () => navigateTo(workspacePath(row.slug, 'settings/llm')),
    },
  ];

  if (row.status !== 'active') {
    items.push({
      label: '恢复使用',
      icon: 'i-lucide-play-circle',
      onSelect: () => setStatus(row, 'active'),
    });
  }

  if (row.slug !== 'main' && row.status === 'active') {
    items.push({
      label: '归档空间',
      icon: 'i-lucide-archive',
      onSelect: () => setStatus(row, 'archived'),
    });
  }

  if (row.slug !== 'main' && row.status !== 'suspended') {
    items.push({
      label: '暂停访问',
      icon: 'i-lucide-pause-circle',
      onSelect: () => setStatus(row, 'suspended'),
    });
  }

  return [items];
}

useSeoMeta({ title: '空间目录与治理 - 实例设置' });
</script>

<template>
  <div class="space-y-6">
    <AdminPageHeader title="实例与域治理" description="管理实例全局政策、可选模块与各空间资源上限。" icon="i-lucide-building-2">
      <template #actions>
        <UButton variant="outline" @click="refresh()">重新读取空间</UButton>
      </template>
    </AdminPageHeader>

    <InstanceNav />

    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-text">全部工作空间</h2>
          <p class="text-xs text-text-secondary mt-0.5">
            包含公开与私有空间。进入管理时检查目标域权限并记录治理操作。
          </p>
        </div>

        <!-- 筛选与搜索工具栏 -->
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="onSearch">
          <UInput
            v-model="search"
            placeholder="空间名称或网址标识"
            icon="i-lucide-search"
            class="w-56"
            aria-label="搜索治理空间"
          />
          <USelect
            v-model="statusFilter"
            :items="[
              { label: '全部状态', value: 'all' },
              ...Object.entries(DOMAIN_STATUS_LABELS).map(([value, label]) => ({ value, label }))
            ]"
            class="w-32"
            aria-label="治理空间状态"
          />
          <UButton type="submit" variant="outline">搜索</UButton>
          <UButton
            v-if="keyword || statusFilter !== 'all'"
            type="button"
            variant="ghost"
            @click="search = ''; keyword = ''; statusFilter = 'all'"
          >
            重置
          </UButton>
        </form>
      </div>

      <UAlert v-if="failure" color="error" :title="failure"
        description="操作没有自动重试，请重新读取目标状态后决定下一步。" class="mb-4" />

      <!-- 紧凑 AdminTable (Requirement 6) -->
      <div class="overflow-x-auto rounded border border-border bg-bg-panel">
        <AdminTable
          :columns="[
            { key: 'name', label: '空间名称与标识' },
            { key: 'preset', label: '类型' },
            { key: 'status', label: '状态' },
            { key: 'owner_username', label: '负责人' },
            { key: 'actions', label: '操作' }
          ]"
          :items="domainItems"
          :loading="loadStatus === 'pending'"
          :error="error ? extractApiError(error).message : ''"
        >
          <template #cell="{ row, column }">
            <template v-if="column.key === 'name'">
              <div class="py-1">
                <span class="font-medium text-text">{{ row.name }}</span>
                <span class="ml-2 font-mono text-xs text-text-muted">/d/{{ row.slug }}</span>
              </div>
            </template>
            <template v-else-if="column.key === 'preset'">
              <span class="text-sm text-text-secondary">{{ presetLabel(String(row.preset ?? '')) }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <UBadge
                :color="row.status === 'active' ? 'primary' : row.status === 'archived' ? 'neutral' : 'error'"
                variant="subtle"
              >
                {{ formatDomainStatus(row.status) }}
              </UBadge>
            </template>
            <template v-else-if="column.key === 'owner_username'">
              <span class="text-sm font-mono text-text-secondary">{{ row.owner_username }}</span>
            </template>
            <template v-else>
              {{ row[column.key] }}
            </template>
          </template>

          <template #actions="{ row }">
            <div class="flex items-center gap-1.5 justify-end">
              <UButton :to="workspacePath(String(row.slug ?? ''), 'settings')" variant="outline" size="xs">
                管理设置
              </UButton>
              <UDropdownMenu :items="getActions(row.raw as InstanceDomain)">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-more-horizontal"
                  aria-label="更多操作"
                  :loading="busy === row.slug"
                />
              </UDropdownMenu>
            </div>
          </template>
        </AdminTable>
      </div>

      <!-- 分页与统计 -->
      <div class="flex flex-wrap items-center justify-between gap-3 pt-1 text-sm text-text-muted">
        <p class="tabular-nums">
          共 {{ domains?.pagination.total ?? 0 }} 个工作空间
          <span v-if="domains?.pagination.total_pages">
            · 第 {{ page }} / {{ domains?.pagination.total_pages }} 页
          </span>
        </p>

        <div v-if="domains && domains.pagination.total_pages > 1" class="flex items-center gap-2">
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            :disabled="page <= 1"
            @click="page--"
          >
            上一页
          </UButton>
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            :disabled="page >= domains.pagination.total_pages"
            @click="page++"
          >
            下一页
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
