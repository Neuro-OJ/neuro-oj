<script setup lang="ts">
import { ArrowLeft, Save, Eye, Edit3, CheckCircle, AlertCircle } from "@lucide/vue"

definePageMeta({ ssr: false })

const { token, user, isLoggedIn, loading } = useAuth()
const router = useRouter()

// 认证守卫：loading 就绪后检查登录状态
watch(
  loading,
  (loadingVal) => {
    if (!loadingVal && !isLoggedIn.value) {
      router.replace("/login")
    }
  },
  { immediate: true },
)

// Bio 编辑
const bio = ref("")
const previewMode = ref(false)
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref("")

// 加载当前用户 bio（等 user 就绪后再请求，避免 fetchUser 未完成）
watch(
  user,
  async (u) => {
    if (!u?.id) return
    try {
      const res = await $fetch<{ data: { user: { bio: string } } }>(
        `/api/v1/users/${u.id}/profile`,
      )
      bio.value = res.data.user.bio || ""
    } catch {
      // 静默失败
    }
  },
  { immediate: true },
)

async function handleSave() {
  if (!token.value) return
  saving.value = true
  saveSuccess.value = false
  saveError.value = ""
  try {
    await $fetch("/api/v1/users/me", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token.value}` },
      body: { bio: bio.value },
    })
    saveSuccess.value = true
    setTimeout(() => { saveSuccess.value = false }, 3000)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "保存失败"
    saveError.value = msg
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="max-w-[800px] mx-auto px-4 py-6 sm:px-6 sm:py-8 flex flex-col gap-6">
    <!-- 返回 -->
    <NuxtLink
      v-if="user?.id"
      :to="`/users/${user.id}`"
      class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
    >
      <ArrowLeft :size="16" />
      返回个人主页
    </NuxtLink>

    <!-- 标题 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <Edit3 :size="20" />
          个人资料编辑
        </h1>
      </div>

      <div class="px-6 py-6 flex flex-col gap-6">
        <!-- 基本信息（只读） -->
        <div class="flex items-center gap-3 pb-4 border-b border-border">
          <div class="w-12 h-12 rounded-full bg-primary-bg flex items-center justify-center text-primary text-xl font-bold shrink-0">
            {{ user?.username?.charAt(0).toUpperCase() || "?" }}
          </div>
          <div class="flex flex-col">
            <span class="font-semibold text-text">{{ user?.username }}</span>
            <span class="text-xs text-text-muted">{{ user?.email }}</span>
          </div>
        </div>

        <!-- Bio 编辑区 -->
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <label class="text-sm font-semibold text-text">个人简介</label>
            <button
              class="btn btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
              @click="previewMode = !previewMode"
            >
              <Eye v-if="!previewMode" :size="14" />
              <Edit3 v-else :size="14" />
              {{ previewMode ? "编辑" : "预览" }}
            </button>
          </div>

          <!-- 编辑器 -->
          <textarea
            v-if="!previewMode"
            v-model="bio"
            class="w-full min-h-[200px] px-4 py-3 border border-border rounded-lg text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            placeholder="用 Markdown 介绍自己..."
            maxlength="5000"
          />

          <!-- 预览（Markdown 渲染） -->
          <div
            v-else
            class="min-h-[200px] px-4 py-3 border border-border rounded-lg bg-white"
          >
            <MarkdownRenderer v-if="bio.trim()" :content="bio" />
            <p v-else class="text-text-muted text-sm italic">暂无个人简介</p>
          </div>

          <div class="flex items-center justify-between text-xs text-text-muted">
            <span>支持 Markdown 格式，最多 5000 字</span>
            <span>{{ bio.length }} / 5000</span>
          </div>
        </div>

        <!-- 成功提示 -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-200 ease-in"
          enter-from-class="opacity-0 -translate-y-1"
          leave-to-class="opacity-0 -translate-y-1"
        >
          <div
            v-if="saveSuccess"
            class="flex items-center gap-2 px-3.5 py-2.5 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm"
          >
            <CheckCircle :size="16" />
            <span>保存成功</span>
          </div>
        </Transition>

        <!-- 错误提示 -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-200 ease-in"
          enter-from-class="opacity-0 -translate-y-1"
          leave-to-class="opacity-0 -translate-y-1"
        >
          <div
            v-if="saveError"
            class="flex items-center gap-2 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
          >
            <AlertCircle :size="16" />
            <span>{{ saveError }}</span>
          </div>
        </Transition>

        <!-- 保存按钮 -->
        <button
          class="btn btn-primary flex items-center justify-center gap-2 py-2.5 px-6 self-start text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="saving"
          @click="handleSave"
        >
          <Save :size="16" />
          <span>{{ saving ? "保存中..." : "保存" }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.btn-ghost {
  color: var(--c-text-secondary);
  border: 1px solid var(--c-border);
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.btn-ghost:hover {
  background: var(--c-bg-hover, #f5f5f5);
  color: var(--c-text);
}
</style>
