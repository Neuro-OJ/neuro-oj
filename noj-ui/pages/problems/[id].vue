<script setup lang="ts">
import { useRoute, useRouter } from "vue-router"
import { Clock, Server, AlertCircle, Send, Loader2 } from "@lucide/vue"

const route = useRoute()
const router = useRouter()
const { isLoggedIn } = useAuth()

const problemId = route.params.id as string

// 题目数据
const { data, pending, error } = useFetch<{
  data: {
    id: string
    title: string
    description: string
    difficulty: string
    time_limit_ms: number
    memory_limit_mb: number
    categories: { id: string; name: string; slug: string }[]
  }
}>(`/api/v1/problems/${problemId}`)

const problem = computed(() => data.value?.data ?? null)

// 分类标签
const categories = computed(() => problem.value?.categories ?? [])

// 难度标签映射
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

// 提交表单 — 当前仅支持 Python 3
// TODO: 多语言支持（noj-judge 各语言评测镜像就绪后启用，见 noj-core/services/submissions.ts:208）
const language = "python3"
const code = ref("")
const submitting = ref(false)
const submitError = ref("")

async function handleSubmit() {
  if (!code.value.trim()) {
    submitError.value = "请先编写代码"
    return
  }
  submitting.value = true
  submitError.value = ""
  try {
    const res = await $fetch<{ data: { id: string } }>("/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: problemId,
        language,
        code: code.value,
      },
    })
    await router.push(`/submissions/${res.data.id}`)
  } catch (err: unknown) {
    const e = err as { data?: { error?: string }; status?: number; message?: string }
    const msg = e.data?.error || e.message || "提交失败，请稍后重试"
    submitError.value = msg
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="pending" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
    <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
    <span>加载中...</span>
  </div>

  <div v-else-if="error" class="flex flex-col items-center justify-center gap-4 px-6 py-20 text-text-muted">
    <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
    <p>题目加载失败</p>
    <NuxtLink to="/problems" class="btn btn-outline">返回题目列表</NuxtLink>
  </div>

  <div v-else-if="problem" class="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 p-6 min-h-[calc(100vh-64px)] items-start">
    <!-- 题目信息区 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-7 py-6 pb-5 border-b border-border">
        <h1 class="text-2xl font-bold mb-3 text-text">{{ problem.title }}</h1>
        <div class="flex items-center gap-5 flex-wrap">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold tracking-tight" :class="badgeColors[problem.difficulty] || ''">
            {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
          </span>
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
        <ProblemDescription :content="problem.description" />
      </div>
    </div>

    <!-- 代码提交区 -->
    <div class="bg-white border border-border rounded-xl p-5 sticky top-6 max-lg:static flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold">提交代码</h2>
        <div v-if="!isLoggedIn" class="text-xs text-text-muted">
          <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink> 后即可提交
        </div>
      </div>

      <div class="flex items-center gap-2 text-xs text-text-secondary">
        <span>语言：Python 3</span>
        <!-- TODO: 多语言支持启用后在此处添加语言选择器 -->
      </div>

      <div class="flex-1 min-h-0">
        <ClientOnly>
          <MonacoEditor
            v-model="code"
            :language="language"
            :disabled="!isLoggedIn || submitting"
            :min-height="320"
          />
          <template #fallback>
            <div class="flex flex-col items-center justify-center gap-3 min-h-[320px] bg-[#0d1117] border border-border rounded-lg text-[#8b949e] text-xs">
              <div class="h-[28px] w-[28px] border-[3px] border-border border-t-primary rounded-full animate-spin-slow" />
              <span>加载编辑器...</span>
            </div>
          </template>
        </ClientOnly>
      </div>

      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="opacity-0 -translate-y-1"
        leave-to-class="opacity-0 -translate-y-1"
      >
        <div v-if="submitError" class="flex items-center gap-2 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs">
          <AlertCircle :size="16" />
          <span>{{ submitError }}</span>
        </div>
      </Transition>

      <button
        class="btn btn-primary flex items-center justify-center gap-2 w-full py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="!isLoggedIn || submitting || !code.trim()"
        @click="handleSubmit"
      >
        <Loader2 v-if="submitting" class="animate-spin" :size="18" />
        <Send v-else :size="16" />
        <span>{{ submitting ? "提交中..." : "提交评测" }}</span>
      </button>
    </div>
  </div>
</template>
