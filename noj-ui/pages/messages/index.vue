<script setup lang="ts">
import { Send, User, MessageSquare } from "@lucide/vue"
import { useMessages, type ConversationMessage } from "~/composables/useMessages"
import { useAuth } from "~/composables/useAuth"
import { useToast } from "~/composables/useToast"
import { useEventSource } from "~/composables/useEventSource"
import ChatSidebar from "~/components/feature/ChatSidebar.vue"

definePageMeta({
  middleware: "auth",
})

const { user } = useAuth()
const { fetchMessages, sendMessage: apiSend, markRead: apiMarkRead, fetchConversations } = useMessages()
const { toast } = useToast()

// 当前选中的会话
const selectedConversationId = ref<string | null>(null)

// 聊天状态
const messages = ref<ConversationMessage[]>([])
const newMessage = ref("")
const loading = ref(false)
const sending = ref(false)
const currentPage = ref(1)
const totalPages = ref(1)
const loadingMore = ref(false)
const otherUserName = ref("")
const otherUserId = ref("")
const messagesContainer = ref<HTMLElement | null>(null)

/**
 * 从会话列表获取对方用户名。
 */
async function fetchOtherUserName() {
  if (!selectedConversationId.value) return
  try {
    const result = await fetchConversations(1, 100)
    const conv = result.data.find((c) => c.id === selectedConversationId.value)
    if (conv) {
      otherUserName.value = conv.other_user_name
      otherUserId.value = conv.other_user_id
    }
  } catch {
    // 静默
  }
}

// 加载消息
async function loadMessages(page = 1, append = false) {
  if (!selectedConversationId.value) return
  loading.value = true
  try {
    const result = await fetchMessages(selectedConversationId.value, page, 50)
    if (append) {
      messages.value = [...result.data.reverse(), ...messages.value]
    } else {
      messages.value = result.data.reverse()
    }
    totalPages.value = result.pagination.total_pages
    currentPage.value = result.pagination.page
  } catch {
    // 静默
  } finally {
    loading.value = false
  }
}

// 标记已读
async function markAsRead() {
  if (!selectedConversationId.value || messages.value.length === 0) return
  const lastMsg = messages.value[messages.value.length - 1]
  try {
    await apiMarkRead(selectedConversationId.value, lastMsg.id)
  } catch {
    // 静默
  }
}

// 发送消息
async function send() {
  if (!selectedConversationId.value) return
  const content = newMessage.value.trim()
  if (!content || sending.value) return
  sending.value = true
  try {
    const result = await apiSend(selectedConversationId.value, content)
    messages.value.push(result.data)
    newMessage.value = ""
    scrollToBottom()
  } catch {
    toast.error("发送失败")
  } finally {
    sending.value = false
  }
}

// 加载更早消息
async function loadOlder() {
  if (loadingMore.value || currentPage.value >= totalPages.value || !selectedConversationId.value) return
  loadingMore.value = true
  await loadMessages(currentPage.value + 1, true)
  loadingMore.value = false
}

// 滚动到底部
function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// SSE 实时接收新消息
useEventSource({
  url: "/api/v1/conversations/events",
  onEvent: {
    "message:new": (data: unknown) => {
      const evt = data as { conversation_id: string }
      if (evt.conversation_id === selectedConversationId.value) {
        loadMessages()
      }
    },
  },
  fetchFn: () => { if (selectedConversationId.value) loadMessages() },
  fallbackIntervalMs: 3000,
})

// 选中会话时切换聊天
async function onSelect(id: string) {
  if (id === selectedConversationId.value) return
  selectedConversationId.value = id
  otherUserName.value = ""
  otherUserId.value = ""
  messages.value = []
  currentPage.value = 1
  totalPages.value = 1

  await loadMessages()
  if (messages.value.length > 0) {
    await markAsRead()
  }
  await fetchOtherUserName()
  scrollToBottom()
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function isSameDay(iso1: string, iso2: string): boolean {
  return new Date(iso1).toDateString() === new Date(iso2).toDateString()
}
</script>

<template>
  <div class="flex h-[calc(100vh-4rem)] max-w-[1000px] mx-auto">
    <!-- 左侧会话列表 -->
    <div class="w-[280px] flex-shrink-0">
      <ChatSidebar :active-conversation-id="selectedConversationId || undefined" @select="onSelect" />
    </div>

    <!-- 右侧聊天区域 -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 未选中会话 → 占位 -->
      <div v-if="!selectedConversationId" class="flex-1 flex items-center justify-center bg-page">
        <div class="flex flex-col items-center text-text-secondary">
          <MessageSquare :size="48" class="mb-4 opacity-30" />
          <p class="text-lg">选择一个会话</p>
          <p class="text-sm mt-1">从左侧列表选择或搜索用户开始私信</p>
        </div>
      </div>

      <!-- 已选中会话 -->
      <template v-else>
        <!-- 顶部栏 -->
        <div class="flex items-center gap-3 px-5 py-3 border-b border-border bg-white">
          <div
            class="w-8 h-8 rounded-full bg-primary-bg flex items-center justify-center text-primary font-semibold text-xs flex-shrink-0"
          >
            {{ (otherUserName || "?").charAt(0).toUpperCase() }}
          </div>
          <NuxtLink
            v-if="otherUserId"
            :to="`/users/${otherUserId}`"
            class="text-sm font-semibold text-text hover:text-primary no-underline"
          >
            {{ otherUserName || "加载中..." }}
          </NuxtLink>
          <span v-else class="text-sm font-semibold text-text">{{ otherUserName || "加载中..." }}</span>
        </div>

        <!-- 消息列表 -->
        <div ref="messagesContainer" class="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-page">
          <!-- 加载更多 -->
          <div v-if="currentPage < totalPages" class="text-center">
            <button class="text-xs text-primary hover:underline" :disabled="loadingMore" @click="loadOlder">
              {{ loadingMore ? "加载中..." : "加载更早消息" }}
            </button>
          </div>

          <!-- 空状态（无数据） -->
          <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-10 text-text-secondary">
            <User :size="36" class="opacity-40 mb-2" />
            <p class="text-sm">{{ loading ? "加载中..." : "暂无消息，发送第一条消息吧" }}</p>
          </div>

          <!-- 消息气泡 -->
          <template v-else>
            <div v-for="(msg, idx) in messages" :key="msg.id">
              <div
                v-if="idx === 0 || !isSameDay(msg.created_at, messages[idx - 1].created_at)"
                class="text-center text-[11px] text-text-secondary mb-3 mt-2"
              >
                {{ formatDate(msg.created_at) }}
              </div>
              <div class="flex gap-2" :class="msg.sender_id === user?.id ? 'flex-row-reverse' : ''">
                <div
                  class="w-7 h-7 rounded-full bg-primary-bg flex items-center justify-center text-primary font-semibold text-[10px] flex-shrink-0 mt-0.5"
                >
                  {{ msg.sender_id === user?.id ? (user?.username?.charAt(0).toUpperCase() || "我") : (otherUserName?.charAt(0).toUpperCase() || "?") }}
                </div>
                <div class="max-w-[65%]">
                  <div
                    class="px-3 py-2 rounded-lg text-sm leading-relaxed break-words"
                    :class="msg.sender_id === user?.id
                      ? 'bg-primary text-white rounded-br-sm'
                      : 'bg-white text-text border border-border rounded-bl-sm'"
                  >
                    {{ msg.content }}
                  </div>
                  <div
                    class="text-[10px] text-text-secondary mt-0.5 px-1"
                    :class="msg.sender_id === user?.id ? 'text-right' : 'text-left'"
                  >
                    {{ formatTime(msg.created_at) }}
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 输入区域 -->
        <div class="px-5 py-3 border-t border-border bg-white">
          <div class="flex items-center gap-2">
            <input
              v-model="newMessage"
              type="text"
              placeholder="输入消息..."
              class="flex-1 px-4 py-2 rounded-lg border border-border bg-page text-text text-sm outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
              @keydown.enter="send"
            />
            <button
              class="flex items-center justify-center w-9 h-9 rounded-full bg-primary text-white transition-opacity disabled:opacity-40"
              :disabled="!newMessage.trim() || sending"
              @click="send"
            >
              <Send :size="16" />
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
