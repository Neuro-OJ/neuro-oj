<script setup lang="ts">
import { useMessages, type ConversationMessage, REACTION_EMOJIS } from "~/composables/useMessages"
import { useAuth } from "~/composables/useAuth"
import { useToast } from "~/composables/useToast"
import { useEventSource } from "~/composables/useEventSource"
import { extractApiError } from "~/utils/apiError"
import { userUrl } from "~/utils/publicIdentifiers"
import ChatSidebar from "~/components/feature/ChatSidebar.vue"
import { useReportModal } from "~/composables/useReportModal"

definePageMeta({
  middleware: "auth",
  ssr: false,
})

const { user } = useAuth()
const { fetchMessages, sendMessage: apiSend, sendImage: apiSendImage, addReaction: apiAddReaction, removeReaction: apiRemoveReaction, markRead: apiMarkRead, fetchConversations, editMessage: apiEditMessage, recallMessage: apiRecallMessage, deleteMessage: apiDeleteMessage, setRemark: apiSetRemark, setMuted: apiSetMuted, clearMessages: apiClearMessages } = useMessages()
const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()
const { open: openReportModal } = useReportModal()

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
const otherRemark = ref<string | null>(null)
const otherMuted = ref(false)
const otherUserAvatarUrl = ref<string | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
// 浮岛（输入区域）引用与高度：用于动态抬高消息列表底部留白和头像粘底位置
const islandRef = ref<HTMLElement | null>(null)
const islandHeight = ref(0)
// 输入框 textarea 引用：自动换行增高
const messageInputRef = ref<HTMLTextAreaElement | null>(null)
// ChatSidebar 暴露 refresh()，用于发送/已读后主动刷新会话列表
const sidebarRef = ref<{ refresh: () => Promise<void> } | null>(null)
// 私信功能关闭后停止本页 SSE/轮询，避免重复请求
const messagingEnabled = ref(true)
// NOJ-211：会话快速切换/SSE 并发时丢弃过期响应。
let messageRequestVersion = 0

// ── issue #360：引用回复 / 转发 / 图片 / 状态 ──────────────────
// 引用回复：当前待回复的消息
const replyTo = ref<ConversationMessage | null>(null)
// 转发：当前待转发的消息
const forwardTarget = ref<ConversationMessage | null>(null)
// 转发会话选择器
const showForwardPicker = ref(false)
const forwardConversations = ref<Awaited<ReturnType<typeof fetchConversations>>["data"]>([])
const forwarding = ref(false)
// 二次确认：待转发的目标会话
const confirmTarget = ref<Awaited<ReturnType<typeof fetchConversations>>["data"][number] | null>(null)
const showForwardConfirm = ref(false)
// 跳转高亮：点击引用框跳转到的原消息 id
const highlightedMessageId = ref<string | null>(null)
// 编辑弹窗：待编辑的消息与内容
const editingMessage = ref<ConversationMessage | null>(null)
const editingContent = ref("")
const showEditModal = ref(false)
const editingSaving = ref(false)
// 图片选择
const imageInput = ref<HTMLInputElement | null>(null)
const imageUploading = ref(false)
// Reaction 快捷选择：当前展开的消息 id（点击切换，null 收起）
const showReactionPicker = ref<string | null>(null)
// Reaction 弹层 fixed 定位（避免被气泡 overflow-hidden 裁剪）
const reactionPickerStyle = ref<{ top: string; left: string } | null>(null)
// 图片原始尺寸缓存（用于按比例显示 / 超长超宽裁剪判断）
const imageNaturalSizes = ref<Record<string, { w: number; h: number }>>({})
// 本地发送中的消息（临时 id，服务端确认后替换）
const pendingMessages = ref<{ tempId: string; content: string; type: "text" | "image"; image_url: string | null; created_at: string; reply_to: ConversationMessage["reply_to"]; forwarded_from_user: ConversationMessage["forwarded_from_user"] }[]>([])

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
      otherRemark.value = conv.remark_name ?? null
      otherMuted.value = conv.is_muted
      otherUserAvatarUrl.value = conv.other_user_avatar_url ?? null
    }
  } catch {
    // 静默
  }
}

// 顶部栏/侧栏显示的对方名称（备注名优先）
const otherDisplayName = computed(() => otherRemark.value || otherUserName.value)

// 加载消息
async function loadMessages(page = 1, append = false) {
  if (!selectedConversationId.value) return
  const requestVersion = ++messageRequestVersion
  loading.value = true
  try {
    const result = await fetchMessages(selectedConversationId.value, page, 50)
    if (requestVersion !== messageRequestVersion) return
    if (append) {
      messages.value = [...result.data.reverse(), ...messages.value]
    } else {
      messages.value = result.data.reverse()
    }
    totalPages.value = result.pagination.total_pages
    currentPage.value = result.pagination.page
    // 消息列表更新后重新计算头像对齐
    nextTick(() => {
      measureIslandHeight()
      updateAvatarAlignment()
    })
  } catch (e) {
    const info = extractApiError(e)
    if (info.code === 'FEATURE_DISABLED') {
      messagingEnabled.value = false
    }
    // 静默
  } finally {
    if (requestVersion === messageRequestVersion) loading.value = false
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

// 发送文本消息
async function send() {
  if (!selectedConversationId.value) return
  const content = newMessage.value.trim()
  if (!content || sending.value) return
  sending.value = true
  const tempId = crypto.randomUUID()
  const replySnapshot = replyTo.value
  try {
    // 本地乐观展示（发送中状态）
    pendingMessages.value.push({
      tempId,
      content,
      type: "text",
      image_url: null,
      created_at: new Date().toISOString(),
      reply_to: replySnapshot
        ? {
          message_id: replySnapshot.id,
          sender_id: replySnapshot.sender_id,
          sender_name: replySnapshot.sender_id === user.value?.id ? (user.value?.username ?? "我") : otherUserName.value,
          content: replySnapshot.content,
          type: replySnapshot.type,
        }
        : null,
      forwarded_from_user: null,
    })
    scrollToBottom()
    const result = await apiSend(selectedConversationId.value, content, {
      reply_to_message_id: replySnapshot?.id,
    })
    // 服务端确认：移除本地临时消息，追加真实消息（按 id 去重，避免 SSE 已拉取导致重复）
    pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId)
    // 消息已发送成功，无论是否切换会话都清空输入与引用状态（避免残留误以为失败）
    newMessage.value = ""
    replyTo.value = null
    // 发送期间可能切换了会话，丢弃过期响应（复用 messageRequestVersion 机制）
    if (selectedConversationId.value !== result.data.conversation_id) return
    if (!messages.value.some((m) => m.id === result.data.id)) {
      // POST 响应不含 reactions/read/reply_to/forwarded_from_user 等展示字段，补默认值；
      // reply_to 用发送时的引用快照构造，避免引用块视觉跳动
      messages.value.push({
        ...result.data,
        reactions: [],
        read: false,
        reply_to: replySnapshot
          ? {
            message_id: replySnapshot.id,
            sender_id: replySnapshot.sender_id,
            sender_name: replySnapshot.sender_id === user.value?.id ? (user.value?.username ?? "我") : otherUserName.value,
            content: replySnapshot.content,
            type: replySnapshot.type,
          }
          : null,
        forwarded_from_user: null,
      })
    }
    scrollToBottom()
    // 发送成功后立即刷新左侧会话列表（预览/排序/未读）
    await sidebarRef.value?.refresh()
  } catch (e) {
    pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId)
    toast.error(extractApiError(e).message)
  } finally {
    sending.value = false
  }
}

// 发送图片消息
async function onImageSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file || !selectedConversationId.value) return
  if (imageUploading.value) return
  imageUploading.value = true
  const tempId = crypto.randomUUID()
  const replySnapshot = replyTo.value
  const objectUrl = URL.createObjectURL(file)
  try {
    pendingMessages.value.push({
      tempId,
      content: "",
      type: "image",
      image_url: objectUrl,
      created_at: new Date().toISOString(),
      reply_to: replySnapshot
        ? {
          message_id: replySnapshot.id,
          sender_id: replySnapshot.sender_id,
          sender_name: replySnapshot.sender_id === user.value?.id ? (user.value?.username ?? "我") : otherUserName.value,
          content: replySnapshot.content,
          type: replySnapshot.type,
        }
        : null,
      forwarded_from_user: null,
    })
    scrollToBottom()
    const result = await apiSendImage(selectedConversationId.value, file, {
      reply_to_message_id: replySnapshot?.id,
    })
    pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId)
    // 消息已发送成功，无论是否切换会话都清空引用状态（避免残留误以为失败）
    replyTo.value = null
    // 发送期间可能切换了会话，丢弃过期响应
    if (selectedConversationId.value !== result.data.conversation_id) return
    if (!messages.value.some((m) => m.id === result.data.id)) {
      // POST 响应不含 reactions/read/reply_to/forwarded_from_user 等展示字段，补默认值；
      // reply_to 用发送时的引用快照构造，避免引用块视觉跳动
      messages.value.push({
        ...result.data,
        reactions: [],
        read: false,
        reply_to: replySnapshot
          ? {
            message_id: replySnapshot.id,
            sender_id: replySnapshot.sender_id,
            sender_name: replySnapshot.sender_id === user.value?.id ? (user.value?.username ?? "我") : otherUserName.value,
            content: replySnapshot.content,
            type: replySnapshot.type,
          }
          : null,
        forwarded_from_user: null,
      })
    }
    scrollToBottom()
    await sidebarRef.value?.refresh()
  } catch (e) {
    pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId)
    toast.error(extractApiError(e).message)
  } finally {
    // 释放本地预览 blob URL，避免内存泄漏
    URL.revokeObjectURL(objectUrl)
    imageUploading.value = false
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

// 跳转到指定消息并高亮（点击引用框）
async function jumpToMessage(messageId: string) {
  // 若消息已在列表中，直接滚动定位
  if (messages.value.some((m) => m.id === messageId)) {
    scrollToMessage(messageId)
    return
  }
  // 否则逐页加载更早消息，直到找到或加载完
  while (currentPage.value < totalPages.value) {
    await loadMessages(currentPage.value + 1, true)
    if (messages.value.some((m) => m.id === messageId)) {
      scrollToMessage(messageId)
      return
    }
  }
}

// 滚动到指定消息并高亮
function scrollToMessage(messageId: string) {
  nextTick(() => {
    const container = messagesContainer.value
    if (!container) return
    const row = container.querySelector<HTMLElement>(`[data-msg-id="${messageId}"]`)
    if (!row) return
    row.scrollIntoView({ block: "center" })
    highlightedMessageId.value = messageId
    // 2 秒后清除高亮
    setTimeout(() => {
      if (highlightedMessageId.value === messageId) highlightedMessageId.value = null
    }, 2000)
  })
}

// 判断消息列表当前是否已接近底部；如果是，收到新消息后应自动滚动露出新消息
function isNearBottom(threshold = 80) {
  const el = messagesContainer.value
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

// SSE 实时接收新消息
useEventSource({
  url: "/api/v1/conversations/events",
  enabled: messagingEnabled,
  onEvent: {
    "message:new": async (data: unknown) => {
      const evt = data as { conversation_id: string }
      if (evt.conversation_id === selectedConversationId.value) {
        const shouldAutoScroll = isNearBottom()
        await loadMessages()
        if (shouldAutoScroll) scrollToBottom()
        // 正在查看的会话收到新消息后立即已读，避免红点堆积
        await markAsRead()
        await sidebarRef.value?.refresh()
      }
    },
    "message:edited": async (data: unknown) => {
      const evt = data as { conversation_id: string }
      // 编辑/撤回会改变侧栏预览（[已撤回]），无条件刷新侧栏
      await sidebarRef.value?.refresh()
      if (evt.conversation_id === selectedConversationId.value) {
        await loadMessages()
      }
    },
    "message:recalled": async (data: unknown) => {
      const evt = data as { conversation_id: string }
      // 撤回立即刷新侧栏预览（[已撤回]）
      await sidebarRef.value?.refresh()
      if (evt.conversation_id === selectedConversationId.value) {
        await loadMessages()
      }
    },
    "message:read": async (data: unknown) => {
      const evt = data as { conversation_id: string }
      // 对方已读：当前会话打开时重新拉取，即时更新"已读"状态
      if (evt.conversation_id === selectedConversationId.value) {
        await loadMessages()
      }
    },
    "message:reaction": async (data: unknown) => {
      const evt = data as { conversation_id: string }
      // 对方添加/移除 reaction：当前会话打开时重新拉取，即时更新 reaction 头像与计数
      if (evt.conversation_id === selectedConversationId.value) {
        await loadMessages()
      }
    },
    "feature:disabled": () => {
      messagingEnabled.value = false
    },
  },
  fetchFn: async () => {
    if (!selectedConversationId.value) return
    const shouldAutoScroll = isNearBottom()
    await loadMessages()
    if (shouldAutoScroll) scrollToBottom()
  },
  fallbackIntervalMs: 3000,
})

// 选中会话时切换聊天
async function onSelect(id: string) {
  if (id === selectedConversationId.value) return
  selectedConversationId.value = id
  otherUserName.value = ""
  otherUserId.value = ""
  messages.value = []
  pendingMessages.value = []
  replyTo.value = null
  // 切换会话时重置转发状态，避免跨会话残留
  forwardTarget.value = null
  showForwardPicker.value = false
  showReactionPicker.value = null
  reactionPickerStyle.value = null
  currentPage.value = 1
  totalPages.value = 1
  messageRequestVersion++

  await loadMessages()
  if (messages.value.length > 0) {
    await markAsRead()
    // 已读后立即刷新侧栏未读红点
    await sidebarRef.value?.refresh()
  }
  await fetchOtherUserName()
  scrollToBottom()
}

// 返回默认界面（未选中会话），并刷新侧栏
async function goBack() {
  selectedConversationId.value = null
  otherUserName.value = ""
  otherUserId.value = ""
  otherUserAvatarUrl.value = null
  messages.value = []
  pendingMessages.value = []
  replyTo.value = null
  forwardTarget.value = null
  showForwardPicker.value = false
  showForwardConfirm.value = false
  confirmTarget.value = null
  showReactionPicker.value = null
  reactionPickerStyle.value = null
  currentPage.value = 1
  totalPages.value = 1
  messageRequestVersion++
  await sidebarRef.value?.refresh()
}

// ── issue #360：操作菜单 / Reaction / 转发 ────────────────────

// 引用回复：设置待回复消息
function startReply(msg: ConversationMessage) {
  replyTo.value = msg
}

// 取消引用回复
function cancelReply() {
  replyTo.value = null
}

// 切换 Reaction（已点则取消，未点则添加）
async function toggleReaction(msg: ConversationMessage, emoji: string) {
  if (!selectedConversationId.value) return
  const existing = msg.reactions.find((r) => r.emoji === emoji)
  const me = {
    id: user.value?.id ?? "",
    username: user.value?.username ?? "我",
    avatar_url: user.value?.avatar_url ?? null,
  }
  try {
    if (existing?.reacted_by_me) {
      await apiRemoveReaction(selectedConversationId.value, msg.id, emoji)
    } else {
      await apiAddReaction(selectedConversationId.value, msg.id, emoji)
    }
    // 局部更新 reactions，避免全量重拉重置滚动位置
    const list = msg.reactions.filter((r) => r.emoji !== emoji)
    if (!existing?.reacted_by_me) {
      list.push({
        emoji,
        count: (existing?.count ?? 0) + 1,
        reacted_by_me: true,
        users: existing ? [...existing.users, me] : [me],
      })
    } else if (existing.count > 1) {
      list.push({
        emoji,
        count: existing.count - 1,
        reacted_by_me: false,
        users: existing.users.filter((u) => u.id !== user.value?.id),
      })
    }
    msg.reactions = list.sort((a, b) => b.count - a.count)
    // 选择后关闭弹层，允许继续添加其他 emoji 的 reaction
    closeReactionPicker()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 记录图片原始尺寸（用于按比例显示 / 超长超宽裁剪判断）
function onImageLoaded(msgId: string, e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    imageNaturalSizes.value[msgId] = { w: img.naturalWidth, h: img.naturalHeight }
  }
}

/**
 * 图片显示样式：
 * - 正常比例（宽高比 0.25~4，含正方形、16:9、9:16、小图）：按比例完整显示（object-contain），
 *   宽度/高度自适应，上限 280x320，绝不裁剪
 * - 超长（ratio < 0.25）：固定竖屏比例 200x280，object-cover 裁去上下边
 * - 超宽（ratio > 4）：固定横屏比例 280x200，object-cover 裁去左右边
 */
function imageStyle(msgId: string) {
  const size = imageNaturalSizes.value[msgId]
  if (!size || size.w <= 0 || size.h <= 0) {
    // 尺寸未知时按比例完整显示
    return { style: { maxWidth: "280px", maxHeight: "320px" } as Record<string, string>, cover: false }
  }
  const ratio = size.w / size.h
  if (ratio >= 0.25 && ratio <= 4) {
    // 正常比例（含正方形、小图）：完整显示，宽度最高 280、高度最高 320，按比例缩放（object-contain 不裁剪）
    const w = size.w >= size.h ? 280 : Math.round(280 * ratio)
    const h = size.w >= size.h ? Math.round(280 / ratio) : 280
    // 竖图/方图高度可能超上限，按高度反算宽度（保持比例、完整显示）
    const finalH = Math.min(h, 320)
    const finalW = finalH < h ? Math.round(finalH * ratio) : w
    return {
      style: {
        width: `${Math.min(finalW, 280)}px`,
        height: `${finalH}px`,
        maxWidth: "280px",
        maxHeight: "320px",
      } as Record<string, string>,
      cover: false,
    }
  }
  // 超长（ratio < 0.25）：固定竖屏比例 200x280，裁去上下边
  if (ratio < 0.25) {
    return { style: { width: "200px", height: "280px" } as Record<string, string>, cover: true }
  }
  // 超宽（ratio > 4）：固定横屏比例 280x200，裁去左右边
  return { style: { width: "280px", height: "200px" } as Record<string, string>, cover: true }
}

// 图片消息的实际显示宽度（px）：与 imageStyle 计算一致，供底部行对齐（reaction 区不超出图片宽度）
function imageDisplayWidth(msgId: string): number {
  const size = imageNaturalSizes.value[msgId]
  if (!size || size.w <= 0 || size.h <= 0) return 280
  const ratio = size.w / size.h
  if (ratio < 0.25) return 200 // 超长：固定 200 宽
  if (ratio > 4) return 280 // 超宽：固定 280 宽
  // 正常比例：宽度 = min(按比例算出的宽, 280)；竖图高度超 320 时按高度反算
  const w = size.w >= size.h ? 280 : Math.round(280 * ratio)
  const h = size.w >= size.h ? Math.round(280 / ratio) : 280
  const finalH = Math.min(h, 320)
  return Math.min(finalH < h ? Math.round(finalH * ratio) : w, 280)
}

// 打开 Reaction 快捷选择：fixed 定位到按钮右侧，避免被气泡 overflow-hidden 裁剪
function openReactionPicker(msgId: string, e: MouseEvent) {
  // 阻止冒泡，避免全局 click 监听立即关闭
  e.stopPropagation()
  if (showReactionPicker.value === msgId) {
    closeReactionPicker()
    return
  }
  const btn = (e.currentTarget as HTMLElement)
  const rect = btn.getBoundingClientRect()
  // 弹层宽 160px；left 定位使右缘与按钮右缘精确对齐（按钮在图片半透明长条内右侧，右缘一致）
  showReactionPicker.value = msgId
  reactionPickerStyle.value = {
    top: `${rect.top - 40}px`,
    left: `${rect.right - 160}px`,
  }
}

// 打开转发选择器
async function openForwardPicker(msg: ConversationMessage) {
  forwardTarget.value = msg
  showForwardPicker.value = true
  try {
    const result = await fetchConversations(1, 100)
    // 保留当前聊天联系人（转发到当前会话也允许）
    forwardConversations.value = result.data
  } catch {
    forwardConversations.value = []
  }
}

// 点击联系人 → 打开二次确认弹窗
function openForwardConfirm(conv: Awaited<ReturnType<typeof fetchConversations>>["data"][number]) {
  confirmTarget.value = conv
  showForwardConfirm.value = true
}

// 信息功能区"更多"下拉菜单项
function moreMenuItems(msg: ConversationMessage) {
  const isMine = msg.sender_id === user.value?.id
  const isText = msg.type === "text"
  const now = Date.now()
  const elapsed = now - new Date(msg.created_at).getTime()
  const canRecall = isMine && !msg.recalled_at && elapsed <= 2 * 60 * 1000
  const canEdit = isMine && isText && !msg.recalled_at && elapsed <= 5 * 60 * 1000
  const items: { label: string; icon: string; onSelect: () => void }[] = []
  // 不可用项直接不显示（撤回/编辑超时或非本方消息）
  if (canRecall) {
    items.push({ label: "撤回", icon: "i-lucide-undo-2", onSelect: () => recallMessage(msg) })
  }
  if (canEdit) {
    items.push({ label: "编辑", icon: "i-lucide-pencil", onSelect: () => openEditModal(msg) })
  }
  items.push({ label: "复制", icon: "i-lucide-copy", onSelect: () => copyMessage(msg) })
  items.push({ label: "删除", icon: "i-lucide-trash-2", onSelect: () => removeMessage(msg) })
  items.push({ label: "转发", icon: "i-lucide-forward", onSelect: () => openForwardPicker(msg) })
  // 与社区一致：不能举报自己发送的内容
  if (!isMine) {
    items.push({ label: "举报", icon: "i-lucide-flag", onSelect: () => reportMessage(msg) })
  }
  return items
}

// 举报私信消息（复用社区举报弹窗与 /community/reports API）
async function reportMessage(msg: ConversationMessage) {
  const result = await openReportModal()
  if (!result) return
  try {
    await api.post("/api/v1/community/reports", {
      message_id: msg.id,
      category: result.category,
      reason: result.reason,
    })
    toast.success("举报已提交，感谢反馈")
  } catch {
    // useApi 已弹后端错误（如重复举报）
  }
}

// 顶部栏更多菜单：编辑备注 / 清空记录 / 免打扰 / 举报
const conversationMenuItems = computed(() => [
  { label: "编辑备注", icon: "i-lucide-user-pen", onSelect: () => openRemarkModal() },
  { label: "清空聊天记录", icon: "i-lucide-trash-2", onSelect: () => clearChatHistory() },
  { label: otherMuted.value ? "取消消息免打扰" : "消息免打扰", icon: otherMuted.value ? "i-lucide-bell-ring" : "i-lucide-bell-off", onSelect: () => toggleMute() },
  { label: "举报", icon: "i-lucide-flag", onSelect: () => openReportConversation() },
])

// 编辑备注弹窗状态
const showRemarkModal = ref(false)
const remarkInput = ref("")

function openRemarkModal() {
  remarkInput.value = otherRemark.value ?? ""
  showRemarkModal.value = true
}

// 保存备注
async function saveRemark() {
  if (!selectedConversationId.value) return
  try {
    const res = await apiSetRemark(selectedConversationId.value, remarkInput.value.trim())
    otherRemark.value = res.data.remark_name
    showRemarkModal.value = false
    toast.success(otherRemark.value ? "备注已保存" : "备注已清除")
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 清空聊天记录（仅对自己隐藏）
async function clearChatHistory() {
  if (!selectedConversationId.value) return
  // 二次确认：清空仅对自己隐藏，不可恢复
  const ok = await dialog.confirm(
    `确定清空与 ${otherDisplayName.value} 的聊天记录吗？此操作仅对你可见，不可恢复。`,
    { title: "清空聊天记录", confirmText: "清空", danger: true },
  )
  if (!ok) return
  try {
    await apiClearMessages(selectedConversationId.value)
    messages.value = []
    toast.success("聊天记录已清空")
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 切换消息免打扰
async function toggleMute() {
  if (!selectedConversationId.value) return
  try {
    const next = !otherMuted.value
    await apiSetMuted(selectedConversationId.value, next)
    otherMuted.value = next
    toast.success(next ? "已开启消息免打扰" : "已关闭消息免打扰")
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 顶部栏举报：举报当前会话对方（取最近一条对方消息作为举报目标）
async function openReportConversation() {
  const target = [...messages.value].reverse().find((m) => m.sender_id !== user.value?.id)
  if (!target) {
    toast.error("对方还没有发送消息")
    return
  }
  await reportMessage(target)
}

// 撤回消息
async function recallMessage(msg: ConversationMessage) {
  if (!selectedConversationId.value) return
  try {
    await apiRecallMessage(selectedConversationId.value, msg.id)
    msg.recalled_at = new Date().toISOString()
    toast.success("已撤回")
    // 自己撤回不触发 SSE（SSE 只推给对方），需本地刷新侧栏预览（[已撤回]）
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 打开编辑弹窗
function openEditModal(msg: ConversationMessage) {
  editingMessage.value = msg
  editingContent.value = msg.content
  showEditModal.value = true
}

// 提交编辑
async function submitEdit() {
  if (!selectedConversationId.value || !editingMessage.value) return
  const content = editingContent.value.trim()
  if (!content || editingSaving.value) return
  editingSaving.value = true
  try {
    await apiEditMessage(selectedConversationId.value, editingMessage.value.id, content)
    editingMessage.value.content = content
    editingMessage.value.edited_at = new Date().toISOString()
    showEditModal.value = false
    editingMessage.value = null
    toast.success("已编辑")
    // 编辑改变消息内容，刷新侧栏预览
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  } finally {
    editingSaving.value = false
  }
}

// 复制消息内容
// 复制消息内容（异步调用避免被 uBlock ClickFix 拦截点击回调内直接调用 clipboard API）
async function copyMessage(msg: ConversationMessage) {
  const text = msg.type === "image" ? "[图片]" : msg.content
  try {
    // 异步执行，脱离点击事件调用栈（uBlock ClickFix 只拦截同步调用）
    await nextTick()
    try {
      await navigator.clipboard.writeText(text)
      toast.success("已复制")
      return
    } catch {
      // 兜底：隐藏 textarea + execCommand（不受 clipboard 权限限制）
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(ta)
      if (ok) toast.success("已复制")
      else toast.error("复制失败")
    }
  } catch {
    toast.error("复制失败")
  }
}

// 删除消息（仅自己视角）
async function removeMessage(msg: ConversationMessage) {
  if (!selectedConversationId.value) return
  try {
    await apiDeleteMessage(selectedConversationId.value, msg.id)
    messages.value = messages.value.filter((m) => m.id !== msg.id)
    toast.success("已删除")
    // 删除改变会话最后消息，刷新侧栏预览与排序
    await sidebarRef.value?.refresh()
  } catch (e) {
    toast.error(extractApiError(e).message)
  }
}

// 取消发送（仅本地 pending 消息，未送达服务器）
function cancelPending(tempId: string) {
  pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId)
}

// 执行转发到目标会话
async function doForward(targetConvId: string) {
  if (!forwardTarget.value || forwarding.value) return
  forwarding.value = true
  try {
    await apiSend(targetConvId, forwardTarget.value.content, {
      forwarded_from_message_id: forwardTarget.value.id,
    })
    toast.success("已转发")
    showForwardConfirm.value = false
    showForwardPicker.value = false
    confirmTarget.value = null
    forwardTarget.value = null
  } catch (e) {
    toast.error(extractApiError(e).message)
  } finally {
    forwarding.value = false
  }
}

// ── 时间显示优化 ───────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function isSameDay(iso1: string, iso2: string): boolean {
  return new Date(iso1).toDateString() === new Date(iso2).toDateString()
}

// ── 消息分组（气泡圆角 + 头像联动，纯客户端本地计算，不修改原始数据）──
type MessagePosition = "alone" | "groupTop" | "groupMiddle" | "groupBottom"

// 是否可参与分组的"普通纯文本"：回复、转发、图片、系统消息均切断分组
function isGroupableText(msg: ConversationMessage): boolean {
  return msg.type === "text" && !msg.reply_to && !msg.forwarded_from_user
}

// 分组位置标记：遍历消息列表，与上/下一条对比（发送者一致 + 时间差 < 60s + 均为普通纯文本）
const messagePositions = computed<Record<string, MessagePosition>>(() => {
  const positions: Record<string, MessagePosition> = {}
  const list = messages.value
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    const prev = list[i - 1]
    const next = list[i + 1]
    const curGroupable = isGroupableText(cur)
    const sameAsPrev = prev !== undefined
      && curGroupable
      && isGroupableText(prev)
      && cur.sender_id === prev.sender_id
      && Math.abs(new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime()) < 60_000
    const sameAsNext = next !== undefined
      && curGroupable
      && isGroupableText(next)
      && cur.sender_id === next.sender_id
      && Math.abs(new Date(next.created_at).getTime() - new Date(cur.created_at).getTime()) < 60_000
    if (!sameAsPrev && !sameAsNext) positions[cur.id] = "alone"
    else if (!sameAsPrev && sameAsNext) positions[cur.id] = "groupTop"
    else if (sameAsPrev && sameAsNext) positions[cur.id] = "groupMiddle"
    else positions[cur.id] = "groupBottom"
  }
  return positions
})

// 按日期分组（用于日期分隔符 sticky 约束容器）：每个日期段一个包裹 div，日期分隔符只在该段内粘顶
const dateGroups = computed<{ date: string; items: { msg: ConversationMessage; idx: number }[] }[]>(() => {
  const groups: { date: string; items: { msg: ConversationMessage; idx: number }[] }[] = []
  for (let i = 0; i < messages.value.length; i++) {
    const msg = messages.value[i]
    const date = formatDate(msg.created_at)
    const last = groups[groups.length - 1]
    if (last && last.date === date) {
      last.items.push({ msg, idx: i })
    } else {
      groups.push({ date, items: [{ msg, idx: i }] })
    }
  }
  return groups
})

// 气泡圆角：大圆角 R=12px(lg)、小圆角 r=4px(sm)；尾巴角（自己=右下、对方=左下）固定小圆角
// 注意：必须返回完整静态 class 字面量（Tailwind v4 JIT 无法识别动态拼接的 class 名）
// 规则：靠屏幕中间一侧（自己=左上/左下、对方=右上/右下）始终保持大圆角；靠头像一侧的顶部角按分组压小
function bubbleRadiusClass(msg: ConversationMessage): string {
  const pos = messagePositions.value[msg.id] ?? "alone"
  const isMine = msg.sender_id === user.value?.id
  const isTop = pos === "alone" || pos === "groupTop"
  if (isMine) {
    // 自己消息：左上、左下保持大圆角；右下尾巴小圆角；右上按分组压小
    return isTop
      ? "rounded-tl-lg rounded-tr-lg rounded-bl-lg rounded-br-sm"
      : "rounded-tl-lg rounded-tr-sm rounded-bl-lg rounded-br-sm"
  }
  // 对方消息：右上、右下保持大圆角；左下尾巴小圆角；左上按分组压小
  return isTop
    ? "rounded-tl-lg rounded-tr-lg rounded-bl-sm rounded-br-lg"
    : "rounded-tl-sm rounded-tr-lg rounded-bl-sm rounded-br-lg"
}

// 头像显示：alone / groupTop 显示，groupMiddle / groupBottom 隐藏
function showAvatar(msg: ConversationMessage): boolean {
  const pos = messagePositions.value[msg.id] ?? "alone"
  return pos === "alone" || pos === "groupTop"
}

// 头像对齐：三态（贴组底 / 粘窗口底 / 贴组顶），基于整组气泡范围，用 translateY 实现平滑跟随
const avatarOffsets = ref<Record<string, number>>({})
const AVATAR_SIZE = 32 // UserIdentity size="md"

// 计算每个可见头像的垂直偏移（滚动时调用）
function updateAvatarAlignment() {
  const container = messagesContainer.value
  if (!container) return
  const containerRect = container.getBoundingClientRect()
  const next: Record<string, number> = {}
  const rows = container.querySelectorAll<HTMLElement>("[data-msg-id]")
  // 收集每行信息（msgId / position / 气泡 rect / 头像锚点）
  const infos: { msgId: string; position: MessagePosition; bubbleRect: DOMRect; anchor: HTMLElement }[] = []
  for (const row of rows) {
    const msgId = row.dataset.msgId
    if (!msgId) continue
    const anchor = row.querySelector<HTMLElement>(".avatar-anchor")
    const bubble = row.querySelector<HTMLElement>("div.overflow-hidden")
    if (!anchor || !bubble) continue
    infos.push({ msgId, position: messagePositions.value[msgId] ?? "alone", bubbleRect: bubble.getBoundingClientRect(), anchor })
  }
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]
    if (info.anchor.classList.contains("invisible")) continue
    if (info.position !== "alone" && info.position !== "groupTop") continue
    // 组顶 = 当前行气泡顶；组底 = 组尾（groupBottom）气泡底，alone 即自身
    const groupTop = info.bubbleRect.top
    let groupBottom = info.bubbleRect.bottom
    if (info.position === "groupTop") {
      for (let j = i + 1; j < infos.length; j++) {
        if (infos[j].position === "groupMiddle") continue
        if (infos[j].position === "groupBottom") groupBottom = infos[j].bubbleRect.bottom
        break
      }
    }
    const anchorH = info.anchor.getBoundingClientRect().height
    // 头像默认 self-end 对齐 groupTop 行气泡底
    const topBubbleBottom = info.bubbleRect.bottom
    // 浮岛占据窗口底部，头像可见区域底界 = 窗口底 - 浮岛高度 - 约 1/3 头像高度（再抬高一点）
    const visibleBottom = containerRect.bottom - islandHeight.value - AVATAR_SIZE / 3
    if (groupBottom <= visibleBottom) {
      // 组底在浮岛上方（组顶可能已滚出窗口顶部）→ 头像贴组底（气泡右下角，不跟随窗口）
      next[info.msgId] = groupBottom - topBubbleBottom
    } else {
      // 组底滚出浮岛上方 → 头像跟随窗口
      const visibleH = visibleBottom - Math.max(groupTop, containerRect.top)
      if (visibleH > anchorH) {
        // 可见面积 > 头像 → 头像粘浮岛上方
        next[info.msgId] = visibleBottom - topBubbleBottom
      } else {
        // 可见面积 < 头像 → 头像上边对齐气泡上边
        next[info.msgId] = groupTop - topBubbleBottom + anchorH
      }
    }
  }
  avatarOffsets.value = next
}

// 头像垂直偏移样式：translateY 实现三态对齐（贴气泡底 / 粘窗口底 / 贴气泡顶）
function avatarOffsetStyle(msgId: string): Record<string, string> {
  const offset = avatarOffsets.value[msgId] ?? 0
  return { transform: `translateY(${offset}px)` }
}

// 测量浮岛高度（含回复状态条），用于抬高消息列表底部留白与头像粘底位置
function measureIslandHeight() {
  nextTick(() => {
    islandHeight.value = islandRef.value?.offsetHeight ?? 0
    updateAvatarAlignment()
  })
}

// 输入框自动换行增高
function autoResizeInput() {
  const el = messageInputRef.value
  if (!el) return
  // 等 v-model 更新 DOM 后再测量，避免高度计算滞后出现滚动条
  nextTick(() => {
    el.style.height = "auto"
    // +2px 余量避免 scrollHeight 与 clientHeight 的 1px 舍入误差导致滚动条
    el.style.height = `${Math.min(el.scrollHeight + 2, 120)}px`
    measureIslandHeight()
  })
}

// 监听回复状态与输入内容变化，重新测量浮岛高度
watch([replyTo, newMessage], () => {
  measureIslandHeight()
})

// 信息/功能区（时间戳 + hover 按钮）：每个消息都显示
function showInfoBar(_msg: ConversationMessage): boolean {
  return true
}

// 消息垂直间距：同组内（groupMiddle / groupBottom）留小空隙（mt-1），组首/独立消息正常间距（mt-3）
function messageMarginClass(msg: ConversationMessage, idx: number): string {
  if (idx === 0) return ""
  const pos = messagePositions.value[msg.id] ?? "alone"
  return pos === "groupMiddle" || pos === "groupBottom" ? "mt-1" : "mt-3"
}

// 文本内容 padding：所有消息统一（pt-2 顶部留白、pb-0.5 缩小与信息功能区距离）
function textPaddingClass(_msg: ConversationMessage): string {
  return "pt-2 pb-0.5"
}

// 底部行 padding：所有消息统一（pb-1.5 底部留白）
function infoBarPaddingClass(_msg: ConversationMessage): string {
  return "pb-1.5"
}

// 消息状态文案
function messageStatusText(msg: ConversationMessage): string {
  if (msg.read === true) return "已读"
  return "已送达"
}

// reaction 头像配色：与 UserIdentity（聊天气泡旁头像）一致，按 username 哈希稳定配色
function avatarBgColor(username: string): string {
  const name = username ?? ""
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 60% 45%)`
}
function avatarFgColor(username: string): string {
  const name = username ?? ""
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 60% 95%)`
}

// 图片 URL 展示：本地临时消息用 objectURL；服务端消息经图片读取端点（noj-storage:// 无法直接作为 src）
function displayImageUrl(msg: { id: string; image_url: string | null }, conversationId?: string): string {
  if (!msg.image_url) return ""
  if (msg.image_url.startsWith("blob:")) return msg.image_url
  const convId = conversationId ?? selectedConversationId.value
  return `/api/v1/conversations/${convId}/messages/${msg.id}/image`
}

// 关闭 Reaction 弹层
function closeReactionPicker() {
  showReactionPicker.value = null
  reactionPickerStyle.value = null
}

// 点击空白处关闭 Reaction 弹层（挂载后监听全局 click）
const handleDocumentClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (target.closest(".reaction-picker")) return
  if (showReactionPicker.value) closeReactionPicker()
}
onMounted(() => {
  document.addEventListener("click", handleDocumentClick)
  measureIslandHeight()
})
onUnmounted(() => {
  document.removeEventListener("click", handleDocumentClick)
})
</script>

<template>
  <!-- 页面级标题（WCAG 1.3.1）：聊天页无可见 h1，用 sr-only 提供页面语义 -->
  <h1 class="sr-only">私信</h1>
  <div class="flex h-[calc(100vh-4rem)] max-w-[1000px] mx-auto">
    <!-- 左侧会话列表：手机版全屏，选中会话后隐藏；桌面固定 280px 始终显示 -->
    <div class="w-full md:w-[280px] flex-shrink-0" :class="selectedConversationId ? 'hidden md:block' : 'block'">
      <ChatSidebar ref="sidebarRef" :active-conversation-id="selectedConversationId || undefined" @select="onSelect" />
    </div>

    <!-- 右侧聊天区域：手机版未选中会话时隐藏，桌面始终显示 -->
    <div class="relative flex-1 flex flex-col min-w-0" :class="selectedConversationId ? 'flex' : 'hidden md:flex'">
      <!-- 未选中会话 → 占位 -->
      <div v-if="!selectedConversationId" class="flex-1 flex items-center justify-center bg-page">
        <div class="flex flex-col items-center text-text-secondary">
          <UIcon name="i-lucide-message-square" class="mb-4 opacity-30 size-[48px]" />
          <p class="text-lg">选择一个会话</p>
          <p class="text-sm mt-1">从左侧列表选择或搜索用户开始私信</p>
        </div>
      </div>

      <!-- 已选中会话 -->
      <template v-else>
        <!-- 顶部栏 -->
        <div class="flex items-center gap-3 px-5 py-3 border-b border-border bg-white">
          <UButton
            icon="i-lucide-arrow-left"
            color="gray"
            variant="ghost"
            class="flex-shrink-0"
            title="返回"
            @click="goBack"
          />
          <!-- UserIdentity username 必须传真实用户名（头像 URL 与哈希配色按用户名计算）；显示名在下方用 otherDisplayName -->
          <UserIdentity
            v-if="otherUserId"
            :user="{ id: otherUserId, username: otherUserName || '?', avatar_url: otherUserAvatarUrl }"
            size="sm"
            :show-username="false"
            :link="false"
          />
          <NuxtLink
            v-if="otherUserId"
            :to="userUrl(otherUserName || otherUserId)"
            class="text-sm font-semibold text-text hover:text-primary no-underline"
          >
            {{ otherDisplayName || "加载中..." }}
          </NuxtLink>
          <span v-else class="text-sm font-semibold text-text">{{ otherUserName || "加载中..." }}</span>
          <span class="flex-1"></span>
          <!-- 右上角更多：第一项为举报当前会话对方（取最近一条对方消息为举报目标） -->
          <UDropdownMenu
            v-if="otherUserId && otherUserId !== user?.id"
            :items="conversationMenuItems"
            :content="{ side: 'bottom', align: 'end', sideOffset: 4, collisionPadding: 8 }"
          >
            <UButton
              icon="i-lucide-more-horizontal"
              color="gray"
              variant="ghost"
              class="flex-shrink-0"
              title="更多"
            />
          </UDropdownMenu>
        </div>

        <!-- 消息列表：底部留白动态跟随浮岛高度，让消息与悬浮头像不被浮岛遮挡 -->
        <div ref="messagesContainer" class="flex-1 overflow-y-auto px-5 pt-4 bg-page" :style="{ paddingBottom: `${islandHeight + 24}px` }" @scroll="updateAvatarAlignment">
          <!-- 加载更多 -->
          <div v-if="currentPage < totalPages" class="text-center">
            <button class="text-xs text-primary hover:underline" :disabled="loadingMore" @click="loadOlder">
              {{ loadingMore ? "加载中..." : "加载更早消息" }}
            </button>
          </div>

          <!-- 空状态（无数据） -->
          <div v-if="messages.length === 0 && pendingMessages.length === 0" class="flex flex-col items-center justify-center py-10 text-text-secondary">
            <UIcon name="i-lucide-user" class="opacity-40 mb-2 size-[36px]" />
            <p class="text-sm">{{ loading ? "加载中..." : "暂无消息，发送第一条消息吧" }}</p>
          </div>

          <!-- 消息气泡 -->
          <template v-else>
            <!-- 服务端消息 -->
            <template v-for="group in dateGroups" :key="group.date">
              <div>
                <div class="sticky top-0 z-10 flex justify-center mb-3 mt-2">
                  <span class="px-3 py-1 rounded-full bg-black/30 text-white text-11px">
                    {{ group.date }}</span>
                  </div>
                  <template v-for="item in group.items" :key="item.msg.id">
                    <div class="group flex gap-2" :data-msg-id="item.msg.id" :class="[item.msg.sender_id === user?.id ? 'flex-row-reverse' : '', messageMarginClass(item.msg, item.idx), highlightedMessageId === item.msg.id ? 'bg-primary/10 -mx-5 px-5' : '']">
                      <!-- 头像跟随：组完整可见时贴气泡底部；滚动使组部分可见时粘窗口底部；可见范围小于头像时贴气泡顶部（translateY 平滑跟随） -->
                      <div class="avatar-anchor flex-shrink-0 self-end" :class="showAvatar(item.msg) ? '' : 'invisible'" :style="avatarOffsetStyle(item.msg.id)">
                        <UserIdentity                    :user="item.msg.sender_id === user?.id                      ? { id: user?.id ?? '', username: user?.username ?? '我', avatar_url: user?.avatar_url ?? null }                      : { id: otherUserId, username: otherUserName || '?', avatar_url: otherUserAvatarUrl }"                    size="md"                    :show-username="false"                    :link="false"                  />
                      </div>
                      <div class="max-w-[65%]">
                        <!-- 气泡主体：转发标记 / 引用框 / 内容 / Reaction / 时间状态 全在气泡内 -->
                        <div                    class="overflow-hidden"                    :class="[bubbleRadiusClass(item.msg), item.msg.sender_id === user?.id                      ? 'bg-primary text-white'                      : 'bg-white text-text border border-border']"                  >
                          <!-- 转发标记（气泡内顶部，用户名加粗） -->
                          <div                      v-if="item.msg.forwarded_from_user"                      class="px-3 pt-1.5 text-[10px] leading-tight"                      :class="item.msg.sender_id === user?.id ? 'text-white/80' : 'text-text-secondary'"                    >
                            转自 <span class="font-bold" :class="item.msg.sender_id === user?.id ? 'text-white' : 'text-text'">
                            @{{ item.msg.forwarded_from_user.username }}</span>
                          </div>
                          <!-- 引用框（Telegram 风格：圆角卡片 + 左侧竖条 + 发送者加粗；中间色背景：自己消息白透蓝、对方消息浅蓝） -->
                          <div                      v-if="item.msg.reply_to"                      class="mx-2 mt-1.5 px-2.5 py-1.5 rounded-md text-xs leading-snug cursor-pointer"                      :class="item.msg.sender_id === user?.id ? 'bg-white/20 border-l-[3px] border-white/60' : 'bg-primary/5 border-l-[3px] border-primary'"                    @click="jumpToMessage(item.msg.reply_to.message_id)">
                            <span class="font-bold" :class="item.msg.sender_id === user?.id ? 'text-white' : 'text-primary'">
                              {{ item.msg.reply_to.sender_name }}</span>
                              <span class="block truncate" :class="item.msg.sender_id === user?.id ? 'text-white/80' : 'text-text-secondary'">
                                {{ item.msg.reply_to.type === "image" ? "[图片]" : item.msg.reply_to.content }}</span>
                              </div>
                              <!-- 撤回的图片消息：显示系统提示，不展示原图 -->
                              <div v-if="item.msg.recalled_at" class="px-3 text-sm leading-relaxed break-words min-w-[130px] italic opacity-60" :class="textPaddingClass(item.msg)">
                                {{ item.msg.sender_id === user?.id ? "你" : otherUserName }}撤回了一条消息
                              </div>
                              <!-- 图片消息：无底色；正常比例按比例完整显示（object-contain 不裁剪），超长/超宽裁剪铺满；有 reaction 时时间/状态/按钮移到图片下方（与文本消息一致），无 reaction 时用半透明长条 -->
                              <div v-else-if="item.msg.type === 'image'">
                                <div class="relative overflow-hidden">
                                  <img                          :src="displayImageUrl(item.msg)"                          alt="图片消息"                          :class="imageStyle(item.msg.id).cover ? 'object-cover' : 'object-contain bg-black/5'"                          :style="imageStyle(item.msg.id).style"                          @load="onImageLoaded(item.msg.id, $event)"                        />
                                  <!-- 半透明圆形长条：仅在无 reaction 时显示（默认时间+状态，hover 替换为操作按钮） -->
                                  <div                          v-if="item.msg.reactions.length === 0"                          class="absolute bottom-1.5 right-1.5 h-6 rounded-full bg-black/50 backdrop-blur-sm px-2 text-[10px] text-white flex items-center gap-1"                        >
                                    <span class="flex items-center gap-1 group-hover:hidden group-has-[[data-state=open]]:hidden">
                                      <span>
                                        {{ formatTime(item.msg.created_at) }}</span>
                                        <span v-if="item.msg.sender_id === user?.id" class="flex items-center gap-0.5">
                                          <UIcon v-if="item.msg.read === true" name="i-lucide-check-check" class="size-3 text-white/90" />
                                          <UIcon v-else name="i-lucide-check" class="size-3" />
                                        </span>
                                      </span>
                                      <span class="hidden group-hover:flex group-has-[[data-state=open]]:flex items-center gap-1">
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-white/20 transition-colors"                              title="表情反应"                              @click="openReactionPicker(item.msg.id, $event)"                            >
                                          <UIcon name="i-lucide-smile-plus" class="size-3.5" />
                                        </button>
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-white/20 transition-colors"                              title="引用回复"                              @click="startReply(item.msg)"                            >
                                          <UIcon name="i-lucide-corner-up-left" class="size-3.5" />
                                        </button>
<UDropdownMenu :items="moreMenuItems(item.msg)" :content="{ side: 'bottom', align: 'end', sideOffset: 4, collisionPadding: 8 }">
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-white/20 transition-colors"                              title="更多"                            >
                                          <UIcon name="i-lucide-more-horizontal" class="size-3.5" />
                                        </button>
</UDropdownMenu>
</span>
                                    </div>
                                  </div>
                                  <!-- 图片有 reaction 时：底部行宽度 = 图片显示宽度，reaction+信息/功能超过图片宽度才换行；信息/功能区贴底与 reaction 区同高 -->
                                  <template v-if="item.msg.reactions.length >
                                    0">
                                    <div                          class="px-2 pb-1.5 pt-2 flex flex-wrap items-end gap-1"                          :style="{ width: `${imageDisplayWidth(item.msg.id)}px` }"                        >
                                      <!-- reaction 胶囊：靠左（self-start），宽度随人数增减；卡片行在下靠右 -->
                                      <button                              v-for="r in item.msg.reactions"                              :key="r.emoji"                              class="rounded-lg text-xs transition-colors"                              :class="r.reacted_by_me                                ? (item.msg.sender_id === user?.id                                    ? 'bg-white text-primary'                                    : 'bg-primary text-white')                                : (r.count >
                                        0                                    ? (item.msg.sender_id === user?.id                                        ? 'bg-white/40 text-white'                                        : 'bg-primary/30 text-primary')                                    : (item.msg.sender_id === user?.id                                        ? 'bg-white/20 text-text-secondary hover:bg-white/30'                                        : 'bg-primary/5 text-text-secondary hover:bg-primary/10'))"                              @click="toggleReaction(item.msg, r.emoji)"                            >
                                        <!-- reaction 框：头像 + 表情 统一框起来 -->
                                        <span class="flex items-center gap-1 pl-0.5 pr-1.5 py-0.5">
                                          <span class="flex -space-x-1">
                                            <span                                    v-for="u in r.users.slice(0, 3)"                                    :key="u.id"                                    class="relative inline-flex w-4 h-4 rounded-full overflow-hidden border border-white text-[8px] font-semibold items-center justify-center"                                    :style="{ backgroundColor: avatarBgColor(u.username), color: avatarFgColor(u.username) }"                                    :title="u.username"                                  >
                                              <!-- 首字母兜底常驻底层：无头像或图片加载失败时显示 -->
                                              <span class="absolute inset-0 flex items-center justify-center">
                                                {{ u.username.charAt(0).toUpperCase() }}</span>
                                                <!-- 有头像用户：加载成功覆盖首字母；失败（404/错误）时隐藏露出首字母 -->
                                                <img                                      v-if="u.avatar_url"                                      :src="`/api/v1/users/${u.username}/avatar`"                                      :alt="u.username"                                      class="relative w-full h-full object-cover"                                      loading="lazy"                                      @error="(e) =>
                                                { (e.target as HTMLImageElement).style.display = 'none' }"                                    />
                                              </span>
                                            </span>
                                            <span>
                                              {{ r.emoji }}</span>
                                            </span>
                                          </button>
                                          <!-- 信息/功能卡片：第二行，靠右（items-end） -->
                                          <!-- 时间/状态 + hover 按钮：grid 第 2 列固定贴右贴底，宽度 = max(两行)，hover 切换不抖动 -->
                                          <span v-if="showInfoBar(item.msg)" class="grid h-6 shrink-0 whitespace-nowrap items-center justify-items-end ml-auto [&>*]:col-start-1 [&>*]:row-start-1">
                                            <span class="flex h-6 items-center gap-1 text-[10px] group-hover:invisible" :class="item.msg.sender_id === user?.id ? 'text-white/80' : 'text-text-secondary'">
                                              <span>
                                                {{ formatTime(item.msg.created_at) }}</span>
                                                <span v-if="item.msg.sender_id === user?.id" class="flex items-center gap-0.5">
                                                  <UIcon v-if="item.msg.read === true" name="i-lucide-check-check" class="size-3 text-white/90" />
                                                  <UIcon v-else name="i-lucide-check" class="size-3" />
                                                  <span>
                                                    {{ messageStatusText(item.msg) }}</span>
                                                  </span>
                                                </span>
                                                <span class="flex items-center gap-1 invisible group-hover:visible">
<button                                  class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                                  :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                                  title="表情反应"                                  @click="openReactionPicker(item.msg.id, $event)"                                >
                                                    <UIcon name="i-lucide-smile-plus" class="size-3.5" />
                                                  </button>
<button                                  class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                                  :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                                  title="引用回复"                                  @click="startReply(item.msg)"                                >
                                                    <UIcon name="i-lucide-corner-up-left" class="size-3.5" />
                                                  </button>
<UDropdownMenu :items="moreMenuItems(item.msg)" :content="{ side: 'bottom', align: 'end', sideOffset: 4, collisionPadding: 8 }">
<button                                  class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                                  :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                                  title="更多"                                >
                                                    <UIcon name="i-lucide-more-horizontal" class="size-3.5" />
                                                  </button>
</UDropdownMenu>
</span>
                                              </span>
                                            </div>
                                          </template>
                                        </div>
                                        <!-- 文本消息 -->
                                        <template v-else>
                                          <!-- 撤回：显示系统提示 -->
                                          <div v-if="item.msg.recalled_at" class="px-3 text-sm leading-relaxed break-words min-w-[130px] italic opacity-60" :class="textPaddingClass(item.msg)">
                                            {{ item.msg.sender_id === user?.id ? "你" : otherUserName }}撤回了一条消息
                                          </div>
                                          <!-- 正常文本 -->
                                          <template v-else>
                                            <div class="px-3 text-sm leading-relaxed break-words min-w-[130px]" :class="textPaddingClass(item.msg)">
                                              {{ item.msg.content }}
                                              <span v-if="item.msg.edited_at" class="ml-1 text-[10px] opacity-60">(已编辑)</span>
                                            </div>
                                          </template>
                                            <!-- 底部行：reaction 胶囊（左）+ 时间/状态或 hover 按钮（组尾显示）；无 reaction 且非组尾时整行不渲染 -->
                                            <div v-if="item.msg.reactions.length >
                                              0 || showInfoBar(item.msg)" class="px-2 flex flex-wrap items-end gap-1" :class="[item.msg.reactions.length === 0 ? 'justify-end' : '', infoBarPaddingClass(item.msg)]">
                                              <!-- reaction 胶囊：靠左（self-start），宽度随人数增减；卡片行在下靠右 -->
                                              <button                            v-for="r in item.msg.reactions"                            :key="r.emoji"                            class="rounded-lg text-xs transition-colors"                            :class="r.reacted_by_me                              ? (item.msg.sender_id === user?.id                                  ? 'bg-white text-primary'                                  : 'bg-primary text-white')                              : (r.count >
                                                0                                  ? (item.msg.sender_id === user?.id                                      ? 'bg-white/40 text-white'                                      : 'bg-primary/30 text-primary')                                  : (item.msg.sender_id === user?.id                                      ? 'bg-white/20 text-text-secondary hover:bg-white/30'                                      : 'bg-primary/5 text-text-secondary hover:bg-primary/10'))"                            @click="toggleReaction(item.msg, r.emoji)"                          >
                                                <!-- reaction 框：头像 + 表情 统一框起来 -->
                                                <span class="flex items-center gap-1 pl-0.5 pr-1.5 py-0.5">
                                                  <span class="flex -space-x-1">
                                                    <span                                  v-for="u in r.users.slice(0, 3)"                                  :key="u.id"                                  class="relative inline-flex w-4 h-4 rounded-full overflow-hidden border border-white text-[8px] font-semibold items-center justify-center"                                  :style="{ backgroundColor: avatarBgColor(u.username), color: avatarFgColor(u.username) }"                                  :title="u.username"                                >
                                                      <!-- 首字母兜底常驻底层：无头像或图片加载失败时显示 -->
                                                      <span class="absolute inset-0 flex items-center justify-center">
                                                        {{ u.username.charAt(0).toUpperCase() }}</span>
                                                        <!-- 有头像用户：加载成功覆盖首字母；失败（404/错误）时隐藏露出首字母 -->
                                                        <img                                    v-if="u.avatar_url"                                    :src="`/api/v1/users/${u.username}/avatar`"                                    :alt="u.username"                                    class="relative w-full h-full object-cover"                                    loading="lazy"                                    @error="(e) =>
                                                        { (e.target as HTMLImageElement).style.display = 'none' }"                                  />
                                                      </span>
                                                    </span>
                                                    <span>
                                                      {{ r.emoji }}</span>
                                                    </span>
                                                  </button>
                                                  <!-- 信息/功能卡片：第二行，靠右（items-end） -->
                                                  <!-- 时间/状态 + hover 按钮：grid 第 2 列固定贴右贴底，宽度 = max(两行)，hover 切换不抖动 -->
                                                  <span v-if="showInfoBar(item.msg)" class="grid h-6 shrink-0 whitespace-nowrap items-center justify-items-end ml-auto [&>*]:col-start-1 [&>*]:row-start-1">
                                                    <span class="flex h-6 items-center gap-1 text-[10px] group-hover:invisible" :class="item.msg.sender_id === user?.id ? 'text-white/80' : 'text-text-secondary'">
                                                      <span>
                                                        {{ formatTime(item.msg.created_at) }}</span>
                                                        <span v-if="item.msg.sender_id === user?.id" class="flex items-center gap-0.5">
                                                          <UIcon v-if="item.msg.read === true" name="i-lucide-check-check" class="size-3 text-white/90" />
                                                          <UIcon v-else name="i-lucide-check" class="size-3" />
                                                          <span>
                                                            {{ messageStatusText(item.msg) }}</span>
                                                          </span>
                                                        </span>
                                                        <span class="flex items-center gap-1 invisible group-hover:visible">
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                              :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                              title="表情反应"                              @click="openReactionPicker(item.msg.id, $event)"                            >
                                                            <UIcon name="i-lucide-smile-plus" class="size-3.5" />
                                                          </button>
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                              :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                              title="引用回复"                              @click="startReply(item.msg)"                            >
                                                            <UIcon name="i-lucide-corner-up-left" class="size-3.5" />
                                                          </button>
<UDropdownMenu :items="moreMenuItems(item.msg)" :content="{ side: 'bottom', align: 'end', sideOffset: 4, collisionPadding: 8 }">
<button                              class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-black/10 transition-colors"                              :class="item.msg.sender_id === user?.id ? 'text-white hover:bg-white/15' : 'text-text-secondary hover:bg-border/60'"                              title="更多"                            >
                                                            <UIcon name="i-lucide-more-horizontal" class="size-3.5" />
                                                          </button>
</UDropdownMenu>
</span>
                                                      </span>
                                                    </div>
                                                  </template>
                                                </div>
                                              </div>
                                            </div>
                                          </template>
                                        </div>
            </template>
            <!-- 本地发送中的消息（列表正序，显示在最新消息之后） -->
            <template v-for="(pmsg, pidx) in pendingMessages" :key="pmsg.tempId">
              <div
                v-if="pidx === 0 || !isSameDay(pmsg.created_at, (messages.length > 0 ? messages[messages.length - 1].created_at : pmsg.created_at))"
                class="sticky top-0 z-10 flex justify-center mb-3 mt-2"
              >
                <span class="px-3 py-1 rounded-full bg-black/30 text-white text-11px">{{ formatDate(pmsg.created_at) }}</span>
              </div>
              <div class="flex gap-2 items-end flex-row-reverse">
                <UserIdentity
                  :user="{ id: user?.id ?? '', username: user?.username ?? '我', avatar_url: user?.avatar_url ?? null }"
                  size="md"
                  :show-username="false"
                  :link="false"
                  class="flex-shrink-0"
                />
                <div class="max-w-[65%]">
                  <!-- 气泡主体：引用框 / 内容 / 发送状态 全在气泡内 -->
                  <div class="overflow-hidden bg-primary text-white rounded-lg rounded-br-sm">
                    <!-- 引用框（Telegram 风格，与已发送消息一致） -->
                    <div
                      v-if="pmsg.reply_to"
                      class="mx-2 mt-1.5 px-2.5 py-1.5 rounded-md text-xs leading-snug bg-white/20 border-l-[3px] border-white/60"
                    >
                      <span class="font-bold text-white">{{ pmsg.reply_to.sender_name }}</span>
                      <span class="block truncate text-white/80">{{ pmsg.reply_to.type === "image" ? "[图片]" : pmsg.reply_to.content }}</span>
                    </div>
                    <!-- 图片消息：无底色；正常比例按比例完整显示，超长/超宽/超小裁剪放大铺满；右下角半透明圆形长条显示时间/发送中 -->
                    <div v-if="pmsg.type === 'image'" class="relative overflow-hidden">
                      <img
                        :src="displayImageUrl(pmsg)"
                        alt="图片消息"
                        class="object-cover"
                        :style="imageStyle(pmsg.tempId).style"
                        @load="onImageLoaded(pmsg.tempId, $event)"
                      />
                      <div class="absolute bottom-1.5 right-1.5 h-6 rounded-full bg-black/50 backdrop-blur-sm px-2 text-[10px] text-white flex items-center gap-1">
                        <span>{{ formatTime(pmsg.created_at) }}</span>
                        <span class="flex items-center gap-0.5">
                          <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
                          <span>发送中</span>
                        </span>
                        <button class="text-white/80 hover:text-white" title="取消发送" @click="cancelPending(pmsg.tempId)">
                          <UIcon name="i-lucide-x" class="size-3" />
                        </button>
                      </div>
                    </div>
                    <!-- 文本消息 -->
                    <template v-else>
                      <div class="px-3 py-2 text-sm leading-relaxed break-words">
                        {{ pmsg.content }}
                      </div>
                      <!-- 发送状态（气泡内右下角，h-6 与已发送消息底部行同高） -->
                      <div class="h-6 px-3 pb-1.5 flex items-center justify-end gap-1 text-[10px] text-white/80">
                        <span>{{ formatTime(pmsg.created_at) }}</span>
                        <span class="flex items-center gap-0.5">
                          <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
                          <span>发送中</span>
                        </span>
                        <button class="text-white/80 hover:text-white" title="取消发送" @click="cancelPending(pmsg.tempId)">
                          <UIcon name="i-lucide-x" class="size-3" />
                        </button>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>

        <!-- 输入区域：浮岛形式，绝对定位悬浮在消息列表底部 -->
        <div ref="islandRef" class="absolute bottom-3 left-0 right-0 px-3">
          <!-- 引用回复状态条 -->
          <div v-if="replyTo" class="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-white border border-border shadow-sm text-xs text-text-secondary">
            <UIcon name="i-lucide-corner-up-left" class="size-3.5 flex-shrink-0" />
            <span class="truncate flex-1">
              回复 <span class="font-medium text-text">{{ replyTo.sender_id === user?.id ? (user?.username ?? "我") : otherUserName }}</span>：
              {{ replyTo.type === "image" ? "[图片]" : replyTo.content }}
            </span>
            <button class="text-text-secondary hover:text-text" title="取消回复" @click="cancelReply">
              <UIcon name="i-lucide-x" class="size-3.5" />
            </button>
          </div>
          <!-- 浮岛输入框：拉长圆形，右侧圆形图片/发送按钮；textarea 自动换行增高 -->
          <div class="flex items-end gap-2 px-2 py-1.5 rounded-2xl bg-white border border-border shadow-md">
            <!-- 图片选择 -->
            <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="onImageSelected" />
            <textarea
              ref="messageInputRef"
              v-model="newMessage"
              rows="1"
              placeholder="输入消息..."
              class="flex-1 px-3 py-1.5 bg-transparent text-text text-sm outline-none resize-none leading-snug"
              @input="autoResizeInput"
              @keydown.enter.exact.prevent="send"
            />
            <!-- 图片按钮：圆形 -->
            <UButton
              color="gray"
              variant="ghost"
              class="flex w-9 h-9 rounded-full flex-shrink-0"
              :disabled="imageUploading"
              :title="imageUploading ? '上传中...' : '发送图片'"
              @click="imageInput?.click()"
            >
              <UIcon v-if="imageUploading" name="i-lucide-loader-circle" class="size-4 animate-spin" />
              <UIcon v-else name="i-lucide-image-plus" class="size-4" />
            </UButton>
            <!-- 发送按钮：圆形 -->
            <UButton color="primary" class="flex w-9 h-9 rounded-full transition-opacity disabled:opacity-40" :disabled="!newMessage.trim() || sending"
              @click="send">
              <UIcon name="i-lucide-send" class="size-4" />
            </UButton>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- 全局 Reaction 快捷选择弹层（fixed 定位，不受气泡 overflow-hidden 裁剪；圆角方形 + 换行逻辑；右缘与表情按钮右缘齐平） -->
  <div
    v-if="showReactionPicker && reactionPickerStyle"
    class="reaction-picker fixed z-50 w-[160px] bg-white border border-border rounded-lg px-2 py-1.5 shadow-md"
    :style="{ top: reactionPickerStyle.top, left: reactionPickerStyle.left }"
  >
    <div class="flex flex-wrap gap-1">
      <button
        v-for="emoji in REACTION_EMOJIS"
        :key="emoji"
        class="w-7 h-7 rounded-md flex items-center justify-center text-base hover:bg-page transition-colors"
        :class="messages.find((m) => m.id === showReactionPicker)?.reactions.find((r) => r.emoji === emoji)?.reacted_by_me ? 'bg-primary/10' : ''"
        @click="showReactionPicker && toggleReaction(messages.find((m) => m.id === showReactionPicker)!, emoji)"
      >
        {{ emoji }}
      </button>
    </div>
  </div>

  <!-- 转发会话选择器 -->
  <UModal v-if="showForwardPicker" v-model:open="showForwardPicker" title="转发消息" :ui="{ width: 'max-w-sm' }" :unmount-on-hide="true">
    <template #body>
      <div class="space-y-4">
        <!-- 消息预览：与回复引用样式一致的框 -->
        <div class="px-2.5 py-1.5 rounded-md text-xs leading-snug bg-primary/5 border-l-[3px] border-primary">
          <span class="block truncate text-text">{{ forwardTarget?.type === "image" ? "[图片]" : forwardTarget?.content }}</span>
        </div>
        <div v-if="forwardConversations.length === 0" class="text-sm text-text-secondary py-6 text-center">
          没有其他会话可转发
        </div>
        <div v-else class="space-y-1 max-h-[300px] overflow-y-auto">
          <button
            v-for="conv in forwardConversations"
            :key="conv.id"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-primary/5 active:bg-primary/10 transition-colors text-left"
            :disabled="forwarding"
            @click="openForwardConfirm(conv)"
          >
            <UserIdentity
              :user="{ id: conv.other_user_id, username: conv.other_user_name, avatar_url: conv.other_user_avatar_url }"
              size="sm"
              :show-username="false"
              :link="false"
            />
            <span class="text-sm font-medium text-text flex-1 truncate">{{ conv.other_user_name }}</span>
            <UIcon v-if="forwarding" name="i-lucide-loader-circle" class="size-4 animate-spin text-text-secondary" />
          </button>
        </div>
        <div class="flex justify-end">
          <UButton color="gray" variant="ghost" @click="showForwardPicker = false">取消</UButton>
        </div>
      </div>
    </template>
  </UModal>

  <!-- 转发二次确认 -->
  <UModal v-if="showForwardConfirm" v-model:open="showForwardConfirm" title="确认转发" :ui="{ width: 'max-w-sm' }" :unmount-on-hide="true">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-text-secondary flex items-center gap-2">
          将发送给
          <UserIdentity
            v-if="confirmTarget"
            :user="{ id: confirmTarget.other_user_id, username: confirmTarget.other_user_name, avatar_url: confirmTarget.other_user_avatar_url }"
            size="sm"
            :show-username="false"
            :link="false"
          />
          <span class="font-medium text-text">{{ confirmTarget?.other_user_name }}</span>
        </p>
        <div v-if="forwardTarget?.type === 'image'" class="rounded-lg border border-border overflow-hidden">
          <img
            :src="displayImageUrl(forwardTarget, forwardTarget.conversation_id)"
            alt="转发图片"
            class="max-h-48 w-full object-contain bg-black/5"
          />
        </div>
        <div v-else class="rounded-lg border border-border bg-page px-3 py-2 text-sm text-text break-words">
          {{ forwardTarget?.content }}
        </div>
        <div class="flex justify-end gap-2">
          <UButton color="gray" variant="ghost" @click="showForwardConfirm = false">取消</UButton>
          <UButton color="primary" :disabled="forwarding" @click="confirmTarget && doForward(confirmTarget.id)">
            {{ forwarding ? "转发中…" : "确认转发" }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>

  <!-- 编辑消息弹窗 -->
  <UModal v-if="showEditModal" v-model:open="showEditModal" title="编辑消息" :ui="{ width: 'max-w-sm' }" :unmount-on-hide="true">
    <template #body>
      <div class="space-y-4">
        <textarea
          v-model="editingContent"
          rows="3"
          class="w-full px-3 py-2 rounded-lg border border-border bg-page text-text text-sm outline-none resize-none"
          placeholder="输入新内容..."
        />
        <div class="flex justify-end gap-2">
          <UButton color="gray" variant="ghost" @click="showEditModal = false">取消</UButton>
          <UButton color="primary" :disabled="!editingContent.trim() || editingSaving" @click="submitEdit">
            {{ editingSaving ? "保存中…" : "保存" }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>

  <!-- 编辑备注弹窗 -->
  <UModal v-if="showRemarkModal" v-model:open="showRemarkModal" title="编辑备注" :ui="{ width: 'max-w-sm' }" :unmount-on-hide="true">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-text-secondary">为 {{ otherDisplayName }} 设置备注名（聊天页与会话列表显示备注名）。</p>
        <input
          v-model="remarkInput"
          type="text"
          maxlength="50"
          placeholder="输入备注名（留空清除）"
          class="w-full px-3 py-2 rounded-lg border border-border bg-page text-text text-sm outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
          @keydown.enter="saveRemark"
        />
        <div class="flex justify-end gap-2">
          <UButton color="gray" variant="ghost" @click="showRemarkModal = false">取消</UButton>
          <UButton color="primary" @click="saveRemark">保存</UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
