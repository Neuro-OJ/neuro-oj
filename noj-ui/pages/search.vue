<!--
  /search 完整结果页（issue #100）。

  与 SearchPalette（命令面板）分离：本页支持分页 + URL 同步 + 类型切换。
  兼容 AsyncContent 实际接口（:status 单值状态机）和 PaginationNav
  实际 props/emit（:current-page / :total-pages + @page-change）。
-->
<template>
  <div class="max-w-3xl mx-auto px-6 py-8">
    <h1 class="text-2xl font-bold text-text mb-6">搜索结果</h1>

    <!-- 搜索框 -->
    <div class="flex items-center gap-3 px-4 h-12 border border-border rounded-md bg-white mb-4">
      <SearchIcon class="w-5 h-5 text-text-muted" />
      <input
        v-model="query"
        type="text"
        placeholder="搜索题目、用户..."
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
        共 {{ total }} 条结果，耗时 {{ tookMs }}ms
      </div>

      <div class="bg-white border border-border rounded-md overflow-hidden divide-y divide-border">
        <SearchResultItem
          v-for="item in items"
          :key="item.id || item.username"
          :item="item"
          :kind="type === 'user' ? 'user' : 'problem'"
        />
      </div>

      <!-- 分页 -->
      <PaginationNav
        v-if="totalPages > 1"
        :current-page="page"
        :total-pages="totalPages"
        class="mt-6"
        @page-change="setPage"
      />
    </AsyncContent>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { Search as SearchIcon } from "@lucide/vue";
import AsyncContent from "~/components/ui/AsyncContent.vue";
import PaginationNav from "~/components/shared/PaginationNav.vue";
import SearchResultItem from "~/components/feature/search/SearchResultItem.vue";
import type {
  SearchType,
  ProblemSearchResult,
  UserSearchResult,
} from "~/composables/useSearch";

definePageMeta({ layout: "default" });

const route = useRoute();
const router = useRouter();

const query = ref<string>((route.query.q as string) ?? "");
const type = ref<SearchType>(((route.query.type as string) ?? "problem") as SearchType);
const page = ref<number>(Number(route.query.page) || 1);
const limit = 20;
const loading = ref(false);
const error = ref<string | null>(null);
const items = ref<(ProblemSearchResult | UserSearchResult)[]>([]);
const total = ref(0);
const tookMs = ref<number | null>(null);

// AsyncContent 实际使用单值 :status，把 loading/error/empty 折叠成状态机
const asyncStatus = computed<"loading" | "error" | "empty" | "data">(() => {
  if (loading.value) return "loading";
  if (error.value) return "error";
  if (query.value.trim().length >= 2 && items.value.length === 0) return "empty";
  return "data";
});

const totalPages = computed(() => {
  if (total.value === 0) return 0;
  return Math.ceil(total.value / limit);
});

const typeOptions = [
  { value: "problem" as SearchType, label: "题目" },
  { value: "user" as SearchType, label: "用户" },
];

async function fetchResults() {
  const q = query.value.trim();
  if (q.length < 2) {
    items.value = [];
    total.value = 0;
    tookMs.value = null;
    error.value = null;
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    const res = await $fetch("/api/v1/search", {
      params: {
        q,
        type: type.value === "user" ? "user" : "problem",
        page: page.value,
        limit,
      },
    });
    const data = (res as { data: { items: (ProblemSearchResult | UserSearchResult)[]; total: number; took_ms: number } }).data;
    items.value = data.items;
    total.value = data.total;
    tookMs.value = data.took_ms;
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } };
    error.value = err?.data?.error ?? "搜索失败";
    items.value = [];
    total.value = 0;
    tookMs.value = null;
  } finally {
    loading.value = false;
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
    total.value = 0;
    tookMs.value = null;
  }
});

onMounted(() => {
  if (query.value.trim().length >= 2) fetchResults();
});
</script>
