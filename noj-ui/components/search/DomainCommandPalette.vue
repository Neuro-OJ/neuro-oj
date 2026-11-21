<script setup lang="ts">
import type { SearchItem } from '~/utils/domain/workspace/search-types';
import { domainSearchHref, domainSearchReference } from '~/utils/domain/workspace/domain-search';
import { workspaceCacheKey, workspacePath, type WorkspaceSummary } from '~/utils/domain/workspace/workspace';
import { workspaceNavigation } from '~/utils/domain/workspace/workspace-navigation';
import { workspaceSettingsNavigation } from '~/utils/domain/workspace/workspace-settings';
import { extractApiError } from '~/utils/server/apiError';

const { isOpen, close } = useDomainCommandPalette();
const slug = useNavigationDomain();
const workspace = useOptionalWorkspace();
const { user, isLoggedIn } = useAuth();
const domainQuery = useDomainQuery();
const workspacesApi = useWorkspaceApi();
const knowledge = useKnowledge();

const query = ref('');
const activeType = ref<'problem' | 'contest' | 'submission' | 'announcement'>('problem');
const selectedIndex = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const results = ref<SearchItem[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);
const listboxRef = ref<HTMLElement | null>(null);

const SEARCH_TYPES: Array<{ value: 'problem' | 'contest' | 'submission' | 'announcement'; label: string; icon: string }> = [
  { value: 'problem', label: '题目', icon: 'i-lucide-book-open' },
  { value: 'contest', label: '比赛', icon: 'i-lucide-trophy' },
  { value: 'submission', label: '提交', icon: 'i-lucide-file-code-2' },
  { value: 'announcement', label: '公告', icon: 'i-lucide-megaphone' },
];

// 与 UserMenu 共用同一缓存键，避免额外请求
const { data: spacesData } = useAsyncData(
  () => workspaceCacheKey('', user.value?.id ?? null, 'user-menu-domains'),
  () => user.value ? workspacesApi.list(true) : Promise.resolve({ data: [] as WorkspaceSummary[] }),
  { immediate: false },
);

const spaces = computed(() => spacesData.value?.data ?? []);

interface PaletteAction {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  badge?: string;
  run: () => void | Promise<void>;
}

const navActions = computed<PaletteAction[]>(() => {
  const domain = workspace?.domain.value;
  const entries = domain
    ? workspaceNavigation(domain, { knowledgeEnabled: !knowledge.disabled.value })
    : [
        { label: '首页', section: '', to: workspacePath(slug.value), icon: 'i-lucide-home' },
        { label: '题库', section: 'problems', to: workspacePath(slug.value, 'problems'), icon: 'i-lucide-book-open' },
        { label: '题单', section: 'trainings', to: workspacePath(slug.value, 'trainings'), icon: 'i-lucide-list-ordered' },
        { label: '比赛', section: 'contests', to: workspacePath(slug.value, 'contests'), icon: 'i-lucide-trophy' },
        ...(isLoggedIn.value
          ? [
              { label: '提交', section: 'submissions', to: workspacePath(slug.value, 'submissions'), icon: 'i-lucide-code-2' },
              { label: '评测队列', section: 'queue', to: workspacePath(slug.value, 'queue'), icon: 'i-lucide-activity' },
            ]
          : []),
      ];

  const items: PaletteAction[] = entries
    .filter((entry) => entry.section !== 'search')
    .map((entry) => ({
      id: `nav:${entry.section || 'home'}`,
      title: entry.label,
      subtitle: `前往 ${domain?.name ?? slug.value} · ${entry.label}`,
      icon: entry.icon,
      badge: '导航',
      run: async () => {
        close();
        await navigateTo(entry.to);
      },
    }));

  if (domain) {
    const settingsEntry = workspaceSettingsNavigation(domain)[0];
    if (settingsEntry) {
      items.push({
        id: 'nav:settings',
        title: '域设置',
        subtitle: `管理 ${domain.name} 的成员、权限与配置`,
        icon: 'i-lucide-settings',
        badge: '管理',
        run: async () => {
          close();
          await navigateTo(settingsEntry.to);
        },
      });
    }
  }

  for (const space of spaces.value) {
    if (space.slug === slug.value) continue;
    items.push({
      id: `domain:${space.slug}`,
      title: `切换到「${space.name}」`,
      subtitle: `@${space.slug}`,
      icon: 'i-lucide-building-2',
      badge: '切换域',
      run: async () => {
        close();
        await workspacesApi.remember(space.slug);
        await navigateTo(workspacePath(space.slug));
      },
    });
  }

  const kw = query.value.trim().toLowerCase();
  if (!kw) return items;
  return items.filter(
    (item) => item.title.toLowerCase().includes(kw) || item.subtitle.toLowerCase().includes(kw),
  );
});

const isSearchMode = computed(() => query.value.trim().length >= 2);

const searchActions = computed<PaletteAction[]>(() =>
  results.value.map((item) => {
    const ref = domainSearchReference(item);
    const href = domainSearchHref(slug.value, item);
    return {
      id: `result:${item.entity_type}:${item.entity_id}`,
      title: ref ? `${ref.display_ref} · ${item.title}` : item.title,
      subtitle: SEARCH_TYPES.find((t) => t.value === item.entity_type)?.label || item.entity_type,
      icon: SEARCH_TYPES.find((t) => t.value === item.entity_type)?.icon || 'i-lucide-file-text',
      badge: ref?.display_ref,
      run: async () => {
        close();
        if (href) await navigateTo(href);
      },
    };
  }),
);

const activeActions = computed(() => (isSearchMode.value ? searchActions.value : navActions.value));

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let requestSeq = 0;

function clearPendingSearch() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

onScopeDispose(clearPendingSearch);

async function executeSearch() {
  const trimmed = query.value.trim();
  const currentSlug = slug.value;
  if (trimmed.length < 2) {
    requestSeq++;
    results.value = [];
    loading.value = false;
    error.value = null;
    return;
  }
  const seq = ++requestSeq;
  loading.value = true;
  error.value = null;
  try {
    const res = await domainQuery.search(currentSlug, trimmed, activeType.value, 1);
    if (seq !== requestSeq || slug.value !== currentSlug) return;
    results.value = res.data.items.slice(0, 12);
    selectedIndex.value = 0;
  } catch (err) {
    if (seq !== requestSeq) return;
    error.value = extractApiError(err).message;
    results.value = [];
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch([query, activeType], () => {
  clearPendingSearch();
  selectedIndex.value = 0;
  if (!isSearchMode.value) {
    requestSeq++;
    results.value = [];
    loading.value = false;
    error.value = null;
    return;
  }
  debounceTimer = setTimeout(() => {
    void executeSearch();
  }, 250);
});

watch(isOpen, async (opened) => {
  if (opened) {
    selectedIndex.value = 0;
    await nextTick();
    inputRef.value?.focus();
  } else {
    clearPendingSearch();
  }
});

watch(selectedIndex, async (idx) => {
  await nextTick();
  const options = listboxRef.value?.querySelectorAll<HTMLElement>('[role="option"]');
  options?.[idx]?.scrollIntoView?.({ block: 'nearest' });
});

watch(slug, () => {
  query.value = '';
  results.value = [];
  error.value = null;
});

function cycleType(direction: 1 | -1 = 1) {
  const idx = SEARCH_TYPES.findIndex((t) => t.value === activeType.value);
  const nextIdx = (idx + direction + SEARCH_TYPES.length) % SEARCH_TYPES.length;
  activeType.value = SEARCH_TYPES[nextIdx]!.value;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleType(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (activeActions.value.length > 0) {
      selectedIndex.value = (selectedIndex.value + 1) % activeActions.value.length;
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (activeActions.value.length > 0) {
      selectedIndex.value = (selectedIndex.value - 1 + activeActions.value.length) % activeActions.value.length;
    }
    return;
  }
  if (e.key === 'Enter') {
    const action = activeActions.value[selectedIndex.value];
    if (action) {
      e.preventDefault();
      void action.run();
    } else if (isSearchMode.value) {
      e.preventDefault();
      void openFullSearch();
    }
  }
}

async function openFullSearch() {
  const q = query.value.trim();
  const targetType = activeType.value;
  close();
  await navigateTo({
    path: workspacePath(slug.value, 'search'),
    query: { ...(q ? { q } : {}), type: targetType },
  });
}
</script>

<template>
  <UModal
    v-model:open="isOpen"
    title="域内命令面板"
    description="快速导航、切换域或搜索当前域资源"
    :ui="{ content: 'max-w-2xl p-0 overflow-hidden rounded-lg bg-bg-elevated' }"
  >
    <template #content>
      <div class="flex flex-col bg-bg-elevated text-text" @keydown="onKeydown">
        <!-- 顶部输入区 -->
        <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <UIcon name="i-lucide-search" class="size-4 shrink-0 text-text-muted" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            aria-label="在当前域内搜索或跳转"
            :placeholder="`在「${workspace?.domain.value?.name ?? slug}」内搜索题目、比赛、提交，或输入页面名跳转...`"
            class="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
            autocomplete="off"
            spellcheck="false"
          >
          <button
            v-if="query"
            type="button"
            class="rounded-sm p-1 text-text-muted hover:bg-bg-sunken hover:text-text"
            aria-label="清空输入"
            @click="query = ''"
          >
            <UIcon name="i-lucide-x" class="size-3.5" />
          </button>
          <kbd class="hidden sm:inline-flex items-center rounded-sm border border-border bg-bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-text-muted">ESC</kbd>
        </div>

        <!-- 搜索分类切换（输入 >= 2 字符时高亮搜索模式，Tab 可快速切换） -->
        <div class="flex items-center justify-between gap-2 border-b border-border bg-bg-sunken/60 px-4 py-1.5">
          <div class="flex items-center gap-1" role="tablist" aria-label="搜索资源类型">
            <button
              v-for="item in SEARCH_TYPES"
              :key="item.value"
              type="button"
              role="tab"
              :aria-selected="activeType === item.value"
              class="inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors"
              :class="activeType === item.value
                ? 'bg-bg-panel text-primary shadow-xs ring-1 ring-border'
                : 'text-text-secondary hover:text-text'"
              @click="activeType = item.value"
            >
              <UIcon :name="item.icon" class="size-3.5" />
              {{ item.label }}
            </button>
          </div>
          <span class="hidden text-[11px] text-text-muted sm:inline">
            <template v-if="isSearchMode">当前域 @{{ slug }}</template>
            <template v-else>输入 2+ 字符启用全文搜索</template>
          </span>
        </div>

        <!-- 结果与快捷动作区 -->
        <div ref="listboxRef" class="max-h-[52vh] overflow-y-auto p-2" role="listbox" aria-label="命令面板结果">
          <div v-if="loading" class="space-y-1.5 p-2">
            <div v-for="i in 4" :key="i" class="flex items-center gap-3 rounded-sm px-3 py-2.5 animate-pulse">
              <div class="size-4 rounded-sm bg-bg-sunken" />
              <div class="h-3.5 flex-1 rounded-sm bg-bg-sunken" />
            </div>
          </div>

          <div v-else-if="error" class="px-4 py-8 text-center text-sm text-error-text">
            {{ error }}
          </div>

          <div v-else-if="activeActions.length === 0" class="px-4 py-8 text-center text-sm text-text-muted">
            {{ isSearchMode ? '当前域下没有匹配结果' : '没有匹配的快捷入口' }}
          </div>

          <button
            v-for="(action, idx) in activeActions"
            :key="action.id"
            type="button"
            role="option"
            :aria-selected="selectedIndex === idx"
            class="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors"
            :class="selectedIndex === idx ? 'bg-primary-bg text-primary' : 'text-text hover:bg-bg-sunken/80'"
            @mouseenter="selectedIndex = idx"
            @click="action.run()"
          >
            <UIcon :name="action.icon" class="size-4 shrink-0" :class="selectedIndex === idx ? 'text-primary' : 'text-text-muted'" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ action.title }}</div>
              <div class="truncate text-xs text-text-muted">{{ action.subtitle }}</div>
            </div>
            <span
              v-if="action.badge"
              class="shrink-0 rounded-sm border border-border bg-bg-sunken px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-text-secondary"
            >
              {{ action.badge }}
            </span>
          </button>
        </div>

        <!-- 底部快捷键提示 + 完整搜索页跳转 -->
        <div class="flex items-center justify-between border-t border-border bg-bg-sunken/70 px-4 py-2 text-[11px] text-text-muted">
          <div class="flex items-center gap-3">
            <span><kbd class="rounded-sm border border-border bg-bg-panel px-1 py-0.5 font-mono">↑↓</kbd> 选择</span>
            <span><kbd class="rounded-sm border border-border bg-bg-panel px-1 py-0.5 font-mono">↵</kbd> 打开</span>
            <span class="hidden sm:inline"><kbd class="rounded-sm border border-border bg-bg-panel px-1 py-0.5 font-mono">Tab</kbd> 切换类型</span>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            @click="openFullSearch"
          >
            前往完整搜索页
            <UIcon name="i-lucide-arrow-right" class="size-3" />
          </button>
        </div>
      </div>
    </template>
  </UModal>
</template>
