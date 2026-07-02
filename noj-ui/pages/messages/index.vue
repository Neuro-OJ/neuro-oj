<script setup lang="ts">
import { Mail, MessageSquare, ChevronRight } from "@lucide/vue"
import { useEventSource } from "~/composables/useEventSource"
import { useMessages, type Conversation } from "~/composables/useMessages"

definePageMeta({
  middleware: "auth",
})

const { fetchConversations } = useMessages()

const conversations = ref<Conversation[]>([])
const loading = ref(true)
const totalPages = ref(1)
const currentPage = ref(1)

async function loadConversations(page = 1) {
  try {
    const result = await fetchConversations(page, 20)
    conversations.value = result.data
    totalPages.value = result.pagination.total_pages
    currentPage.value = result.pagination.page
  } catch {
    // 静默
  } finally {
    loading.value = false
  }
}

// SSE 实时刷新：收到新消息通知时刷新列表
useEventSource({
  url: "/api/v1/conversations/events",
  onEvent: {
    "message:new": () => {
      loadConversations(currentPage.value)
    },
  },
  fetchFn: () => loadConversations(currentPage.value),
  fallbackIntervalMs: 3000,
})

onMounted(() => {
  loadConversations()
})

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`

  return d.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-8">
    <div class="flex items-center gap-3 mb-6">
      <Mail :size="24" class="text-primary" />
      <h1 class="text-2xl font-bold text-text">私信</h1>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
    </div>

    <!-- 空状态 -->
    <div
      v-else-if="conversations.length === 0"
      class="flex flex-col items-center justify-center py-20 text-text-secondary"
    >
      <MessageSquare :size="48" class="mb-4 opacity-40" />
      <p class="text-lg">暂无会话</p>
      <p class="text-sm mt-1">浏览用户主页可以发送私信</p>
    </div>

    <!-- 会话列表 -->
    <div v-else class="space-y-1">
      <NuxtLink
        v-for="conv in conversations"
        :key="conv.id"
        :to="`/messages/${conv.id}`"
        class="flex items-center gap-4 px-4 py-3 rounded-lg transition-colors hover:bg-primary-hover-bg group"
      >
        <!-- 头像占位 -->
        <div
          class="flex-shrink-0 w-10 h-10 rounded-full bg-primary-bg flex items-center justify-center text-primary font-semibold text-sm"
        >
          {{ conv.other_user_name.charAt(0).toUpperCase() }}
        </div>

        <!-- 内容 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <span class="font-medium text-text truncate">{{ conv.other_user_name }}</span>
            <span class="text-xs text-text-secondary flex-shrink-0 ml-2">
              {{ formatTime(conv.last_message_at) }}
            </span>
          </div>
          <div class="flex items-center justify-between mt-0.5">
            <span class="text-sm text-text-secondary truncate">
              {{ conv.last_message_preview || "暂无消息" }}
            </span>
            <div class="flex items-center gap-2 flex-shrink-0 ml-2">
              <span
                v-if="conv.unread_count > 0"
                class="flex items-center justify-center min-w-[20px] h-[20px] px-1.5 text-xs font-bold text-white bg-error-text rounded-full"
              >
                {{ conv.unread_count > 99 ? "99+" : conv.unread_count }}
              </span>
              <ChevronRight
                :size="16"
                class="text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </div>
          </div>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
