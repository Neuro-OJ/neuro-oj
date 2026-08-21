<!--
  /search 完整结果页（issue #100）。

  与 SearchPalette（命令面板）分离：本页支持分页 + URL 同步 + 类型切换。
  使用 has_more 游标式分页，避免为搜索结果计算精确总数。
-->
<template>
  <div class="max-w-3xl mx-auto px-6 py-8">
    <h1 class="text-2xl font-bold text-text mb-6">搜索结果</h1>

    <!-- 搜索框 -->
    <div class="flex items-center gap-3 px-4 h-12 border border-border rounded-md bg-white mb-4">
      <UIcon name="i-lucide-search" class="w-5 h-5 text-text-muted size-4" />
      <input
        v-model="query"
        type="text"
        placeholder="搜索题目、用户、帖子..."
        class="flex-1 h-full bg-transparent outline-none text-base"
        @keydown.enter="onSearch"
      />
    </div>

    <!-- 类型切换 -->
    <div class="flex items-center gap-2 mb-6 border-b border-border">
      <button
        v-for="t in typeOptions"
        :key="t.value"
        type="button"
        class="px-4 py-2 text-sm transition-colors"
        :class="type === t.value
          ? 'text-primary border-b-2 border-primary font-medium'
          : 'text-text-secondary hover:text-text'"
        @click="setType(t.value)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 状态展示（loading / error / empty / data 由 AsyncContent 状态机统一处理） -->
    <AsyncContent
      :status="asyncStatus"
      :error="error ?? undefined"
      empty-text="没有匹配结果"
      @retry="fetchResults"
    >
      <div v-if="tookMs !== null" class="text-xs text-text-muted mb-3">
        第 {{ page }} 页，耗时 {{ tookMs }}ms
      </div>

      <div class="bg-white border border-border rounded-md overflow-hidden divide-y divide-border">
        <SearchResultItem
          v-for="item in items"
          :key="item.id || item.username"
          :item="item"
          :kind="type === 'user' ? 'user' : type === 'community' ? 'community' : 'problem'"
        />
      </div>

      <!-- 分页 -->
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
    </AsyncContent>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { extractApiError } from "~/utils/apiError";

import AsyncContent from "~/components/ui/AsyncContent.vue";
import SearchResultItem from "~/components/feature/search/SearchResultItem.vue";
import type {
  SearchType,
  ProblemSearchResult,
  UserSearchResult,
  CommunitySearchResult,
} from "~/composables/useSearch";

definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();
const { api } = useApi();

const query = ref<string>((route.query.q as string) ?? "");
// NOJ-207：命令面板跳转带 type=all，完整页后端只支持单类型；归一化为 problem。
const rawType = (route.query.type as string) ?? "problem";
const type = ref<SearchType>(rawType === "all" ? "problem" : rawType as SearchType);
const page = ref<number>(Number(route.query.page) || 1);
const limit = 20;
const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<(ProblemSearchResult | UserSearchResult | CommunitySearchResult)[]>([]);
const hasMore = ref(false);
const tookMs = ref<number | null>(null);
// NOJ-208：输入实时搜索竞态防护，过期响应不得覆盖新结果。
let searchRequestVersion = 0;

// AsyncContent 实际使用单值 :status，把 loading/error/empty 折叠成状态机
const asyncStatus = computed<"loading" | "error" | "empty" | "data">(() => {
  if (loading.value) return "loading";
  if (error.value) return "error";
  if (query.value.trim().length >= 2 && items.value.length === 0) return "empty";
  return "data";
});

const typeOptions = [
  { value: "problem" as SearchType, label: "题目" },
  { value: "user" as SearchType, label: "用户" },
  { value: "community" as SearchType, label: "帖子" },
];

async function fetchResults() {
  const q = query.value.trim();
  const requestVersion = ++searchRequestVersion;
  if (q.length < 2) {
    items.value = [];
    hasMore.value = false;
    tookMs.value = null;
    error.value = null;
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    const res = await api.get("/api/v1/search", {
      params: {
        q,
        type: type.value,
        page: page.value,
        per_page: limit,
      },
      silent: true,
    });
    if (requestVersion !== searchRequestVersion) return;
    const data = (res as {
      data: {
        items: (ProblemSearchResult | UserSearchResult | CommunitySearchResult)[];
        has_more: boolean;
        took_ms: number;
      };
    }).data;
    items.value = data.items;
    hasMore.value = data.has_more;
    tookMs.value = data.took_ms;
  } catch (e: unknown) {
    if (requestVersion !== searchRequestVersion) return;
    error.value = extractApiError(e).message;
    items.value = [];
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
  // 实时搜索（输入即触发，无 debounce——简短查询早退保证请求频次可控）
  if (query.value.trim().length >= 2) {
    page.value = 1;
    fetchResults();
  } else {
    items.value = [];
    hasMore.value = false;
    tookMs.value = null;
  }
});

onMounted(() => {
  if (query.value.trim().length >= 2) fetchResults();
});
</script>
