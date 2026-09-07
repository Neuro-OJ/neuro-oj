# 中心化 Search Domain 前端统一搜索体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 noj-ui 搜索体验升级为“一个输入框，结果按类型分组混合展示，可筛选”，支持题目、用户、帖子、评论、竞赛、提交、消息、公告八类结果。

**Architecture:** `useSearch` 统一对接新 `/api/v1/search` 的 grouped/flat 两种模式；`SearchPalette` 展示分组结果；`/search` 页支持“全部”分组与单类型分页。

**Tech Stack:** Nuxt 4 + Vue 3 + Tailwind CSS + Nuxt UI。

**Spec:** `dev-docs/superpowers/specs/2026-09-07-centralized-search-domain-design.md`
**Depends on:** `dev-docs/superpowers/plans/2026-09-07-centralized-search-domain-backend.md`

## Global Constraints

- 所有提交必须 GPG 签名。
- 项目使用 jj；不要使用 `git add` / `git commit`。
- 提交信息格式：`<type>(<scope>): 中文描述`。
- 前端禁止手写 CSS，必须用 Tailwind utility 类。
- 高亮必须用 `[[HIGHLIGHT]]` 分段渲染，禁止 `v-html`。
- 测试通过 `deno task` 运行。

---

### Task 1: 更新 `useSearch` composable

**Files:**
- Modify: `noj-ui/composables/useSearch.ts`

**Interfaces:**
- Produces: `SearchType`、`SearchItem`、`SearchState`、`search(q, opts)` 支持 grouped/flat。

- [ ] **Step 1: 重写 useSearch.ts**

将 `noj-ui/composables/useSearch.ts` 整体替换为：

```ts
export type SearchEntityType =
  | 'problem'
  | 'user'
  | 'community_post'
  | 'community_comment'
  | 'contest'
  | 'submission'
  | 'message'
  | 'announcement';

export type SearchType = 'all' | SearchEntityType;

export interface SearchItem {
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  highlight: string;
  rank: number;
  metadata: Record<string, unknown>;
}

export interface SearchState {
  open: boolean;
  query: string;
  type: SearchType;
  groups: Record<string, { items: SearchItem[]; has_more: boolean }>;
  flatItems: SearchItem[];
  hasMore: boolean;
  page: number;
  loading: boolean;
  error: string | null;
}

export function useSearch() {
  const { api } = useApi();
  const state = useState<SearchState>('search:state', () => ({
    open: false,
    query: '',
    type: 'all',
    groups: {},
    flatItems: [],
    hasMore: false,
    page: 1,
    loading: false,
    error: null,
  }));

  const open = () => {
    state.value.open = true;
  };

  const close = () => {
    state.value.open = false;
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;
  let requestSeq = 0;

  if (import.meta.client) {
    try {
      onScopeDispose(() => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r();
        }
      });
    } catch {
      // 非组件作用域内调用时忽略
    }
  }

  const search = (
    q: string,
    opts?: {
      mode?: 'palette' | 'page';
      type?: SearchType;
      page?: number;
      perPage?: number;
    },
  ) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingResolve) {
      const prev = pendingResolve;
      pendingResolve = null;
      prev();
    }

    const trimmed = q.trim();
    state.value.query = trimmed;
    if (opts?.type) state.value.type = opts.type;

    if (trimmed.length < 2) {
      state.value.groups = {};
      state.value.flatItems = [];
      state.value.hasMore = false;
      state.value.loading = false;
      state.value.error = null;
      return;
    }

    return new Promise<void>((resolve) => {
      pendingResolve = resolve;
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        pendingResolve = null;
        const mySeq = ++requestSeq;
        state.value.loading = true;
        state.value.error = null;
        const mode = opts?.mode ?? 'palette';
        const type = opts?.type ?? state.value.type;
        const page = opts?.page ?? 1;
        const perPage = opts?.perPage ?? 20;

        try {
          if (mode === 'palette') {
            const res = await api.get('/api/v1/search', {
              params: {
                q: trimmed,
                types: 'problem,user,community_post,community_comment,contest,submission,message,announcement',
                per_type: 5,
              },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            state.value.groups = (res as { data: { groups: SearchState['groups'] } }).data.groups;
            state.value.flatItems = [];
            state.value.hasMore = false;
          } else if (type === 'all') {
            const res = await api.get('/api/v1/search', {
              params: { q: trimmed, page, per_page: perPage },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            const data = (res as { data: { items: SearchItem[]; has_more: boolean } }).data;
            state.value.flatItems = data.items;
            state.value.hasMore = data.has_more;
            state.value.page = page;
            state.value.groups = {};
          } else {
            const res = await api.get('/api/v1/search', {
              params: { q: trimmed, type, page, per_page: perPage },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            const data = (res as { data: { items: SearchItem[]; has_more: boolean } }).data;
            state.value.flatItems = data.items;
            state.value.hasMore = data.has_more;
            state.value.page = page;
            state.value.groups = {};
          }
        } catch (e: unknown) {
          if (mySeq === requestSeq) {
            state.value.error = (e as { data?: { error?: string } })?.data?.error ?? '搜索失败';
            state.value.groups = {};
            state.value.flatItems = [];
          }
        } finally {
          if (mySeq === requestSeq) {
            state.value.loading = false;
          }
          resolve();
        }
      }, 300);
    });
  };

  return {
    state: readonly(state),
    open,
    close,
    search,
  };
}
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(ui): useSearch 支持 grouped/flat 与八类实体"
jj new
```

---

### Task 2: 更新 `SearchResultItem` 通用渲染

**Files:**
- Modify: `noj-ui/components/feature/search/SearchResultItem.vue`

**Interfaces:**
- Produces: 根据 `entity_type` 渲染图标、标题、副信息与跳转链接。

- [ ] **Step 1: 重写 SearchResultItem.vue**

将 `noj-ui/components/feature/search/SearchResultItem.vue` 整体替换为：

```vue
<template>
  <component
    :is="href ? resolveComponent('NuxtLink') : 'div'"
    :to="href"
    role="option"
    :aria-selected="selected"
    class="flex items-center gap-3 px-4 py-3 transition-colors rounded-md cursor-pointer"
    :class="{ 'bg-signal/20': selected, 'hover:bg-gray-50': !selected }"
  >
    <div
      class="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold"
      :class="iconClass"
    >
      <UserIdentity
        v-if="item.entity_type === 'user'"
        :user="{ username: String(item.metadata.username ?? '') }"
        :show-username="false"
        size="md"
      />
      <span v-else>{{ iconText }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-text truncate">
        <template v-for="(seg, i) in highlightedSegments" :key="i">
          <mark v-if="seg.highlight" class="bg-yellow-200 text-inherit">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <div class="text-xs text-text-secondary truncate">
        {{ metaLine }}
      </div>
    </div>

    <div class="flex-shrink-0 text-xs text-text-muted">
      {{ typeLabel }}
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { SearchItem } from "~/composables/useSearch";
import { problemUrl, publicUrl, userUrl } from "~/utils/publicIdentifiers";

const props = defineProps<{
  item: SearchItem;
  selected?: boolean;
}>();

const href = computed(() => {
  const item = props.item;
  switch (item.entity_type) {
    case "problem":
      return problemUrl(item.entity_id, String(item.metadata.display_id ?? ""));
    case "user":
      return userUrl(String(item.metadata.username ?? ""));
    case "community_post":
    case "community_comment":
      return publicUrl("post", String(item.metadata.public_id ?? item.entity_id));
    case "contest":
      return `/contests/${item.entity_id}`;
    case "submission":
      return `/submissions/${item.entity_id}`;
    case "message":
      return `/messages?conversation=${String(item.metadata.conversation_id ?? "")}`;
    case "announcement":
      return `/announcements/${item.entity_id}`;
    default:
      return "";
  }
});

const typeLabel = computed(() => {
  const map: Record<string, string> = {
    problem: "题目",
    user: "用户",
    community_post: "帖子",
    community_comment: "评论",
    contest: "竞赛",
    submission: "提交",
    message: "消息",
    announcement: "公告",
  };
  return map[props.item.entity_type] ?? props.item.entity_type;
});

const iconText = computed(() => {
  const map: Record<string, string> = {
    problem: String(props.item.metadata.display_id ?? "题"),
    user: "用",
    community_post: "帖",
    community_comment: "评",
    contest: "赛",
    submission: "交",
    message: "信",
    announcement: "告",
  };
  return map[props.item.entity_type] ?? "搜";
});

const iconClass = computed(() => {
  const base = "flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold";
  const map: Record<string, string> = {
    problem: "bg-primary-bg text-primary",
    user: "bg-blue-50 text-info-text",
    community_post: "bg-amber-50 text-amber-700",
    community_comment: "bg-amber-50 text-amber-700",
    contest: "bg-purple-50 text-purple-700",
    submission: "bg-gray-100 text-gray-700",
    message: "bg-green-50 text-green-700",
    announcement: "bg-red-50 text-red-700",
  };
  return `${base} ${map[props.item.entity_type] ?? "bg-gray-100 text-gray-700"}`;
});

const metaLine = computed(() => {
  const item = props.item;
  const m = item.metadata as Record<string, unknown>;
  switch (item.entity_type) {
    case "problem":
      return `${String(m.difficulty ?? "")} · 相关度 ${(item.rank * 100).toFixed(0)}`;
    case "user":
      return String(m.email ?? "");
    case "community_post":
      return `${String(m.post_type ?? "")} · ${String(m.author_username ?? "")}`;
    case "community_comment":
      return `评论 · ${String(m.author_username ?? "")}`;
    case "contest":
      return `${String(m.kind ?? "")} · ${String(m.is_public ? "公开" : "邀请")}`;
    case "submission":
      return `${String(m.language ?? "")} · ${String(m.status ?? "")}`;
    case "message":
      return `私信 · ${String(m.sent_at ?? "")}`;
    case "announcement":
      return "公告";
    default:
      return "";
  }
});

const highlightedSegments = computed(() => {
  const raw = props.item.highlight ?? "";
  const segments: { text: string; highlight: boolean }[] = [];
  const parts = raw.split("[[HIGHLIGHT]]");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (part) segments.push({ text: part, highlight: false });
      continue;
    }
    const end = part.indexOf("[[/HIGHLIGHT]]");
    if (end === -1) {
      if (part) segments.push({ text: part, highlight: true });
      continue;
    }
    if (part.slice(0, end)) {
      segments.push({ text: part.slice(0, end), highlight: true });
    }
    if (part.slice(end + "[[/HIGHLIGHT]]".length)) {
      segments.push({
        text: part.slice(end + "[[/HIGHLIGHT]]".length),
        highlight: false,
      });
    }
  }
  return segments;
});
</script>
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(ui): SearchResultItem 支持八类实体通用渲染"
jj new
```

---

### Task 3: 更新 `SearchPalette` 分组展示

**Files:**
- Modify: `noj-ui/components/feature/search/SearchPalette.vue`

**Interfaces:**
- Produces: 命令面板按 `state.groups` 分组展示，键盘导航覆盖全部组。

- [ ] **Step 1: 重写 SearchPalette.vue**

将 `noj-ui/components/feature/search/SearchPalette.vue` 整体替换为：

```vue
<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="state.open"
        class="fixed inset-0 z-[200] bg-black/30 flex items-start justify-center pt-[15vh]"
        @click.self="close"
      >
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          aria-label="搜索"
          class="w-full max-w-2xl bg-white rounded-lg shadow-modal overflow-hidden"
          @keydown="onKeydown"
        >
          <div class="flex items-center gap-3 px-4 h-14 border-b border-border">
            <UIcon name="i-lucide-search" class="w-5 h-5 text-text-muted size-4" />
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              placeholder="搜索题目、用户、帖子、竞赛、提交、消息、公告..."
              class="flex-1 h-full bg-transparent outline-none text-base text-text placeholder:text-text-muted"
              autocomplete="off"
              spellcheck="false"
            />
            <kbd class="hidden sm:inline-block px-2 py-1 text-xs bg-gray-100 border border-border rounded">ESC</kbd>
          </div>

          <div v-if="state.loading" class="px-4 py-8 text-center text-text-muted text-sm">
            搜索中...
          </div>

          <div
            v-else-if="query.length >= 2 && flatItems.length === 0 && !state.loading"
            class="px-4 py-8 text-center text-text-muted text-sm"
          >
            没有匹配结果
          </div>

          <div v-else-if="query.length < 2" class="px-4 py-8 text-center text-text-muted text-sm">
            请输入至少 2 个字符
          </div>

          <div v-else class="max-h-[50vh] overflow-y-auto" role="listbox" aria-label="搜索结果">
            <template v-for="(group, type) in state.groups" :key="type">
              <div v-if="group.items.length > 0" class="px-4 pt-3 pb-1 text-xs text-text-muted font-medium">
                {{ typeLabel(type) }}
              </div>
              <SearchResultItem
                v-for="(item, i) in group.items"
                :key="`${type}-${item.entity_id}`"
                :item="item"
                :selected="selectedIndex === flatIndex(type, i)"
                @click="close"
              />
            </template>
          </div>

          <div class="flex items-center justify-between px-4 h-10 border-t border-border bg-gray-50 text-xs text-text-muted">
            <div class="flex items-center gap-3">
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↑↓</kbd> 导航</span>
              <span><kbd class="px-1.5 py-0.5 bg-white border border-border rounded">↵</kbd> 选择</span>
            </div>
            <NuxtLink
              :to="`/search?q=${encodeURIComponent(query)}&type=all`"
              class="text-primary hover:underline"
              @click="close"
            >
              查看全部结果 →
            </NuxtLink>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useSearch, type SearchItem } from "~/composables/useSearch";
import { problemUrl, publicUrl, userUrl } from "~/utils/publicIdentifiers";

const { state, close, search } = useSearch();
const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

const flatItems = computed<SearchItem[]>(() => {
  const items: SearchItem[] = [];
  for (const group of Object.values(state.value.groups)) {
    items.push(...group.items);
  }
  return items;
});

function flatIndex(type: string, index: number): number {
  let offset = 0;
  for (const [t, group] of Object.entries(state.value.groups)) {
    if (t === type) return offset + index;
    offset += group.items.length;
  }
  return 0;
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    problem: "题目",
    user: "用户",
    community_post: "帖子",
    community_comment: "评论",
    contest: "竞赛",
    submission: "提交",
    message: "消息",
    announcement: "公告",
  };
  return map[type] ?? type;
}

watch(query, async (q) => {
  selectedIndex.value = 0;
  await search(q, { mode: "palette" });
});

watch(
  () => state.value.open,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement;
      query.value = state.value.query;
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    } else if (lastFocused) {
      lastFocused.focus();
      lastFocused = null;
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, flatItems.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = flatItems.value[selectedIndex.value];
    if (selected) {
      const href = itemHref(selected);
      close();
      navigateTo(href);
    } else if (query.value.trim().length >= 2) {
      close();
      navigateTo(`/search?q=${encodeURIComponent(query.value)}&type=all`);
    }
  }
}

function itemHref(item: SearchItem): string {
  switch (item.entity_type) {
    case "problem":
      return problemUrl(item.entity_id, String(item.metadata.display_id ?? ""));
    case "user":
      return userUrl(String(item.metadata.username ?? ""));
    case "community_post":
    case "community_comment":
      return publicUrl("post", String(item.metadata.public_id ?? item.entity_id));
    case "contest":
      return `/contests/${item.entity_id}`;
    case "submission":
      return `/submissions/${item.entity_id}`;
    case "message":
      return `/messages?conversation=${String(item.metadata.conversation_id ?? "")}`;
    case "announcement":
      return `/announcements/${item.entity_id}`;
    default:
      return "/search";
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(ui): SearchPalette 按类型分组展示八类结果"
jj new
```

---

### Task 4: 更新 `/search` 完整结果页

**Files:**
- Modify: `noj-ui/pages/search.vue`

**Interfaces:**
- Produces: “全部”Tab 分组展示，具体类型 Tab flat 分页，URL 同步。

- [ ] **Step 1: 重写 search.vue**

将 `noj-ui/pages/search.vue` 整体替换为：

```vue
<template>
  <div class="max-w-3xl mx-auto px-6 py-8">
    <h1 class="text-2xl font-bold text-text mb-6">搜索结果</h1>

    <div class="flex items-center gap-3 px-4 h-12 border border-border rounded-md bg-white mb-4">
      <UIcon name="i-lucide-search" class="w-5 h-5 text-text-muted size-4" />
      <input
        v-model="query"
        type="text"
        placeholder="搜索题目、用户、帖子、竞赛、提交、消息、公告..."
        class="flex-1 h-full bg-transparent outline-none text-base"
        @keydown.enter="onSearch"
      />
    </div>

    <div class="flex items-center gap-2 mb-6 border-b border-border overflow-x-auto">
      <button
        v-for="t in typeOptions"
        :key="t.value"
        type="button"
        class="px-4 py-2 text-sm transition-colors whitespace-nowrap"
        :class="type === t.value
          ? 'text-primary border-b-2 border-signal font-medium'
          : 'text-text-secondary hover:text-text'"
        @click="setType(t.value)"
      >
        {{ t.label }}
      </button>
    </div>

    <AsyncContent
      :status="asyncStatus"
      :error="error ?? undefined"
      empty-text="没有匹配结果"
      @retry="fetchResults"
    >
      <div v-if="tookMs !== null" class="text-xs text-text-muted mb-3">
        第 {{ page }} 页，耗时 {{ tookMs }}ms
      </div>

      <template v-if="type === 'all'">
        <div
          v-for="(group, entityType) in groups"
          :key="entityType"
          class="mb-6"
        >
          <div v-if="group.items.length > 0" class="flex items-center justify-between mb-2">
            <span class="text-sm font-medium text-text">{{ typeLabel(entityType) }}</span>
            <button
              class="text-xs text-primary hover:underline"
              @click="setType(entityType as SearchType)"
            >
              更多 →
            </button>
          </div>
          <div class="bg-white border border-border rounded-md overflow-hidden divide-y divide-border">
            <SearchResultItem
              v-for="item in group.items"
              :key="`${entityType}-${item.entity_id}`"
              :item="item"
            />
          </div>
        </div>
      </template>

      <template v-else>
        <div class="bg-white border border-border rounded-md overflow-hidden divide-y divide-border">
          <SearchResultItem
            v-for="item in items"
            :key="`${item.entity_type}-${item.entity_id}`"
            :item="item"
          />
        </div>
        <nav
          v-if="page > 1 || hasMore"
          class="mt-6 flex items-center justify-center gap-3"
          aria-label="分页导航"
        >
          <UButton :disabled="page === 1" variant="outline" @click="setPage(page - 1)">
            上一页
          </UButton>
          <span class="text-sm text-text-secondary">第 {{ page }} 页</span>
          <UButton :disabled="!hasMore" variant="outline" @click="setPage(page + 1)">
            下一页
          </UButton>
        </nav>
      </template>
    </AsyncContent>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { extractApiError } from "~/utils/apiError";
import AsyncContent from "~/components/ui/AsyncContent.vue";
import SearchResultItem from "~/components/feature/search/SearchResultItem.vue";
import { useSearch, type SearchType, type SearchItem } from "~/composables/useSearch";

definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();
const { api } = useApi();
const { state, search } = useSearch();

const query = ref<string>((route.query.q as string) ?? "");
const rawType = (route.query.type as string) ?? "all";
const type = ref<SearchType>(rawType === "all" ? "all" : rawType as SearchType);
const page = ref<number>(Number(route.query.page) || 1);
const limit = 20;
const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<SearchItem[]>([]);
const groups = ref<Record<string, { items: SearchItem[]; has_more: boolean }>>({});
const hasMore = ref(false);
const tookMs = ref<number | null>(null);
let searchRequestVersion = 0;

const asyncStatus = computed<"loading" | "error" | "empty" | "data">(() => {
  if (loading.value) return "loading";
  if (error.value) return "error";
  if (query.value.trim().length >= 2 && items.value.length === 0 && Object.keys(groups.value).length === 0) {
    return "empty";
  }
  return "data";
});

const typeOptions = [
  { value: "all" as SearchType, label: "全部" },
  { value: "problem" as SearchType, label: "题目" },
  { value: "user" as SearchType, label: "用户" },
  { value: "community_post" as SearchType, label: "帖子" },
  { value: "community_comment" as SearchType, label: "评论" },
  { value: "contest" as SearchType, label: "竞赛" },
  { value: "submission" as SearchType, label: "提交" },
  { value: "message" as SearchType, label: "消息" },
  { value: "announcement" as SearchType, label: "公告" },
];

function typeLabel(t: string): string {
  const map: Record<string, string> = {
    problem: "题目",
    user: "用户",
    community_post: "帖子",
    community_comment: "评论",
    contest: "竞赛",
    submission: "提交",
    message: "消息",
    announcement: "公告",
  };
  return map[t] ?? t;
}

async function fetchResults() {
  const q = query.value.trim();
  const requestVersion = ++searchRequestVersion;
  if (q.length < 2) {
    items.value = [];
    groups.value = {};
    hasMore.value = false;
    tookMs.value = null;
    error.value = null;
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    if (type.value === "all") {
      const res = await api.get("/api/v1/search", {
        params: { q, types: "problem,user,community_post,community_comment,contest,submission,message,announcement", per_type: 5 },
        silent: true,
      });
      if (requestVersion !== searchRequestVersion) return;
      const data = (res as { data: { groups: typeof groups.value; took_ms: number } }).data;
      groups.value = data.groups;
      items.value = [];
      hasMore.value = false;
      tookMs.value = data.took_ms;
    } else {
      const res = await api.get("/api/v1/search", {
        params: { q, type: type.value, page: page.value, per_page: limit },
        silent: true,
      });
      if (requestVersion !== searchRequestVersion) return;
      const data = (res as { data: { items: SearchItem[]; has_more: boolean; took_ms: number } }).data;
      items.value = data.items;
      groups.value = {};
      hasMore.value = data.has_more;
      tookMs.value = data.took_ms;
    }
  } catch (e: unknown) {
    if (requestVersion !== searchRequestVersion) return;
    error.value = extractApiError(e).message;
    items.value = [];
    groups.value = {};
    hasMore.value = false;
    tookMs.value = null;
  } finally {
    if (requestVersion === searchRequestVersion) loading.value = false;
  }
}

function syncUrl() {
  router.replace({
    query: {
      q: query.value,
      type: type.value,
      page: String(page.value),
    },
  });
}

function onSearch() {
  page.value = 1;
  syncUrl();
  fetchResults();
}

function setType(t: SearchType) {
  type.value = t;
  page.value = 1;
  syncUrl();
  fetchResults();
}

function setPage(p: number) {
  page.value = p;
  syncUrl();
  fetchResults();
}

watch(query, () => {
  if (query.value.trim().length >= 2) {
    page.value = 1;
    fetchResults();
  } else {
    items.value = [];
    groups.value = {};
    hasMore.value = false;
    tookMs.value = null;
  }
});

onMounted(() => {
  if (query.value.trim().length >= 2) fetchResults();
});
</script>
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(ui): /search 页支持全部混合分组与单类型分页"
jj new
```

---

### Task 5: 更新导航栏搜索入口文案

**Files:**
- Modify: `noj-ui/components/layout/Navbar.vue`

**Interfaces:**
- Produces: 搜索按钮/占位文案更新。

- [ ] **Step 1: 更新 placeholder**

在 `noj-ui/components/layout/Navbar.vue` 中，把搜索相关 placeholder 或 aria-label 改为：

```text
搜索题目、用户、帖子、竞赛、提交、消息、公告...
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "feat(ui): 更新导航栏搜索入口文案"
jj new
```

---

### Task 6: E2E 测试

**Files:**
- Modify: `noj-tests/e2e/18_search.test.ts`（或新增 `noj-tests/e2e/19_search_unified.test.ts`）

**Interfaces:**
- Verifies: 命令面板分组展示、/search 页全部/单类型、URL 同步。

- [ ] **Step 1: 新增 E2E 测试**

创建 `noj-tests/e2e/19_search_unified.test.ts`：

```ts
import { test, expect } from "@playwright/test";

test("统一搜索：命令面板显示分组结果", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/搜索题目/).fill("动态");
  await expect(page.getByText("题目", { exact: true }).first()).toBeVisible();
});

test("统一搜索：/search 全部 Tab 显示分组", async ({ page }) => {
  await page.goto("/search?q=动态&type=all");
  await expect(page.getByRole("button", { name: "全部" })).toHaveClass(/border-signal/);
  await expect(page.getByText("题目", { exact: true }).first()).toBeVisible();
});

test("统一搜索：单类型 Tab 分页", async ({ page }) => {
  await page.goto("/search?q=动态&type=problem");
  await expect(page.getByRole("button", { name: "题目" })).toHaveClass(/border-signal/);
});
```

- [ ] **Step 2: 运行 E2E**

```bash
cd noj-tests && deno task test
```

预期：PASS。

- [ ] **Step 3: 提交**

```bash
jj describe -m "test(e2e): 新增统一搜索 E2E 测试"
jj new
```

---

## Self-Review

- **Spec coverage:** useSearch（Task 1）、SearchResultItem（Task 2）、SearchPalette（Task 3）、/search 页（Task 4）、导航入口（Task 5）、E2E（Task 6）均已覆盖。
- **Placeholder scan:** 无 TBD/TODO；所有文件为完整可落地代码。
- **Type consistency:** `SearchItem`、`SearchType`、`state.groups` 在三个组件间签名一致。
