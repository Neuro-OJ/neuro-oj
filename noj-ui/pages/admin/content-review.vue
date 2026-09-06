<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { useToast } from "~/composables/useToast"

definePageMeta({ layout: "admin", middleware: "community-moderation", ssr: false })

/**
 * 统一人工审查队列（issue #413）。
 *
 * 聚合 UGC（帖子/评论）同步审核与私信异步审核产生的待审/留痕记录。
 * - 帖子/评论：可查看快照与上下文；处置 = 隐藏内容（走既有帖子/评论状态端点）或仅记录
 * - 私信：可查看会话双方与聊天记录上下文；处置 = 仅记录（隐藏/封禁建议走举报管理流程）
 * - 所有处置都会落 content_review_queue.reviewed/dismissed 留痕 + 审计日志
 */

interface ReviewMessageContext {
  target: { id: string; conversation_id: string; sender_id: string }
  conversation: {
    id: string
    user1: { id: string; username: string }
    user2: { id: string; username: string }
  } | null
  history: Array<{
    id: string
    sender_id: string
    sender_name: string
    type: string
    content: string
    created_at: string
    recalled_at: string | null
  }> | null
}
interface ReviewPostContext {
  id: string
  status: string
  type: string
  title: string | null
  author_id: string
  author_username: string | null
}
interface ReviewCommentContext {
  id: string
  status: string
  content: string
  author_id: string
  author_username: string | null
  post_id: string
  post_title: string | null
}

interface ReviewItem {
  id: string
  content_type: "post" | "comment" | "message"
  target_id: string
  channel: "ugc" | "dm"
  status: "pending_review" | "approved" | "rejected" | "reviewed" | "dismissed"
  review_provider: string
  verdict: "pass" | "review" | "block" | "error"
  label: string | null
  hit_words: string | null
  risk_level: string | null
  content_snapshot: string
  meta: string
  reviewed_by: string | null
  reviewed_at: string | null
  resolution: string | null
  action_taken: string | null
  created_at: string
  context?: {
    post?: ReviewPostContext | null
    comment?: ReviewCommentContext | null
    message?: ReviewMessageContext | null
  }
}

const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()

type Tab = "pending_review" | "approved" | "reviewed" | "dismissed" | "rejected"
const activeTab = ref<Tab>("pending_review")
const channelFilter = ref<"" | "ugc" | "dm">("")
const contentFilter = ref<"" | "post" | "comment" | "message">("")
const items = ref<ReviewItem[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const perPage = 20
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage)))

// 详情/上下文弹窗
const showDetail = ref(false)
const detailLoading = ref(false)
const detailItem = ref<ReviewItem | null>(null)

// 处置相关
const processingId = ref<string | null>(null)
const showResolve = ref(false)
const resolveTarget = ref<ReviewItem | null>(null)
const resolveAction = ref<"record_only" | "hide_content">("record_only")
const resolveReason = ref("")

const typeLabel: Record<string, string> = {
  post: "帖子",
  comment: "评论",
  message: "私信",
}
const statusLabel: Record<Tab, string> = {
  pending_review: "待人工复核",
  approved: "机器放行",
  reviewed: "已处置",
  dismissed: "已驳回",
  rejected: "机器拦截",
}
const verdictLabel: Record<string, string> = {
  pass: "通过",
  review: "疑似",
  block: "违规",
  error: "审核不可用",
}
const providerLabel: Record<string, string> = {
  mock: "Mock",
  aliyun: "阿里云",
  tencent: "腾讯云",
  none: "未审核",
}
const statusColor: Record<Tab, string> = {
  pending_review: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-700",
  reviewed: "bg-blue-100 text-blue-700",
  dismissed: "bg-gray-100 text-gray-600",
  rejected: "bg-red-100 text-red-700",
}
const riskColor: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-green-100 text-green-700",
}

function channelLabel(channel: "ugc" | "dm"): string {
  return channel === "ugc" ? "UGC" : "私信"
}

function parseLabel(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

async function load(targetPage = page.value) {
  loading.value = true
  try {
    const query: Record<string, string | number> = {
      status: activeTab.value,
      page: targetPage,
      per_page: perPage,
    }
    if (channelFilter.value) query.channel = channelFilter.value
    if (contentFilter.value) query.content_type = contentFilter.value
    const res = await api.get<{ data: ReviewItem[]; pagination: { total: number } }>(
      "/api/v1/community/admin/content-review",
      { query, silent: true },
    )
    items.value = res.data
    total.value = res.pagination.total ?? 0
  } catch {
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function switchTab(tab: Tab) {
  activeTab.value = tab
  page.value = 1
  load(1)
}
function onFilterChange() {
  page.value = 1
  load(1)
}
function onPageChange(p: number) {
  page.value = p
  load(p)
}

// 详情：请求 context（私信含完整聊天上下文）
async function openDetail(row: ReviewItem) {
  detailItem.value = null
  showDetail.value = true
  detailLoading.value = true
  try {
    const res = await api.get<{ data: ReviewItem }>(
      `/api/v1/community/admin/content-review/${row.id}`,
      { silent: true },
    )
    detailItem.value = res.data
  } catch {
    detailItem.value = row
  } finally {
    detailLoading.value = false
  }
}

function openResolve(row: ReviewItem) {
  resolveTarget.value = row
  resolveReason.value = ""
  resolveAction.value = row.content_type === "message" ? "record_only" : "hide_content"
  showResolve.value = true
}

async function submitResolve() {
  if (!resolveTarget.value) return
  const target = resolveTarget.value
  processingId.value = target.id
  try {
    // 1) 帖子/评论且选择隐藏 → 调既有社区隐藏端点（留痕由 moderation 动作覆盖）
    if (resolveAction.value === "hide_content" && target.content_type !== "message") {
      const endpoint = target.content_type === "post"
        ? `/api/v1/community/admin/posts/${target.target_id}/hidden`
        : `/api/v1/community/admin/comments/${target.target_id}/hidden`
      await api.post(endpoint, { reason: resolveReason.value.trim() || "内容审核隐藏" })
    }
    // 2) 处置记录落库（reviewed）
    await api.post(`/api/v1/community/admin/content-review/${target.id}/reviewed`, {
      action: resolveAction.value,
      resolution: resolveReason.value.trim() || (resolveAction.value === "hide_content" ? "已隐藏违规内容" : "已人工复核，无违规"),
    })
    toast.success(resolveAction.value === "hide_content" ? "已隐藏内容并留痕" : "已记录处置")
    showResolve.value = false
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  } finally {
    processingId.value = null
  }
}

async function dismissItem(row: ReviewItem) {
  const reason = await dialog.prompt("驳回原因（可选）", {
    title: "驳回该条审查记录",
    placeholder: "例如：内容无明显违规",
    confirmText: "驳回",
  })
  if (reason === null) return
  processingId.value = row.id
  try {
    await api.post(`/api/v1/community/admin/content-review/${row.id}/dismissed`, {
      resolution: reason,
    })
    toast.success("已驳回")
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  } finally {
    processingId.value = null
  }
}

watch(activeTab, () => switchTab(activeTab.value), { immediate: true })
</script>

<template>
  <div>
    <div class="mb-6 flex items-center gap-2">
      <UIcon name="i-lucide-shield-alert" class="size-5" />
      <h1 class="text-2xl font-bold">内容审查</h1>
    </div>

    <!-- 状态 Tab -->
    <div class="mb-4 flex flex-wrap gap-2 border-b border-border">
      <button
        v-for="(label, key) in statusLabel"
        :key="key"
        type="button"
        class="px-4 py-3 text-sm transition-colors"
        :class="activeTab === key ? 'border-b-2 border-signal font-semibold text-primary' : 'text-text-secondary hover:text-text'"
        @click="switchTab(key as Tab)"
      >
        {{ label }}
      </button>
    </div>

    <!-- 筛选 -->
    <div class="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <label class="flex items-center gap-1.5 text-text-secondary">
        内容类型
        <select v-model="contentFilter" class="rounded border border-border px-2 py-1.5 text-sm" @change="onFilterChange">
          <option value="">全部</option>
          <option value="post">帖子</option>
          <option value="comment">评论</option>
          <option value="message">私信</option>
        </select>
      </label>
      <label class="flex items-center gap-1.5 text-text-secondary">
        来源
        <select v-model="channelFilter" class="rounded border border-border px-2 py-1.5 text-sm" @change="onFilterChange">
          <option value="">全部</option>
          <option value="ugc">UGC（同步）</option>
          <option value="dm">私信（异步）</option>
        </select>
      </label>
      <span class="text-xs text-text-muted">共 {{ total }} 条</span>
      <UButton color="neutral" variant="outline" size="sm" class="ml-auto" @click="load()">
        <UIcon name="i-lucide-refresh-cw" class="size-3.5" />刷新
      </UButton>
    </div>

    <!-- 空态 -->
    <div v-if="!loading && items.length === 0" class="rounded-lg border border-dashed border-border p-10 text-center text-text-secondary">
      暂无{{ statusLabel[activeTab] }}记录。
    </div>

    <!-- 记录卡片 -->
    <div v-else class="space-y-3">
      <div v-if="loading" class="py-10 text-center text-sm text-text-secondary">加载中…</div>
      <article v-for="row in items" :key="row.id" class="rounded-lg border border-border bg-white p-5 shadow-card">
        <!-- 头部：类型 + 状态 + 时间 -->
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span class="font-mono">#{{ row.id.slice(0, 8) }}</span>
            <span class="rounded bg-primary-bg px-2 py-0.5 text-primary">{{ typeLabel[row.content_type] }}</span>
            <span class="rounded px-2 py-0.5" :class="statusColor[row.status]">{{ statusLabel[row.status] }}</span>
            <span v-if="row.risk_level" class="rounded px-1.5 py-0.5 text-xs" :class="riskColor[row.risk_level] ?? 'bg-gray-100 text-gray-600'">
              {{ row.risk_level === "high" ? "高" : row.risk_level === "medium" ? "中" : "低" }}风险
            </span>
            <span class="text-text-secondary">
              {{ channelLabel(row.channel) }} · {{ providerLabel[row.review_provider] ?? row.review_provider }} ·
              判定 {{ verdictLabel[row.verdict] ?? row.verdict }}
            </span>
            <NuxtTime :datetime="row.created_at" locale="zh-CN" class="text-text-secondary" />
          </div>
        </div>

        <!-- 标签/命中词 -->
        <div v-if="parseLabel(row.label).length || parseLabel(row.hit_words).length" class="mb-2 flex flex-wrap gap-1.5 text-xs">
          <span v-for="l in parseLabel(row.label)" :key="`l-${l}`" class="rounded bg-red-50 px-1.5 py-0.5 text-red-700">{{ l }}</span>
          <span v-for="w in parseLabel(row.hit_words)" :key="`w-${w}`" class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{{ w }}</span>
        </div>

        <!-- 内容快照 -->
        <button
          class="block w-full rounded border border-border bg-bg-page px-3 py-2 text-left text-sm text-text-secondary hover:bg-primary-bg"
          @click="openDetail(row)"
        >
          <span class="font-medium text-text">{{ typeLabel[row.content_type] }}内容：</span>
          {{ row.content_snapshot.slice(0, 120) || "（空）" }}
          <span class="text-xs text-text-muted">（点击查看详情）</span>
        </button>

        <!-- 处置信息 -->
        <div v-if="row.status === 'reviewed' || row.status === 'dismissed'" class="mt-3 rounded-lg bg-bg-page px-3 py-2 text-xs text-text-secondary">
          <div>处置：{{ row.action_taken === "hide_content" ? "隐藏内容" : row.action_taken === "record_only" ? "仅记录" : row.action_taken === "dismiss" ? "驳回" : (row.action_taken ?? "—") }}</div>
          <div v-if="row.resolution">说明：{{ row.resolution }}</div>
          <div>处理时间：<NuxtTime :datetime="row.reviewed_at ?? row.created_at" locale="zh-CN" date-style="medium" time-style="short" /></div>
        </div>

        <!-- 操作 -->
        <div class="mt-4 flex flex-wrap gap-2">
          <UButton color="neutral" variant="outline" size="sm" @click="openDetail(row)">
            <UIcon name="i-lucide-eye" class="size-3.5" />查看详情
          </UButton>
          <template v-if="row.status === 'pending_review'">
            <UButton color="primary" size="sm" :disabled="processingId !== null" @click="openResolve(row)">
              {{ row.content_type === "message" ? "记录处置" : "处置" }}
            </UButton>
            <UButton color="neutral" variant="outline" size="sm" :disabled="processingId !== null" @click="dismissItem(row)">驳回</UButton>
          </template>
        </div>
      </article>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="flex justify-center pt-2">
        <UPagination v-model:page="page" :items-per-page="perPage" :total="total" @update:page="onPageChange" />
      </div>
    </div>

    <!-- 详情弹窗（含私信聊天上下文） -->
    <UModal v-model:open="showDetail" title="审查详情" :ui="{ content: 'max-w-xl' }" :unmount-on-hide="true">
      <template #body>
        <div v-if="detailLoading" class="py-10 text-center text-sm text-text-secondary">加载中…</div>
        <div v-else-if="detailItem" class="space-y-4 py-2 text-sm">
          <div>
            <span class="mb-1 block text-xs text-text-muted">送审内容快照</span>
            <div class="whitespace-pre-wrap rounded-md border border-border bg-bg-page px-3 py-2 text-text-secondary">
              {{ detailItem.content_snapshot || "（空）" }}
            </div>
          </div>
          <div v-if="detailItem.content_type === 'message' && detailItem.context?.message" class="space-y-2">
            <span class="block text-xs text-text-muted">私信会话上下文</span>
            <div class="rounded-md bg-bg-page p-3">
              <div class="mb-2 text-xs text-text-secondary">
                会话双方：{{ detailItem.context.message.conversation?.user1.username ?? "?" }} ↔ {{ detailItem.context.message.conversation?.user2.username ?? "?" }}
              </div>
              <div class="max-h-[320px] space-y-1.5 overflow-y-auto">
                <div v-if="!detailItem.context.message.history?.length" class="text-xs text-text-muted">暂无更多消息</div>
                <div v-for="m in detailItem.context.message.history" :key="m.id" class="rounded px-2 py-1 text-xs" :class="m.id === detailItem.target_id ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-white/60'">
                  <span class="mr-1.5 font-semibold text-primary">{{ m.sender_name }}</span>
                  <span class="text-text-secondary">{{ m.recalled_at ? "（已撤回）" : "" }}{{ m.content || "[图片]" }}</span>
                  <span v-if="m.id === detailItem.target_id" class="ml-1.5 text-amber-700">← 送审消息</span>
                </div>
              </div>
            </div>
            <p class="text-xs text-text-muted">提示：私信处置仅记录留痕；如需封禁/禁言用户，请到「举报管理」提交举报后处理。</p>
          </div>
          <div v-else-if="detailItem.content_type !== 'message'" class="space-y-1 text-xs text-text-secondary">
            <div v-if="detailItem.context?.post?.author_username">作者：{{ detailItem.context.post.author_username }}</div>
            <div v-else-if="detailItem.context?.comment?.author_username">作者：{{ detailItem.context.comment.author_username }}</div>
            <div v-if="detailItem.context?.post">帖子当前状态：{{ detailItem.context.post.status }}</div>
            <div v-else-if="detailItem.context?.comment">评论当前状态：{{ detailItem.context.comment.status }}</div>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span>Provider：{{ providerLabel[detailItem.review_provider] ?? detailItem.review_provider }}</span>
            <span>判定：{{ verdictLabel[detailItem.verdict] ?? detailItem.verdict }}</span>
            <span v-if="detailItem.risk_level">风险：{{ detailItem.risk_level }}</span>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end">
          <UButton color="neutral" variant="ghost" @click="showDetail = false">关闭</UButton>
        </div>
      </template>
    </UModal>

    <!-- 处置弹窗 -->
    <UModal v-model:open="showResolve" title="处置审查记录" :description="resolveTarget ? `${typeLabel[resolveTarget.content_type]}：${resolveTarget.content_snapshot.slice(0, 80)}` : ''">
      <template #body>
        <div class="space-y-4 py-2">
          <template v-if="resolveTarget?.content_type !== 'message'">
            <label class="block">
              <span class="mb-1 block text-xs text-text-secondary">处置方式</span>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 text-sm">
                  <input v-model="resolveAction" type="radio" value="hide_content" class="accent-primary" />
                  隐藏违规内容
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input v-model="resolveAction" type="radio" value="record_only" class="accent-primary" />
                  仅记录（内容保留）
                </label>
              </div>
            </label>
          </template>
          <p v-else class="text-xs text-text-secondary">私信无公开内容可隐藏，本处置将仅记录留痕；如需封禁用户请走举报管理。</p>
          <label class="block">
            <span class="mb-1 block text-xs text-text-secondary">处置说明</span>
            <textarea v-model="resolveReason" class="min-h-20 w-full rounded border border-border px-3 py-2 text-sm" placeholder="例如：违反社区规范，隐藏处理" />
          </label>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showResolve = false">取消</UButton>
          <UButton color="primary" :disabled="processingId !== null" @click="submitResolve">{{ processingId !== null ? "处理中…" : "确认处置" }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
