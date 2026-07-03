<script setup lang="ts">
import { Mail, MessageSquare, Search, Plus, Loader2 } from "@lucide/vue"
import { useEventSource } from "~/composables/useEventSource"
import { useMessages, type Conversation } from "~/composables/useMessages"

const props = defineProps<{
  activeConversationId?: string
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const { fetchConversations, findOrCreateConversation } = useMessages()

const conversations = ref<Conversation[]>([])
const loading = ref(true)
const currentPage = ref(1)
const totalPages = ref(1)

// 搜索
const searchQuery = ref("")
const searchResults = ref<{ id: string; username: string }[]>([])
const searching = ref(false)
const showResults = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function loadConversations(page = 1) {
  try {
    const result = await fetchConversations(page, 100)
    conversations.value = result.data
    totalPages.value = result.pagination.total_pages
    currentPage.value = result.pagination.page
  } catch {
    // 静默
  } finally {
    loading.value = false
  }
}

// SSE 实时刷新
useEventSource({
  url: "/api/v1/conversations/events",
  onEvent: {
    "message:new": () => loadConversations(currentPage.value),
  },
  fetchFn: () => loadConversations(currentPage.value),
  fallbackIntervalMs: 3000,
})

onMounted(() => { loadConversations() })

// 搜索用户（防抖 300ms）
watch(searchQuery, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (val.trim().length < 2) {
    searchResults.value = []
    showResults.value = false
    return
  }
  searchTimer = setTimeout(async () => {
    searching.value = true
    try {
      const res = await $fetch<{ data: { id: string; username: string }[] }>(
        `/api/v1/users/search?q=${encodeURIComponent(val.trim())}`,
      )
      searchResults.value = res.data
      showResults.value = true
    } catch {
      searchResults.value = []
    } finally {
      searching.value = false
    }
  }, 300)
})

async function startConversation(otherUserId: string) {
  try {
    const result = await findOrCreateConversation(otherUserId)
    showResults.value = false
    searchQuery.value = ""
    emit("select", result.data.id)
  } catch {
    // 静默
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
}
</script>

<template>
  <div class="flex flex-col h-full border-r border-border bg-white relative">
    <!-- 标题 -->
    <div class="flex items-center gap-2 px-5 py-4 border-b border-border">
      <Mail :size="20" class="text-primary" />
      <h2 class="text-base font-bold text-text">私信</h2>
    </div>

    <!-- 搜索框 -->
    <div class="px-4 py-3 border-b border-border">
      <div class="relative">
        <Search :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索用户..."
          class="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-page text-text outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
        />
        <Loader2
          v-if="searching"
          :size="14"
          class="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary animate-spin"
        />
      </div>
    </div>

    <!-- 搜索结果下拉 -->
    <div
      v-if="showResults && searchQuery.trim().length >= 2"
      class="absolute top-[115px] left-3 right-3 z-10 bg-white border border-border rounded-lg shadow-dropdown max-h-60 overflow-y-auto"
    >
      <div v-if="searchResults.length === 0" class="px-4 py-3 text-sm text-text-secondary text-center">
        未找到用户
      </div>
      <button
        v-for="u in searchResults"
        :key="u.id"
        class="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 transition-colors"
        @click="startConversation(u.id)"
      >
        <div
          class="w-7 h-7 rounded-full bg-primary-bg flex items-center justify-center text-primary font-semibold text-[10px] flex-shrink-0"
        >
          {{ u.username.charAt(0).toUpperCase() }}
        </div>
        <span class="text-text">{{ u.username }}</span>
        <Plus :size="14" class="ml-auto text-text-secondary opacity-50" />
      </button>
    </div>

    <!-- 最近联系 -->
    <div class="px-4 pt-3 pb-1 text-xs text-text-secondary font-medium">最近联系</div>

    <!-- 列表 -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
    </div>

    <div
      v-else-if="conversations.length === 0"
      class="flex flex-col items-center justify-center py-12 text-text-secondary text-sm"
    >
      <MessageSquare :size="32" class="mb-2 opacity-40" />
      <p>暂无会话</p>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <button
        v-for="conv in conversations"
        :key="conv.id"
        class="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-gray-50 border-b border-border/50"
        :class="activeConversationId === conv.id ? 'bg-primary-bg/30' : ''"
        @click="emit('select', conv.id)"
      >
        <div
          class="flex-shrink-0 w-9 h-9 rounded-full bg-primary-bg flex items-center justify-center text-primary font-semibold text-xs"
        >
          {{ conv.other_user_name.charAt(0).toUpperCase() }}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-text truncate">{{ conv.other_user_name }}</span>
            <span class="text-[11px] text-text-secondary flex-shrink-0 ml-2">{{ formatTime(conv.last_message_at) }}</span>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <span class="text-xs text-text-secondary truncate">{{ conv.last_message_preview || "暂无消息" }}</span>
            <span
              v-if="conv.unread_count > 0"
              class="flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-error-text rounded-full flex-shrink-0 ml-2"
            >{{ conv.unread_count > 99 ? "99+" : conv.unread_count }}</span>
          </div>
        </div>
      </button>
    </div>
  </div>
</template>
