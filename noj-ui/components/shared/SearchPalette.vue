<template>
  <Teleport v-if="isOpen" to="body">
    <div
      class="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="全局搜索"
      @click.self="close"
    >
      <div class="w-full max-w-2xl bg-white rounded-xl shadow-modal border border-border overflow-hidden">
        <!-- 输入框 -->
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search :size="18" class="text-text-muted shrink-0" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            :placeholder="placeholder"
            class="flex-1 outline-none bg-transparent text-base placeholder:text-text-muted"
            autocomplete="off"
            spellcheck="false"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="confirmSelection"
            @keydown.esc.prevent="close"
          />
          <Loader2 v-if="loading" :size="16" class="text-text-muted animate-spin shrink-0" />
          <kbd class="hidden sm:inline-block text-xs text-text-muted border border-border px-1.5 py-0.5 rounded">esc</kbd>
        </div>

        <!-- 结果区 -->
        <div class="max-h-[60vh] overflow-y-auto">
          <!-- 题目组 -->
          <div v-if="problemResults.length > 0">
            <div class="px-4 pt-3 pb-1 text-xs text-text-muted uppercase tracking-wide">题目</div>
            <button
              v-for="(item, i) in problemResults"
              :key="item.id"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
              :class="i === selectedIndex ? 'bg-primary-bg' : 'hover:bg-gray-50'"
              @click="goToProblem(item)"
              @mouseenter="selectedIndex = i"
            >
              <span class="font-mono text-xs text-primary font-semibold shrink-0">{{ item.display_id }}</span>
              <span class="flex-1 truncate text-sm text-text">{{ item.title }}</span>
              <span class="text-xs text-text-muted shrink-0">{{ item.difficulty }}</span>
            </button>
          </div>

          <!-- 用户组（仅 admin） -->
          <div v-if="userResults.length > 0">
            <div class="px-4 pt-3 pb-1 text-xs text-text-muted uppercase tracking-wide">用户</div>
            <button
              v-for="(item, i) in userResults"
              :key="item.id"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
              :class="(problemResults.length + i) === selectedIndex ? 'bg-primary-bg' : 'hover:bg-gray-50'"
              @click="goToUser(item)"
              @mouseenter="selectedIndex = problemResults.length + i"
            >
              <span class="font-medium text-sm text-text shrink-0">{{ item.username }}</span>
              <span class="flex-1 truncate text-xs text-text-muted">{{ item.email }}</span>
              <span v-if="item.role === 'admin'" class="text-xs px-1.5 py-0.5 bg-warning-text/10 text-warning-text rounded">admin</span>
            </button>
          </div>

          <!-- 空状态 -->
          <div
            v-if="!loading && query.length > 0 && problemResults.length === 0 && userResults.length === 0"
            class="px-4 py-12 text-center text-sm text-text-muted"
          >
            无匹配结果
          </div>

          <!-- 提示 -->
          <div
            v-if="query.length === 0"
            class="px-4 py-12 text-center text-sm text-text-muted"
          >
            输入关键词搜索题目{{ isAdmin ? '或用户' : '' }}
            <div class="mt-2 text-xs text-text-muted">
              <kbd class="border border-border px-1.5 py-0.5 rounded">↑</kbd>
              <kbd class="ml-1 border border-border px-1.5 py-0.5 rounded">↓</kbd>
              选择
              <kbd class="ml-2 border border-border px-1.5 py-0.5 rounded">↵</kbd>
              打开
              <kbd class="ml-2 border border-border px-1.5 py-0.5 rounded">esc</kbd>
              关闭
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Search, Loader2 } from "@lucide/vue"

const { user } = useAuth()
const {
  isOpen,
  close,
  query,
  problemResults,
  userResults,
  loading,
  selectedIndex,
} = useSearchPalette()

const isAdmin = computed(() => user.value?.role === "admin")
const placeholder = computed(() =>
  isAdmin.value ? "搜索题目或用户..." : "搜索题目..."
)

const inputRef = ref<HTMLInputElement | null>(null)

// 打开时聚焦输入框 + 锁定 body 滚动
watch(isOpen, async (open) => {
  if (typeof document === "undefined") return
  if (open) {
    document.body.style.overflow = "hidden"
    await nextTick()
    inputRef.value?.focus()
  } else {
    document.body.style.overflow = ""
  }
})

// 卸载时恢复 body 滚动
onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.body.style.overflow = ""
  }
})

const totalItems = computed(() => problemResults.value.length + userResults.value.length)

function moveSelection(delta: number) {
  if (totalItems.value === 0) return
  const next = selectedIndex.value + delta
  if (next < 0) {
    selectedIndex.value = totalItems.value - 1
  } else if (next >= totalItems.value) {
    selectedIndex.value = 0
  } else {
    selectedIndex.value = next
  }
}

function confirmSelection() {
  if (totalItems.value === 0) return
  if (selectedIndex.value < problemResults.value.length) {
    goToProblem(problemResults.value[selectedIndex.value])
  } else {
    goToUser(userResults.value[selectedIndex.value - problemResults.value.length])
  }
}

function goToProblem(item: { id: string }) {
  close()
  navigateTo(`/problems/${item.id}`)
}

function goToUser(item: { username: string }) {
  close()
  // 用户主页 URL 是 /users/<id>/profile，但搜索结果只带 username——走全页搜索跳转
  navigateTo({
    path: "/search",
    query: { q: item.username, type: "user" },
  })
}

// 输入变化时重置选中索引
watch(query, () => {
  selectedIndex.value = 0
})
</script>