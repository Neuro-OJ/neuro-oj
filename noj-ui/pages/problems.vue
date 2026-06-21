<script setup lang="ts">
import { FileText, Clock, Server } from "@lucide/vue"

const route = useRoute()

interface ProblemItem {
  id: string
  title: string
  description: string
  difficulty: string
  time_limit_ms: number
  memory_limit_mb: number
  categories: { id: string; name: string; slug: string }[]
  created_at: string
  updated_at: string
}

interface ProblemsResponse {
  data: ProblemItem[]
  total: number
  page: number
  limit: number
}

const page = ref(1)
const limit = 20

const { data, pending, error, refresh } = useFetch<ProblemsResponse>(
  () => `/api/v1/problems?page=${page.value}&limit=${limit}`,
)

const problems = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)))

const difficultyLabel: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

const badgeColors: Record<string, string> = {
  easy: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  hard: "bg-red-100 text-red-700",
}

function prevPage() {
  if (page.value > 1) {
    page.value--
  }
}

function nextPage() {
  if (page.value < totalPages.value) {
    page.value++
  }
}
</script>

<template>
  <NuxtPage v-if="route.params.id" />
  <div v-else class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-baseline gap-3 mb-6">
      <h1 class="text-2xl font-bold text-text">题库</h1>
      <span class="text-sm text-text-muted">{{ total }} 道题目</span>
    </div>

    <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
      <p>题目加载失败</p>
      <button class="btn btn-outline px-4 py-1.5 text-xs" @click="refresh">重试</button>
    </div>

    <div v-else-if="problems.length === 0" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <FileText :size="48" class="opacity-30" />
      <p>暂无题目</p>
    </div>

    <template v-else>
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th class="w-20 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">#</th>
              <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">题目</th>
              <th class="w-20 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">难度</th>
              <th class="w-[140px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">分类</th>
              <th class="w-[100px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">时间</th>
              <th class="w-[100px] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border hidden sm:table-cell">内存</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="problem in problems"
              :key="problem.id"
              class="cursor-pointer transition-colors duration-150 hover:bg-gray-50"
              @click="$router.push(`/problems/${problem.id}`)"
            >
              <td class="w-20 px-4 py-3.5">
                <span class="font-mono text-xs text-text-muted">{{ problem.id }}</span>
              </td>
              <td class="px-4 py-3.5">
                <NuxtLink
                  :to="`/problems/${problem.id}`"
                  class="text-text no-underline font-medium hover:text-primary"
                >
                  {{ problem.title }}
                </NuxtLink>
              </td>
              <td class="w-20 px-4 py-3.5">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" :class="badgeColors[problem.difficulty] || ''">
                  {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
                </span>
              </td>
              <td class="w-[140px] px-4 py-3.5">
                <span
                  v-for="cat in problem.categories"
                  :key="cat.id"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 mr-1"
                >{{ cat.name }}</span>
                <span v-if="!problem.categories?.length" class="text-xs text-text-muted">--</span>
              </td>
              <td class="w-[100px] px-4 py-3.5 text-xs text-text-secondary hidden sm:table-cell">
                <Clock :size="13" class="inline-block" />
                {{ problem.time_limit_ms }}ms
              </td>
              <td class="w-[100px] px-4 py-3.5 text-xs text-text-secondary hidden sm:table-cell">
                <Server :size="13" class="inline-block" />
                {{ problem.memory_limit_mb }}MB
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="flex items-center justify-center gap-4 mt-5">
        <button
          class="btn btn-outline px-4 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="page <= 1"
          @click="prevPage"
        >
          上一页
        </button>
        <span class="text-xs text-text-muted">{{ page }} / {{ totalPages }}</span>
        <button
          class="btn btn-outline px-4 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="page >= totalPages"
          @click="nextPage"
        >
          下一页
        </button>
      </div>
    </template>
  </div>
</template>
