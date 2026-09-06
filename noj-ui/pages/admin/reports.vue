<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { useToast } from "~/composables/useToast"

definePageMeta({ layout: "admin", middleware: "community-moderation", ssr: false })

interface ReportUser {
  id: string
  username: string
  avatar_url?: string | null
}
interface ReportPost {
  id: string
  title: string | null
  content: string
  type: string
  author_id: string
}
interface ReportComment {
  id: string
  content: string
  post_id: string
  author_id: string
}
interface ReportMessage {
  id: string
  content: string
  type: string
  conversation_id: string
  sender_id: string
  recalled_at: string | null
}
interface MessageHistoryItem {
  id: string
  conversation_id: string
  sender_id: string
  type: string
  content: string
  created_at: string
  recalled_at: string | null
  image_url: string | null
  reply_to_message_id: string | null
  reply_to: {
    sender_name: string
    content: string
    type: string
  } | null
  forwarded_from_user_id: string | null
  forwarded_from_user: { id: string; username: string } | null
}
interface ReportRow {
  report: {
    id: string
    reporter_id: string
    post_id: string | null
    comment_id: string | null
    message_id: string | null
    content_type: string
    category: string
    reason: string
    content_snapshot: string
    status: "pending" | "resolved" | "dismissed"
    resolution: string | null
    resolved_by: string | null
    resolved_at: string | null
    created_at: string
  }
  reporter: ReportUser
  reported_author: ReportUser | null
  resolved_by_user: ReportUser | null
  active_sanction: boolean
  ban: {
    id: string
    scope: "platform" | "social"
    banned_until: string | null
  } | null
  post: ReportPost | null
  comment: ReportComment | null
  message: ReportMessage | null
}

const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()

type Tab = "pending" | "resolved" | "dismissed"
const activeTab = ref<Tab>("pending")
const lists = reactive<Record<Tab, ReportRow[]>>({ pending: [], resolved: [], dismissed: [] })
const loading = ref(false)

// 处理相关状态
const processingId = ref<string | null>(null)
const showProcess = ref(false)
const processTarget = ref<ReportRow | null>(null)
// 聊天记录预览弹窗
const showHistory = ref(false)
const historyLoading = ref(false)
const historyConversation = ref("")
const historyMessages = ref<MessageHistoryItem[]>([])
const reporterUserId = ref("")
const processAction = ref<"remove_content" | "ban">("remove_content")
const processReason = ref("")
const processExpiresAt = ref("")
const processScope = ref<"platform" | "social">("social")

const typeLabel: Record<string, string> = {
  discussion: "讨论",
  solution: "题解",
  moment: "动态",
  message: "私信",
}

async function load(tab: Tab) {
  try {
    const result = await api.get<{ data: ReportRow[] }>(
      "/api/v1/community/admin/reports",
      { query: { status: tab }, silent: true },
    )
    lists[tab] = result.data
  } catch {
    lists[tab] = []
  }
}

function switchTab(tab: Tab) {
  activeTab.value = tab
  load(tab)
}

// 内容跳转链接：评论跳转到所属帖子详情页；私信消息无公开页面
function contentHref(row: ReportRow): string {
  if (row.report.content_type === "message") return "#"
  const postId = row.post?.id ?? row.comment?.post_id
  return postId ? `/community/posts/${postId}` : "#"
}
function contentLabel(row: ReportRow): string {
  if (row.report.content_type === "message") {
    return `私信消息：${row.report.content_snapshot?.slice(0, 60) ?? ""}`
  }
  if (row.report.content_type === "comment") {
    return `评论：${row.report.content_snapshot?.slice(0, 60) ?? ""}`
  }
  return `${row.post?.title ?? "内容"}：${row.report.content_snapshot?.slice(0, 60) ?? ""}`
}

function openProcess(row: ReportRow) {
  processTarget.value = row
  processAction.value = "remove_content"
  processReason.value = ""
  processExpiresAt.value = ""
  processScope.value = "social"
  showProcess.value = true
}

// 打开举报附带的完整聊天记录（管理员可见全部，含撤回原文）
async function openHistory(row: ReportRow) {
  if (!row.message?.conversation_id) return
  historyConversation.value = row.report.content_snapshot
  reporterUserId.value = row.reporter.id
  historyMessages.value = []
  showHistory.value = true
  historyLoading.value = true
  try {
    const result = await api.get<{ data: { message_history?: MessageHistoryItem[] } }>(
      `/api/v1/community/reports/${row.report.id}`,
      { silent: true },
    )
    historyMessages.value = result.data.message_history ?? []
  } catch {
    historyMessages.value = []
  } finally {
    historyLoading.value = false
  }
}

async function submitProcess() {
  if (!processTarget.value) return
  const target = processTarget.value
  const isBan = processAction.value === "ban"
  processingId.value = target.report.id
  try {
    const body: Record<string, unknown> = { action: processAction.value }
    if (isBan) {
      // 被处罚用户由后端从举报目标派生，前端无需指定
      body.expires_at = processExpiresAt.value || undefined
      body.scope = processScope.value
    }
    body.resolution = processReason.value.trim() || undefined
    await api.post(`/api/v1/community/admin/reports/${target.report.id}/resolved`, body)
    toast.success(isBan ? "已封禁" : "已移除内容")
    showProcess.value = false
    await load("pending")
    await load("resolved")
  } catch (err: unknown) {
    // useApi 已弹后端错误
  } finally {
    processingId.value = null
  }
}

async function dismissReport(row: ReportRow) {
  const reason = await dialog.prompt("驳回原因（可选）", {
    title: "驳回举报",
    placeholder: "请输入驳回原因...",
    confirmText: "驳回",
  })
  if (reason === null) return
  processingId.value = row.report.id
  try {
    await api.post(`/api/v1/community/admin/reports/${row.report.id}/dismissed`, { resolution: reason })
    toast.success("已驳回")
    await load("pending")
    await load("dismissed")
  } finally {
    processingId.value = null
  }
}

async function reopenReport(row: ReportRow) {
  const message = row.active_sanction
    ? "撤销该处理会将举报放回待处理，并同时撤销已施加的禁言处罚。确定继续吗？"
    : "确定撤销这条处理，将举报放回待处理吗？"
  const ok = await dialog.confirm(message, {
    title: "撤销处理",
    confirmText: "撤销",
    danger: true,
  })
  if (!ok) return
  processingId.value = row.report.id
  try {
    await api.post(`/api/v1/community/admin/reports/${row.report.id}/reopen`)
    toast.success("已撤销，举报回到待处理")
    await load("pending")
    await load("resolved")
    await load("dismissed")
  } finally {
    processingId.value = null
  }
}

await Promise.all([load("pending"), load("resolved"), load("dismissed")])
</script>

<template>
  <div>
    <div class="mb-6 flex items-center gap-2">
      <UIcon name="i-lucide-flag" class="size-5" />
      <h1 class="text-2xl font-bold">举报管理</h1>
    </div>

    <!-- 三板块 Tab -->
    <div class="mb-6 flex gap-2 border-b border-border">
      <button
        v-for="tab in ([
          { key: 'pending', label: '待处理' },
          { key: 'resolved', label: '已处理' },
          { key: 'dismissed', label: '驳回' },
        ] as const)"
        :key="tab.key"
        type="button"
        class="px-4 py-3 text-sm transition-colors"
        :class="activeTab === tab.key ? 'border-b-2 border-signal font-semibold text-primary' : 'text-text-secondary hover:text-text'"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}（{{ lists[tab.key].length }}）
      </button>
    </div>

    <!-- 空态 -->
    <div v-if="lists[activeTab].length === 0" class="rounded-lg border border-dashed border-border p-10 text-center text-text-secondary">
      暂无{{ activeTab === "pending" ? "待处理" : activeTab === "resolved" ? "已处理" : "已驳回" }}举报。
    </div>

    <!-- 举报卡片 -->
    <div v-else class="space-y-3">
      <article v-for="row in lists[activeTab]" :key="row.report.id" class="rounded-lg border border-border bg-white p-5 shadow-card">
        <!-- 头部：工单ID + 类型 + 时间 -->
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span class="font-mono">#{{ row.report.id.slice(0, 8) }}</span>
            <span class="rounded bg-primary-bg px-2 py-0.5 text-primary">{{ row.report.content_type === "comment" ? "评论" : row.report.content_type === "message" ? "私信" : (typeLabel[row.post?.type ?? ""] ?? "内容") }}</span>
            <NuxtTime :datetime="row.report.created_at" locale="zh-CN" class="text-text-secondary" />
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span v-if="row.report.status === 'resolved'" class="text-green-600">已处理</span>
            <span v-else-if="row.report.status === 'dismissed'" class="text-orange-600">已驳回</span>
          </div>
        </div>

        <!-- 举报者 / 被举报者 -->
        <div class="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary">
          <span class="inline-flex items-center gap-1">
            举报者：
            <NuxtLink :to="`/users/${row.reporter.id}`" class="text-primary hover:underline">{{ row.reporter.username }}</NuxtLink>
          </span>
          <span v-if="row.reported_author" class="inline-flex items-center gap-1">
            被举报者：
            <NuxtLink :to="`/users/${row.reported_author.id}`" class="text-primary hover:underline">{{ row.reported_author.username }}</NuxtLink>
          </span>
        </div>

        <!-- 被举报内容（可点击跳转） -->
        <NuxtLink :to="contentHref(row)" class="block rounded border border-border bg-bg-page px-3 py-2 text-sm text-text-secondary hover:bg-primary-bg">
          <span class="font-medium text-text">{{ contentLabel(row) }}</span>
        </NuxtLink>

        <!-- 举报分类 -->
        <p class="mt-3 text-xs text-text-muted"><span class="font-medium text-text">举报分类：</span><span class="rounded bg-primary-bg px-1.5 py-0.5 text-xs text-primary">{{ row.report.category }}</span></p>

        <!-- 举报理由 -->
        <p class="mt-3 text-sm text-text-secondary"><span class="font-medium text-text">举报理由：</span>{{ row.report.reason }}</p>

        <!-- 已处理/驳回信息 -->
        <div v-if="row.report.status !== 'pending'" class="mt-3 rounded-lg bg-bg-page px-3 py-2 text-xs text-text-secondary">
          <div>处理结果：{{ row.report.resolution || "（未填写）" }}</div>
          <div v-if="row.ban">
            封禁范围：{{ row.ban.scope === "social" ? "仅限制社交功能" : "限制使用平台" }}
          </div>
          <div v-if="row.ban">
            封禁期限：{{ row.ban.banned_until ? `至 ${new Date(row.ban.banned_until).toLocaleString("zh-CN")}` : "永久封禁" }}
          </div>
          <div>处理者：{{ row.resolved_by_user?.username ?? row.report.resolved_by ?? "（未知）" }}</div>
          <div>处理时间：<NuxtTime :datetime="row.report.resolved_at ?? row.report.created_at" locale="zh-CN" date-style="medium" time-style="short" /></div>
        </div>

        <!-- 操作按钮 -->
        <div class="mt-4 flex flex-wrap gap-2">
          <template v-if="activeTab === 'pending'">
            <UButton color="primary" size="sm" :disabled="processingId !== null" @click="openProcess(row)">处理</UButton>
            <UButton color="neutral" variant="outline" size="sm" :disabled="processingId !== null" @click="dismissReport(row)">驳回</UButton>
          </template>
          <template v-else>
            <UButton color="neutral" variant="outline" size="sm" :disabled="processingId !== null" @click="reopenReport(row)">撤销</UButton>
          </template>
          <!-- 举报私信消息：可查看完整聊天记录 -->
          <UButton v-if="row.message" color="neutral" variant="outline" size="sm" @click="openHistory(row)">
            <UIcon name="i-lucide-messages-square" class="size-3.5" />查看聊天记录
          </UButton>
        </div>
      </article>
    </div>

    <!-- 处理弹窗 -->
    <UModal v-model:open="showProcess" title="处理举报" :description="processTarget ? contentLabel(processTarget) : ''">
      <template #body>
        <div class="space-y-4 py-2">
          <label class="block">
            <span class="mb-1 block text-xs text-text-secondary">处理方式</span>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="processAction" type="radio" value="remove_content" class="accent-primary" />
                仅移除内容
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input v-model="processAction" type="radio" value="ban" class="accent-primary" />
                封禁处罚
              </label>
            </div>
          </label>

          <template v-if="processAction === 'ban'">
            <div class="text-sm text-text-secondary">被处罚用户：<strong class="text-text">{{ processTarget?.reported_author?.username ?? processTarget?.reporter?.username }}</strong>（举报目标的作者）</div>
            <label class="block">
              <span class="mb-1 block text-xs text-text-secondary">封禁类型</span>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 text-sm">
                  <input v-model="processScope" type="radio" value="platform" class="accent-primary" />
                  限制使用平台
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input v-model="processScope" type="radio" value="social" class="accent-primary" />
                  仅限制社交
                </label>
              </div>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-text-secondary">封禁期限（留空为永久）</span>
              <input v-model="processExpiresAt" type="datetime-local" class="w-full rounded border border-border px-3 py-2 text-sm" />
            </label>
          </template>

          <label class="block">
            <span class="mb-1 block text-xs text-text-secondary">理由（处理结果说明）</span>
            <textarea v-model="processReason" class="min-h-20 w-full rounded border border-border px-3 py-2 text-sm" placeholder="例如：违反社区规范" />
          </label>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showProcess = false">取消</UButton>
          <UButton color="primary" :disabled="processingId !== null" @click="submitProcess">{{ processingId !== null ? "处理中…" : "确认处理" }}</UButton>
        </div>
      </template>
    </UModal>

    <!-- 举报附带的完整聊天记录预览 -->
    <UModal v-model:open="showHistory" title="完整聊天记录" :ui="{ content: 'max-w-lg' }" :unmount-on-hide="true">
      <template #body>
        <div class="space-y-3">
          <p class="text-xs text-text-secondary">被举报内容：{{ historyConversation }}</p>
          <div v-if="historyLoading" class="py-8 text-center text-sm text-text-secondary">加载中…</div>
          <div v-else-if="historyMessages.length === 0" class="py-8 text-center text-sm text-text-secondary">该会话暂无消息</div>
          <div v-else class="max-h-[420px] space-y-2 overflow-y-auto rounded-md bg-bg-page p-3">
            <div
              v-for="m in historyMessages"
              :key="m.id"
              class="flex gap-2 text-sm"
              :class="m.sender_id === reporterUserId ? 'justify-end' : ''"
            >
              <div
                class="max-w-[80%] rounded-lg px-2.5 py-1.5 text-text-secondary"
                :class="m.sender_id === reporterUserId ? 'bg-primary/10' : 'bg-default border border-border'"
              >
                <div class="mb-0.5 flex items-center gap-1.5 text-xs text-text-muted">
                  <span>{{ m.sender_id === reporterUserId ? "举报者" : "被举报者" }}</span>
                  <span v-if="m.forwarded_from_user" class="inline-flex items-center gap-0.5 text-primary">
                    <UIcon name="i-lucide-forward" class="size-3" />转自 @{{ m.forwarded_from_user.username }}
                  </span>
                </div>
                <!-- 回复引用框 -->
                <div
                  v-if="m.reply_to"
                  class="mb-1 rounded-md border-l-[3px] border-primary bg-primary/5 px-2 py-1 text-xs leading-snug"
                >
                  <span class="font-semibold text-primary">{{ m.reply_to.sender_name }}</span>
                  <span class="ml-1 text-text-secondary">{{ m.reply_to.content }}</span>
                </div>
                <!-- 撤回消息：管理员可见原文/原图（带已撤回标记），举报者本人场景后端已隐藏为"该消息已撤回" -->
                <template v-if="m.recalled_at">
                  <template v-if="m.content && m.content !== '该消息已撤回'">
                    <span class="italic text-text-muted">（已撤回）</span>{{ m.content }}
                  </template>
                  <template v-else-if="m.type === 'image' && m.image_url">
                    <span class="italic text-text-muted">（已撤回）</span>
                    <img
                      :src="`/api/v1/community/admin/reports/images/${m.conversation_id}/${m.id}`"
                      alt="举报图片（已撤回）"
                      class="max-h-40 rounded-md object-contain"
                      loading="lazy"
                    />
                  </template>
                  <span v-else class="italic opacity-60">该消息已撤回</span>
                </template>
                <!-- 图片消息 -->
                <span v-else-if="m.type === 'image' && m.image_url">
                  <img
                    :src="`/api/v1/community/admin/reports/images/${m.conversation_id}/${m.id}`"
                    alt="举报图片"
                    class="max-h-40 rounded-md object-contain"
                    loading="lazy"
                  />
                </span>
                <span v-else-if="m.type === 'image'">[图片]</span>
                <!-- 文本 -->
                <span v-else>{{ m.content }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end">
          <UButton color="neutral" variant="ghost" @click="showHistory = false">关闭</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
