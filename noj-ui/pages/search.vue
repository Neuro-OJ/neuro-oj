<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-baseline gap-3 mb-6">
      <Search :size="22" class="text-primary self-center" />
      <h1 class="text-2xl font-bold text-text">搜索</h1>
      <span v-if="!pending && !error" class="text-sm text-text-muted">共 {{ total }} 条结果</span>
    </div>

    <!-- 搜索表单 -->
    <form class="flex items-center gap-2 mb-6" @submit.prevent="onSearch">
      <div class="flex-1 flex items-center gap-2 px-3 py-2 bg-white border border-border rounded-lg">
        <Search :size="16" class="text-text-muted shrink-0" />
        <input
          v-model="inputQ"
          type="text"
          placeholder="输入关键词..."
          class="flex-1 outline-none bg-transparent text-sm placeholder:text-text-muted"
          autocomplete="off"
        />
      </div>
      <select
        v-if="isAdmin"
        v-model="inputType"
        class="px-3 py-2 bg-white border border-border rounded-lg text-sm"
      >
        <option value="problem">题目</option>
        <option value="user">用户</option>
      </select>
      <button
        type="submit"
        class="btn btn-primary px-4 py-2 text-sm"
        :disabled="!inputQ.trim()"
      >
        搜索
      </button>
    </form>

    <!-- 加载中 -->
    <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>搜索中...</span>
    </div>

    <!-- 错误 -->
    <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="alert">
      <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
      <p>搜索失败：{{ errorMessage }}</p>
      <button class="btn btn-outline px-4 py-1.5 text-xs" @click="refresh">重试</button>
    </div>

    <!-- 空查询 -->
    <div v-else-if="!q" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status">
      <Search :size="48" class="opacity-30" />
      <p>输入关键词开始搜索</p>
    </div>

    <!-- 无结果 -->
    <div v-else-if="items.length === 0" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted" role="status">
      <Search :size="48" class="opacity-30" />
      <p>没有匹配 "{{ q }}" 的结果</p>
    </div>

    <!-- 结果列表：题目 -->
    <ul v-else-if="inputType === 'problem'" class="space-y-2">
      <li
        v-for="item in items"
        :key="item.id"
        class="bg-white border border-border rounded-lg px-4 py-3 hover:border-primary hover:shadow-card transition-all"
      >
        <NuxtLink :to="`/problems/${item.id}`" class="flex items-center gap-3 no-underline">
          <span class="font-mono text-xs text-primary font-semibold shrink-0">{{ item.display_id }}</span>
          <span class="flex-1 text-sm text-text">{{ item.title }}</span>
          <span class="text-xs text-text-muted shrink-0">{{ item.difficulty }}</span>
        </NuxtLink>
      </li>
    </ul>

    <!-- 结果列表：用户 -->
    <ul v-else class="space-y-2">
      <li
        v-for="item in items"
        :key="item.id"
        class="bg-white border border-border rounded-lg px-4 py-3 hover:border-primary hover:shadow-card transition-all"
      >
        <NuxtLink :to="`/users/${item.id}/profile`" class="flex items-center gap-3 no-underline">
          <span class="font-medium text-sm text-text shrink-0">{{ item.username }}</span>
          <span class="flex-1 text-xs text-text-muted truncate">{{ item.email }}</span>
          <span v-if="item.role === 'admin'" class="text-xs px-1.5 py-0.5 bg-warning-text/10 text-warning-text rounded">admin</span>
        </NuxtLink>
      </li>
    </ul>

    <!-- 分页 -->
    <PaginationNav
      v-if="!pending && !error && q && total > limit"
      :current-page="page"
      :total-pages="Math.ceil(total / limit)"
      @page-change="onPageChange"
    />
  </div>
</template>

<script setup lang="ts">
import { Search } from "@lucide/vue"

definePageMeta({
  ssr: false,
})

interface ProblemSearchHit {
  id: string
  type: string
  number: number
  display_id: string
  title: string
  difficulty: string
}

interface UserSearchHit {
  id: string
  username: string
  email: string
  role: string
}

interface PageResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

const route = useRoute()
const router = useRouter()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === "admin")

// URL → 状态
const q = computed(() => (Array.isArray(route.query.q) ? route.query.q[0] : route.query.q) ?? "")
const inputType = ref<"problem" | "user">(
  isAdmin.value && route.query.type === "user" ? "user" : "problem"
)
const page = computed<number>(() => {
  const raw = route.query.page
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})
const limit = 20

// 表单输入（独立于 URL，避免输入抖动 URL）
const inputQ = ref(q.value)
watch(q, (newQ) => {
  inputQ.value = newQ
})

function onSearch() {
  router.push({
    query: {
      q: inputQ.value.trim(),
      type: inputType.value,
      page: "1",
    },
  })
}

function onPageChange(p: number) {
  router.push({ query: { ...route.query, page: String(p) } })
}

// 拉取数据
const searchUrl = computed(() => {
  if (!q.value) return null
  return `/api/v1/search?q=${encodeURIComponent(q.value)}&type=${inputType.value}&page=${page.value}&limit=${limit}`
})

const { data, pending, error, refresh } = await useAsyncData<PageResponse<ProblemSearchHit | UserSearchHit>>(
  "search-page",
  () => $fetch(searchUrl.value!),
  {
    watch: [searchUrl],
    immediate: !!q.value,
    default: () => ({ items: [], total: 0, page: 1, limit }),
  },
)

const items = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)
const errorMessage = computed(() => {
  const err = error.value
  if (!err) return ""
  if (typeof err === "object" && err && "data" in err) {
    // deno-lint-ignore no-explicit-any
    const data = (err as any).data
    if (data?.error) return data.error
  }
  return "请稍后重试"
})
</script>