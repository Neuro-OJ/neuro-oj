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
        <template v-for="(group, entityType) in groups" :key="entityType">
          <div v-if="group.items.length > 0" class="mb-6">
            <div class="flex items-center justify-between mb-2">
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
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { extractApiError } from "~/utils/apiError";
import AsyncContent from "~/components/ui/AsyncContent.vue";
import SearchResultItem from "~/components/feature/search/SearchResultItem.vue";
import type { SearchType, SearchItem } from "~/composables/useSearch";
import { typeLabel } from "~/utils/searchFormat";

definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();
const { api } = useApi();

const query = ref<string>((route.query.q as string) ?? "");
const rawType = (route.query.type as string) ?? "all";
// 兼容旧版 type=community：归一化为 community_post，否则旧链接打开后没有 Tab 激活。
const normalizedType = rawType === "community" ? "community_post" : rawType;
const type = ref<SearchType>(normalizedType === "all" ? "all" : normalizedType as SearchType);
const page = ref<number>(Number(route.query.page) || 1);
const limit = 20;
const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<SearchItem[]>([]);
const groups = ref<Record<string, { items: SearchItem[]; has_more: boolean }>>({});
const hasMore = ref(false);
const tookMs = ref<number | null>(null);
let searchRequestVersion = 0;
let urlSyncTimer: ReturnType<typeof setTimeout> | null = null;

const asyncStatus = computed<"loading" | "error" | "empty" | "data">(() => {
  if (loading.value) return "loading";
  if (error.value) return "error";
  if (
    query.value.trim().length >= 2 &&
    items.value.length === 0 &&
    !Object.values(groups.value).some((g) => g.items.length > 0)
  ) {
    return "empty";
  }
  return "data";
});

const typeOptions = [
  { value: "all" as SearchType, label: "全部" },
  { value: "problem" as SearchType, label: typeLabel("problem") },
  { value: "user" as SearchType, label: typeLabel("user") },
  { value: "community_post" as SearchType, label: typeLabel("community_post") },
  { value: "community_comment" as SearchType, label: typeLabel("community_comment") },
  { value: "contest" as SearchType, label: typeLabel("contest") },
  { value: "submission" as SearchType, label: typeLabel("submission") },
  { value: "message" as SearchType, label: typeLabel("message") },
  { value: "announcement" as SearchType, label: typeLabel("announcement") },
];

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
  const queryParams: Record<string, string> = {
    q: query.value,
    type: type.value,
  };
  // “全部”Tab 使用 grouped 模式，不涉及分页，URL 不写 page。
  if (type.value !== "all") {
    queryParams.page = String(page.value);
  }
  router.replace({ query: queryParams });
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
    searchRequestVersion++;
    items.value = [];
    groups.value = {};
    hasMore.value = false;
    tookMs.value = null;
    loading.value = false;
  }
  // 输入时防抖同步 URL，避免每个字符都写浏览器历史。
  if (urlSyncTimer) clearTimeout(urlSyncTimer);
  urlSyncTimer = setTimeout(() => syncUrl(), 300);
});

onMounted(() => {
  if (query.value.trim().length >= 2) fetchResults();
});

onUnmounted(() => {
  if (urlSyncTimer) clearTimeout(urlSyncTimer);
});
</script>
