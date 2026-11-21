<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime, languageLabels } from '~/utils/submissionFormat';
import { useToast } from '~/composables/useToast';
import { usePolling } from '~/composables/usePolling';
import TableSkeleton from '~/components/ui/TableSkeleton.vue';
import type { DomainSubmissionListQuery } from '~/composables/useDomainSubmissions';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], workspaceWidth: 'library' });

const route = useRoute();
const router = useRouter();
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainSubmissions();
const { toast } = useToast();

const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copySubmissionId(fullId: string) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(fullId);
      copiedId.value = fullId;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copiedId.value = null; }, 1500);
      toast.success('已复制完整提交编号');
    } else {
      toast.error('当前浏览器不支持自动复制，请在提交详情查看完整编号');
    }
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
}

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
let usernameDebounce: ReturnType<typeof setTimeout> | null = null;

watch(usernameFilter, (val) => {
  if (val !== usernameInput.value) {
    if (usernameDebounce) {
      clearTimeout(usernameDebounce);
      usernameDebounce = null;
    }
    usernameInput.value = val;
  }
});

// 初始访问无 query 参数时在客户端水合后同步到 URL，使刷新后状态不丢失
onMounted(() => {
  if (route.query.username === undefined && user.value?.username) {
    void router.replace({ query: { ...route.query, username: user.value.username } });
  }
});

onUnmounted(() => {
  if (usernameDebounce) clearTimeout(usernameDebounce);
  if (copiedTimer) clearTimeout(copiedTimer);
});

function applyUsername(name: string) {
  if (usernameDebounce) {
    clearTimeout(usernameDebounce);
    usernameDebounce = null;
  }
  usernameInput.value = name;
  if (name === usernameFilter.value) return;
  void router.push({
    query: {
      ...route.query,
      username: name,
      page: undefined,
    },
  });
}

function onUsernameInput(val: string) {
  usernameInput.value = val;
  if (usernameDebounce) clearTimeout(usernameDebounce);
  usernameDebounce = setTimeout(() => {
    usernameDebounce = null;
    if (val !== usernameFilter.value) {
      void router.push({
        query: {
          ...route.query,
          username: val,
          page: undefined,
        },
      });
    }
  }, 350);
}

function setOnlyMe() {
  applyUsername(user.value?.username ?? '');
}

function clearUsername() {
  applyUsername('');
}

const isOnlyMe = computed(() => !!user.value?.username && usernameFilter.value === user.value.username);
const isAllUsers = computed(() => usernameFilter.value === '');

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

// 仅当前页存在进行中记录时自动轮询，全部终态即自动停止
const hasPendingSubmissions = computed(() =>
  (data.value?.data ?? []).some((item) => item.status === 'pending' || item.status === 'judging')
);

usePolling({
  intervalMs: computed(() => (hasPendingSubmissions.value ? 2000 : null)),
  active: hasPendingSubmissions,
  immediate: false,
  fetcher: () => refresh(),
});

function clearExtraFilter(field: 'problem_id' | 'contest_id') {
  void router.push({
    query: {
      ...route.query,
      [field]: undefined,
      page: undefined,
    },
  });
}

const columns = [
  { accessorKey: 'id', header: '提交号' },
  { accessorKey: 'problem', header: '题目', meta: { class: { th: 'w-full', td: 'min-w-36 whitespace-normal' } } },
  { accessorKey: 'user', header: '提交者' },
  { accessorKey: 'type_lang', header: '题型 / 语言' },
  { accessorKey: 'result', header: '评测结果' },
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
  <div class="space-y-4">
    <LibraryPageHeader title="提交记录" description="查看评测结果，按提交者与题型实时筛选" icon="i-lucide-file-code-2">
      <template #actions>
        <span
          v-if="hasPendingSubmissions"
          class="inline-flex items-center gap-1.5 rounded-sm border border-primary/25 bg-primary-bg px-2.5 py-1 text-xs font-medium text-primary"
        >
          <span class="size-1.5 rounded-full bg-primary animate-pulse" />
          实时刷新中
        </span>
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-refresh-cw" aria-label="刷新提交"
          :loading="status === 'pending'" @click="refresh()" />
      </template>
    </LibraryPageHeader>

    <!-- 统一筛选工具栏 -->
    <div class="space-y-3 rounded-md border border-border bg-bg-panel p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2.5">
        <!-- 视角分段快切 -->
        <div class="inline-flex items-center rounded-sm border border-border bg-bg-sunken/70 p-0.5" role="group" aria-label="提交范围切换">
          <UButton
            v-if="user?.username"
            size="xs"
            :color="isOnlyMe ? 'primary' : 'neutral'"
            :variant="isOnlyMe ? 'solid' : 'ghost'"
            icon="i-lucide-user"
            @click="setOnlyMe"
          >
            仅看本人
          </UButton>
          <UButton
            size="xs"
            :color="isAllUsers ? 'primary' : 'neutral'"
            :variant="isAllUsers ? 'solid' : 'ghost'"
            @click="clearUsername"
          >
            全部用户
          </UButton>
        </div>

        <!-- 用户名防抖筛选 -->
        <div class="min-w-44 flex-1">
          <UInput
            :model-value="usernameInput"
            size="sm"
            icon="i-lucide-search"
            placeholder="按用户名筛选..."
            class="w-full"
            aria-label="用户名"
            @update:model-value="onUsernameInput(String($event ?? ''))"
            @keyup.enter="applyUsername(usernameInput)"
          />
        </div>

        <!-- 题型筛选（即时触发） -->
        <div class="w-36 sm:w-40">
          <USelect id="submission-kind" v-model="kindFilter" size="sm" :items="kindOptions" class="w-full" aria-label="题型" />
        </div>

        <UButton
          v-if="usernameFilter"
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          title="清空用户（查看全部用户）"
          @click="clearUsername"
        >
          清空
        </UButton>
      </div>

      <!-- 附加上下文筛选 Chips -->
      <div
        v-if="filters.problem_id || filters.contest_id || kindFilter !== 'all'"
        class="flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5 text-xs"
      >
        <span class="text-text-muted mr-1">当前条件：</span>
        <button
          v-if="filters.problem_id"
          type="button"
          class="inline-flex items-center gap-1 rounded-sm border border-primary/25 bg-primary-bg px-2 py-0.5 font-medium text-primary hover:bg-primary-hover-bg"
          @click="clearExtraFilter('problem_id')"
        >
          <span>题目: {{ filters.problem_id }}</span>
          <UIcon name="i-lucide-x" class="size-3" />
        </button>
        <button
          v-if="filters.contest_id"
          type="button"
          class="inline-flex items-center gap-1 rounded-sm border border-primary/25 bg-primary-bg px-2 py-0.5 font-medium text-primary hover:bg-primary-hover-bg"
          @click="clearExtraFilter('contest_id')"
        >
          <span>比赛: {{ filters.contest_id }}</span>
          <UIcon name="i-lucide-x" class="size-3" />
        </button>
        <button
          v-if="kindFilter !== 'all'"
          type="button"
          class="inline-flex items-center gap-1 rounded-sm border border-primary/25 bg-primary-bg px-2 py-0.5 font-medium text-primary hover:bg-primary-hover-bg"
          @click="kindFilter = 'all'"
        >
          <span>题型: {{ kindOptions.find((k) => k.value === kindFilter)?.label ?? kindFilter }}</span>
          <UIcon name="i-lucide-x" class="size-3" />
        </button>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          class="ml-auto"
          @click="router.push({ query: { username: user?.username ?? '' } })"
        >
          重置筛选
        </UButton>
      </div>
    </div>

    <AsyncContent :status="error ? 'error' : data?.data.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      :empty-text="usernameFilter ? '暂无符合条件的提交记录' : '此域暂无提交记录'" @retry="refresh()">
      <template #loading>
        <TableSkeleton :rows="8" :columns="['w-20', 'flex-1', 'w-20', 'w-20', 'w-24', 'w-12', 'w-28']" />
      </template>
      <div class="overflow-x-auto rounded-md border border-border bg-bg-panel">
        <UTable :data="data?.data ?? []" :columns="columns" :ui="{ th: 'bg-bg-sunken/70 px-3 py-2.5 text-xs font-semibold text-text-secondary', td: 'px-3 py-2.5 text-sm', tr: 'transition-colors hover:bg-bg-sunken/40' }">
          <template #id-cell="{ row }">
            <div class="flex items-center gap-1">
              <NuxtLink
                :to="workspacePath(slug!, `${row.original.kind === 'objective' ? 'objective-submissions' : 'submissions'}/${row.original.public_id || row.original.id}`)"
                :title="`完整提交编号: ${row.original.public_id || row.original.id}`"
                class="font-mono text-xs text-primary whitespace-nowrap tabular-nums hover:underline"
              >
                #{{ (row.original.public_id || row.original.id).length > 12 ? (row.original.public_id || row.original.id).slice(0, 8) + '…' : (row.original.public_id || row.original.id) }}
              </NuxtLink>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="copiedId === (row.original.public_id || row.original.id) ? 'i-lucide-check' : 'i-lucide-copy'"
                class="size-5 p-0 opacity-60 hover:opacity-100"
                :class="copiedId === (row.original.public_id || row.original.id) ? 'text-signal opacity-100' : ''"
                aria-label="复制完整提交编号"
                :title="`复制完整编号: ${row.original.public_id || row.original.id}`"
                @click.stop="copySubmissionId(row.original.public_id || row.original.id)"
              />
            </div>
          </template>
          <template #problem-cell="{ row }">
            <NuxtLink v-if="row.original.resource_available"
              :to="workspaceProblemPath(slug!, row.original.reference.display_ref)"
              class="break-words font-medium text-text no-underline transition-colors hover:text-primary"><span
                class="mr-2 font-mono text-xs tabular-nums text-primary">{{ row.original.reference.display_ref }}</span>{{ row.original.problem?.title }}</NuxtLink>
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
