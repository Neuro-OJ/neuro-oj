<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime, languageLabels } from '~/utils/submissionFormat';
import type { DomainSubmissionListQuery } from '~/composables/useDomainSubmissions';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

const route = useRoute();
const router = useRouter();
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainSubmissions();

const page = computed({
  get: () => Math.max(1, Number(route.query.page) || 1),
  set: (value) => {
    void router.push({ query: { ...route.query, page: value > 1 ? String(value) : undefined } });
  },
});

// 用户名筛选：
// 若 URL 中显式存在 username（即使是空字符串 ""），予以保留；
// 仅当 URL query 未携带 username（初始进入）时，默认回填当前登录用户名。
const usernameFilter = computed(() => {
  if (route.query.username !== undefined) {
    return String(route.query.username);
  }
  return user.value?.username ?? '';
});

const usernameInput = ref(usernameFilter.value);
watch(usernameFilter, (val) => {
  usernameInput.value = val;
});

// 初始访问无 query 参数时在客户端水合后同步到 URL，使刷新后状态不丢失
onMounted(() => {
  if (route.query.username === undefined && user.value?.username) {
    void router.replace({ query: { ...route.query, username: user.value.username } });
  }
});

function applyUsername(name: string) {
  usernameInput.value = name;
  void router.push({
    query: {
      ...route.query,
      username: name,
      page: undefined,
    },
  });
}

function setOnlyMe() {
  applyUsername(user.value?.username ?? '');
}

function clearUsername() {
  applyUsername('');
}

const kindFilter = computed({
  get: () => (typeof route.query.kind === 'string' ? route.query.kind : 'all'),
  set: (val) => {
    void router.push({
      query: {
        ...route.query,
        kind: val === 'all' ? undefined : val,
        page: undefined,
      },
    });
  },
});

const kindOptions = [
  { label: '全部题型', value: 'all' },
  { label: '代码/产物/预测', value: 'submission' },
  { label: '客观题', value: 'objective' },
  { label: '代码', value: 'code' },
  { label: '大模型', value: 'llm' },
  { label: '产物', value: 'artifact' },
  { label: '预测', value: 'prediction' },
  { label: '界面', value: 'ui' },
];

const filters = computed(() => ({
  problem_id: typeof route.query.problem_id === 'string' ? route.query.problem_id : undefined,
  contest_id: typeof route.query.contest_id === 'string' ? route.query.contest_id : undefined,
}));

const queryParams = computed<DomainSubmissionListQuery>(() => ({
  username: usernameFilter.value,
  kind: kindFilter.value === 'all' ? undefined : kindFilter.value,
  problem_id: filters.value.problem_id,
  contest_id: filters.value.contest_id,
}));

const key = computed(() =>
  workspaceCacheKey(
    slug.value!,
    user.value?.id ?? null,
    'submissions',
    String(page.value),
    JSON.stringify({
      username: usernameFilter.value,
      kind: kindFilter.value,
      problem_id: filters.value.problem_id ?? '',
      contest_id: filters.value.contest_id ?? '',
    }),
  )
);

const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.list(slug.value!, page.value, queryParams.value),
);

watch([() => filters.value.problem_id, () => filters.value.contest_id, kindFilter, usernameFilter], () => {
  page.value = 1;
});

const columns = [
  { accessorKey: 'id', header: '提交号' },
  { accessorKey: 'problem', header: '题目', meta: { class: { th: 'w-full', td: 'min-w-36 whitespace-normal' } } },
  { accessorKey: 'user', header: '提交者' },
  { accessorKey: 'type_lang', header: '题型 / 语言' },
  { accessorKey: 'result', header: '允许结果' },
  {
    accessorKey: 'version',
    header: '版本',
    meta: { class: { th: 'hidden md:table-cell', td: 'hidden md:table-cell' } },
  },
  {
    accessorKey: 'created_at',
    header: '提交时间',
    meta: { class: { th: 'hidden lg:table-cell', td: 'hidden lg:table-cell' } },
  },
];

useSeoMeta({ title: '提交' });
</script>

<template>
  <div class="space-y-5">
    <AdminPageHeader title="提交" description="当前域的代码、客观题、LLM、产物及预测提交" icon="i-lucide-file-code-2">
      <template #actions>
        <UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新提交"
          :loading="status === 'pending'" @click="refresh()" />
      </template>
    </AdminPageHeader>

    <!-- 筛选工具栏 -->
    <div class="flex flex-wrap items-center gap-3 rounded border border-border bg-bg-panel p-3">
      <!-- 提交者筛选 -->
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-text-secondary whitespace-nowrap">提交者:</span>
        <div class="relative w-44">
          <UInput v-model="usernameInput" size="sm" placeholder="用户名（留空查全部）"
            aria-label="用户名"
            @keyup.enter="applyUsername(usernameInput)" />
        </div>
        <UButton size="xs" color="neutral" variant="outline" @click="applyUsername(usernameInput)">筛选</UButton>
        <UButton v-if="usernameFilter" size="xs" color="neutral" variant="ghost" icon="i-lucide-x"
          title="清空用户（查看全部用户）" @click="clearUsername">清空</UButton>
        <UButton v-if="usernameFilter !== (user?.username ?? '')" size="xs" color="neutral" variant="outline"
          icon="i-lucide-user" @click="setOnlyMe">仅看本人</UButton>
      </div>

      <!-- 题型筛选 -->
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-text-secondary whitespace-nowrap">题型:</span>
        <USelect v-model="kindFilter" size="sm" :items="kindOptions" class="w-36" />
      </div>

      <!-- 当前其他筛选条件提示与重置 -->
      <div v-if="filters.problem_id || filters.contest_id || (usernameFilter !== (user?.username ?? '')) || kindFilter !== 'all'"
        class="ml-auto flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span v-if="filters.problem_id">题目: {{ filters.problem_id }}</span>
        <span v-if="filters.contest_id">比赛: {{ filters.contest_id }}</span>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw"
          @click="router.push({ query: { username: user?.username ?? '' } })">重置筛选</UButton>
      </div>
    </div>

    <AsyncContent :status="error ? 'error' : data?.data.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      :empty-text="usernameFilter ? '暂无符合条件的提交记录' : '此域暂无提交记录'" @retry="refresh()">
      <div class="overflow-x-auto rounded border border-border bg-bg-panel shadow-card">
        <UTable :data="data?.data ?? []" :columns="columns" :ui="{ th: 'px-3 py-3 text-xs', td: 'px-3 py-3 text-sm' }">
          <template #id-cell="{ row }">
            <NuxtLink
              :to="workspacePath(slug!, `${row.original.kind === 'objective' ? 'objective-submissions' : 'submissions'}/${row.original.public_id || row.original.id}`)"
              class="font-mono text-xs text-primary">#{{ row.original.public_id || row.original.id.slice(0, 8) }}</NuxtLink>
          </template>
          <template #problem-cell="{ row }">
            <NuxtLink v-if="row.original.resource_available"
              :to="workspaceProblemPath(slug!, row.original.reference.display_ref)"
              class="break-words font-medium text-text no-underline hover:text-primary"><span
                class="mr-2 font-mono text-xs text-primary">{{ row.original.reference.display_ref }}</span>{{ row.original.problem?.title }}</NuxtLink>
            <span v-else class="text-text-muted">资源不可用</span>
          </template>
          <template #user-cell="{ row }">
            <span class="whitespace-nowrap text-xs text-text-secondary">{{ row.original.username || (row.original.user_id ? row.original.user_id.slice(0, 8) : '—') }}</span>
          </template>
          <template #type_lang-cell="{ row }">
            <span v-if="row.original.kind === 'objective'" class="whitespace-nowrap text-xs text-text-secondary">客观题</span>
            <span v-else-if="row.original.language" class="whitespace-nowrap text-xs text-text-secondary">{{ languageLabels[row.original.language] ?? row.original.language }}</span>
            <span v-else-if="row.original.submission_mode" class="whitespace-nowrap text-xs text-text-secondary">{{ row.original.submission_mode }}</span>
            <span v-else class="text-xs text-text-muted">—</span>
          </template>
          <template #result-cell="{ row }">
            <DomainSubmissionStatus :submission="row.original" />
          </template>
          <template #version-cell="{ row }">
            <span class="whitespace-nowrap text-xs tabular-nums text-text-muted">{{ row.original.submitted_version == null ? '—' : `V${row.original.submitted_version}` }}</span>
          </template>
          <template #created_at-cell="{ row }">
            <span class="whitespace-nowrap text-xs tabular-nums text-text-muted">{{ formatDateTime(row.original.created_at) }}</span>
          </template>
        </UTable>
      </div>
    </AsyncContent>
    <PaginationNav v-if="data && data.pagination.total_pages > 1" :current-page="page"
      :total-pages="data.pagination.total_pages" @page-change="page = $event" />
  </div>
</template>
