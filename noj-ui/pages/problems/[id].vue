<script setup lang="ts">
import { useRoute, useRouter } from "vue-router"
import { Clock, Server, AlertCircle, Send, Loader2 } from "@lucide/vue"

const route = useRoute()
const router = useRouter()
const { token, isLoggedIn } = useAuth()

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

// 提交表单
const language = ref("python3")
const code = ref("")
const submitting = ref(false)
const submitError = ref("")

const languageOptions = [
  { value: "python3", label: "Python 3" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "javascript", label: "JavaScript" },
]

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
      headers: { Authorization: `Bearer ${token.value}` },
      body: {
        problem_id: problemId,
        language: language.value,
        code: code.value,
      },
    })
    await router.push(`/submissions/${res.data.id}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "提交失败，请稍后重试"
    submitError.value = msg
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="pending" class="loading-state">
    <div class="spinner" />
    <span>加载中...</span>
  </div>

  <div v-else-if="error" class="error-state">
    <span class="error-icon">!</span>
    <p>题目加载失败</p>
    <NuxtLink to="/problems" class="btn btn-outline">返回题目列表</NuxtLink>
  </div>

  <div v-else-if="problem" class="problem-page">
    <!-- 题目信息区 -->
    <div class="problem-main">
      <div class="problem-header">
        <h1 class="problem-title">{{ problem.title }}</h1>
        <div class="problem-meta">
          <span class="difficulty-badge" :class="problem.difficulty">
            {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
          </span>
          <span class="meta-item">
            <Clock :size="14" />
            {{ problem.time_limit_ms }}ms
          </span>
          <span class="meta-item">
            <Server :size="14" />
            {{ problem.memory_limit_mb }}MB
          </span>
        </div>
        <div v-if="categories.length" class="problem-categories">
          <span
            v-for="cat in categories"
            :key="cat.id"
            class="category-tag"
          >
            {{ cat.name }}
          </span>
        </div>
      </div>

      <div class="problem-description">
        <ProblemDescription :content="problem.description" />
      </div>
    </div>

    <!-- 代码提交区 -->
    <div class="submit-panel">
      <div class="panel-header">
        <h2>提交代码</h2>
        <div v-if="!isLoggedIn" class="login-hint">
          <NuxtLink to="/login">登录</NuxtLink> 后即可提交
        </div>
      </div>

      <div class="language-selector">
        <label for="lang">语言</label>
        <select id="lang" v-model="language" class="select-input">
          <option
            v-for="opt in languageOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </div>

      <div class="code-editor">
        <ClientOnly>
          <MonacoEditor
            v-model="code"
            :language="language"
            :disabled="!isLoggedIn || submitting"
            :min-height="320"
          />
          <template #fallback>
            <div class="editor-loading">
              <div class="spinner" />
              <span>加载编辑器...</span>
            </div>
          </template>
        </ClientOnly>
      </div>

      <Transition name="drop">
        <div v-if="submitError" class="error-banner-inline">
          <AlertCircle :size="16" />
          <span>{{ submitError }}</span>
        </div>
      </Transition>

      <button
        class="btn btn-primary submit-btn"
        :disabled="!isLoggedIn || submitting || !code.trim()"
        @click="handleSubmit"
      >
        <Loader2 v-if="submitting" class="btn-spinner" :size="18" />
        <Send v-else :size="16" />
        <span>{{ submitting ? "提交中..." : "提交评测" }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.problem-page {
  display: grid;
  grid-template-columns: 1fr 420px;
  gap: 24px;
  padding: 24px;
  min-height: calc(100vh - 64px);
  align-items: start;
}

/* ── Problem Main ── */
.problem-main {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  overflow: hidden;
}

.problem-header {
  padding: 24px 28px 20px;
  border-bottom: 1px solid var(--c-border);
}

.problem-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--c-text);
}

.problem-meta {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.difficulty-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.difficulty-badge.easy {
  background: #dcfce7;
  color: #166534;
}

.difficulty-badge.medium {
  background: #fef9c3;
  color: #854d0e;
}

.difficulty-badge.hard {
  background: #fee2e2;
  color: #991b1b;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--c-text-secondary);
}

.problem-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.category-tag {
  display: inline-flex;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.problem-description {
  padding: 24px 28px;
}

/* ── Submit Panel ── */
.submit-panel {
  background: var(--c-white);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 20px;
  position: sticky;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.login-hint {
  font-size: 13px;
  color: var(--c-text-muted);
}

.login-hint a {
  color: var(--c-primary);
  text-decoration: none;
}

.login-hint a:hover {
  text-decoration: underline;
}

.language-selector {
  display: flex;
  align-items: center;
  gap: 10px;
}

.language-selector label {
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-secondary);
  white-space: nowrap;
}

.select-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--c-white);
  color: var(--c-text);
  cursor: pointer;
  outline: none;
}

.select-input:focus {
  border-color: var(--c-primary);
}

.code-editor {
  flex: 1;
  min-height: 0;
}

.editor-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 320px;
  background: #0d1117;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  color: #8b949e;
  font-size: 13px;
}

.error-banner-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #991b1b;
  font-size: 13px;
}

.submit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px;
  font-size: 14px;
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Loading / Error ── */
.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 24px;
  color: var(--c-text-muted);
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--c-border);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #fee2e2;
  color: #991b1b;
  font-size: 20px;
  font-weight: 700;
}

/* ── Transition ── */
.drop-enter-active,
.drop-leave-active {
  transition: all 0.2s ease;
}

.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── Responsive ── */
@media (max-width: 900px) {
  .problem-page {
    grid-template-columns: 1fr;
  }

  .submit-panel {
    position: static;
  }
}
</style>
