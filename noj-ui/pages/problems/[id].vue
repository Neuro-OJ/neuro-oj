<script setup lang="ts">
import { useRoute } from "vue-router"
import { Clock, Server, Pencil, Code2 } from "@lucide/vue"

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user } = useAuth()

const problemId = route.params.id as string

const { data, pending, error } = useFetch<{
  data: {
    id: string
    title: string
    description: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    display_id: string
    type: string
    owner_id: string
    number: number
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId}`)

const problem = computed(() => data.value?.data ?? null)

const categories = computed(() => problem.value?.categories ?? [])

const canEdit = computed(() => {
  const p = problem.value
  if (!p) return false
  return user.value?.role === "admin" || (p.type === "U" && p.owner_id === user.value?.id)
})

const isDetailPage = computed(() => route.path === `/problems/${problemId}`)

function goToEditor() {
  router.push(`/editor/${problemId}`)
}
</script>

<template>
  <NuxtPage v-if="!isDetailPage" />

  <template v-else>
    <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
      <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
      <p>题目加载失败</p>
      <NuxtLink to="/problems" class="btn btn-outline">返回题目列表</NuxtLink>
    </div>

    <div v-else-if="problem" class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- 题目信息卡片 -->
      <div class="bg-white border border-border rounded-xl overflow-hidden">
        <div class="px-7 py-6 pb-5 border-b border-border">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
                >
                  {{ problem.display_id }}
                </span>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="problem.type === 'U' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'"
                >
                  {{ problem.type === 'U' ? '用户题库' : '主题库' }}
                </span>
              </div>
              <h1 class="text-2xl font-bold mb-3 text-text">{{ problem.title }}</h1>
            </div>
            <NuxtLink
              v-if="canEdit"
              :to="`/problems/${problem.id}/edit`"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-text-secondary hover:text-primary hover:border-primary/40 transition-colors"
            >
              <Pencil :size="14" />
              编辑
            </NuxtLink>
          </div>
          <div class="flex items-center gap-5 flex-wrap">
            <DifficultyBadge :difficulty="problem.difficulty" />
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Clock :size="14" />
              {{ problem.time_limit_ms }}ms
            </span>
            <span class="inline-flex items-center gap-1 text-xs text-text-secondary">
              <Server :size="14" />
              {{ problem.memory_limit_mb }}MB
            </span>
          </div>
          <div v-if="categories.length" class="flex flex-wrap gap-1.5 mt-2.5">
            <span
              v-for="cat in categories"
              :key="cat.id"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
            >
              {{ cat.name }}
            </span>
          </div>
        </div>

        <div class="px-7 py-6">
          <MarkdownRenderer :content="problem.description" />
        </div>
      </div>

      <!-- 开始编码 CTA -->
      <div class="bg-white border border-border rounded-xl p-6 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-text mb-1">准备好开始编码了吗？</h2>
          <p class="text-sm text-text-secondary">
            点击下方按钮进入独立编码页面，享受沉浸式编辑器体验。
          </p>
        </div>
        <button
          class="btn btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
          @click="goToEditor"
        >
          <Code2 :size="16" />
          开始编码
        </button>
      </div>

      <div v-if="!isLoggedIn" class="text-center text-sm text-text-muted">
        <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
        后即可提交代码
      </div>
    </div>
  </template>
</template>