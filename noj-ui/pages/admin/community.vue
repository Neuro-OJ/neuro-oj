<script setup lang="ts">
import type { CommunityConfig, PostRow, ReportRow } from "~/composables/useCommunity"
import { extractApiError } from '~/utils/apiError'

definePageMeta({ layout: "admin", middleware: "community-moderation", ssr: false })

const { toast } = useToast()
const { dialog } = useDialog()
const { config, loadConfig } = useCommunity()
const { api } = useApi()

// 预设选择存前端（localStorage），应用时仅更新页面配置草稿
const PRESET_STORAGE_KEY = "noj:community:preset"
const preset = ref("private")

// ─── 社区预设（前端定义，镜像后端 PRESETS；仅覆盖布尔开关）───
type CommunityPresetName = "public" | "private" | "knowledge"

const COMMUNITY_PRESETS: Record<CommunityPresetName, { label: string; values: Record<string, boolean> }> = {
  public: {
    label: "公开社区",
    values: {
      community_enabled: true,
      community_guest_read_enabled: true,
      community_read_only: false,
      community_solutions_enabled: true,
      community_discussions_enabled: true,
      community_moments_enabled: true,
      community_activities_enabled: true,
      community_comments_enabled: true,
      community_reactions_enabled: true,
      community_bookmarks_enabled: true,
      community_follows_enabled: true,
      private_messaging_enabled: true,
      community_external_images_enabled: true,
    },
  },
  private: {
    label: "私域社区",
    values: {
      community_enabled: true,
      community_guest_read_enabled: false,
      community_read_only: false,
      community_solutions_enabled: true,
      community_discussions_enabled: true,
      community_moments_enabled: true,
      community_activities_enabled: true,
      community_comments_enabled: true,
      community_reactions_enabled: true,
      community_bookmarks_enabled: true,
      community_follows_enabled: true,
      private_messaging_enabled: true,
      community_external_images_enabled: false,
    },
  },
  knowledge: {
    label: "只读知识库",
    values: {
      community_enabled: true,
      community_guest_read_enabled: false,
      community_read_only: true,
      community_solutions_enabled: true,
      community_discussions_enabled: true,
      community_moments_enabled: false,
      community_activities_enabled: false,
      community_comments_enabled: false,
      community_reactions_enabled: false,
      community_bookmarks_enabled: false,
      community_follows_enabled: false,
      private_messaging_enabled: false,
      community_external_images_enabled: false,
    },
  },
}

// 页面加载时恢复上次选择的预设（localStorage，仅客户端）
if (import.meta.client) {
  const saved = localStorage.getItem(PRESET_STORAGE_KEY)
  if (saved && saved in COMMUNITY_PRESETS) preset.value = saved
}
watch(preset, (val) => {
  if (import.meta.client) localStorage.setItem(PRESET_STORAGE_KEY, val)
})

const applyingPreset = ref(false)
const savingAll = ref(false)
const pendingPosts = ref<PostRow[]>([])
const loadingPending = ref(false)
const moderatingId = ref<string | null>(null)

// 自动轮询间隔（默认 30s，可由刷新控制条切换/关闭；待审/举报/处罚随刷新更新）
const pollInterval = ref<number | null>(30000)
const lastRefresh = ref<Date | null>(null)
const pendingComments = ref<Array<{
  comment: { id: string; post_id: string; author_id: string; content: string; status: string }
  author: { id: string; username: string }
  post_title: string | null
}>>([])
const loadingPendingComments = ref(false)
const moderatingCommentId = ref<string | null>(null)

const reports = ref<ReportRow[]>([])
const resolvingReportId = ref<string | null>(null)

const sanctions = ref<Array<{ id: string; user_id: string; reason: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; created_at: string }>>([])
const sanctionUserQuery = ref("")
const sanctionUserResults = ref<{ id: string; username: string }[]>([])
const searchingSanctionUser = ref(false)
const selectedSanctionUser = ref<{ id: string; username: string } | null>(null)
const sanctionReason = ref("")
const sanctionExpiresAt = ref("")
const userSanctions = ref<Array<{ id: string; reason: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; created_at: string }>>([])
const creatingSanction = ref(false)
const revokingId = ref<string | null>(null)

/** 布尔开关：configKey 为 config 响应字段，settingKey 为系统设置键 */
const BOOLEAN_SETTINGS: Array<{ configKey: string; settingKey: string; label: string; hint?: string }> = [
  { configKey: "enabled", settingKey: "community_enabled", label: "社区总开关" },
  { configKey: "guest_read_enabled", settingKey: "community_guest_read_enabled", label: "游客阅读", hint: "关闭后未登录用户无法读取社区内容" },
  { configKey: "read_only", settingKey: "community_read_only", label: "只读模式", hint: "开启后普通用户不可发布内容" },
  { configKey: "solutions_enabled", settingKey: "community_solutions_enabled", label: "题解模块" },
  { configKey: "discussions_enabled", settingKey: "community_discussions_enabled", label: "讨论模块" },
  { configKey: "moments_enabled", settingKey: "community_moments_enabled", label: "动态模块" },
  { configKey: "activities_enabled", settingKey: "community_activities_enabled", label: "系统活动" },
  { configKey: "comments_enabled", settingKey: "community_comments_enabled", label: "评论" },
  { configKey: "reactions_enabled", settingKey: "community_reactions_enabled", label: "点赞" },
  { configKey: "bookmarks_enabled", settingKey: "community_bookmarks_enabled", label: "收藏" },
  { configKey: "follows_enabled", settingKey: "community_follows_enabled", label: "关注" },
  { configKey: "private_messaging_enabled", settingKey: "private_messaging_enabled", label: "站内私信" },
  { configKey: "external_images_enabled", settingKey: "community_external_images_enabled", label: "外链图片" },
  { configKey: "solution_requires_accepted", settingKey: "community_solution_requires_accepted", label: "题解通过门槛", hint: "题解发布前必须已 Accepted" },
]

const NUMBER_SETTINGS: Array<{ configKey: string; settingKey: string; label: string; suffix: string }> = [
  { configKey: "new_user_review_hours", settingKey: "community_new_user_review_hours", label: "新用户预审窗口", suffix: "小时" },
  { configKey: "post_max_length", settingKey: "community_post_max_length", label: "帖子最大长度", suffix: "字符" },
  { configKey: "moment_max_length", settingKey: "community_moment_max_length", label: "动态最大长度", suffix: "字符" },
  { configKey: "comment_max_length", settingKey: "community_comment_max_length", label: "评论最大长度", suffix: "字符" },
  { configKey: "post_interval_seconds", settingKey: "community_post_interval_seconds", label: "发布频率限制", suffix: "秒" },
]

/** silent=true 用于轮询：不置加载态、不清空已有数据，失败保留旧数据 */
async function load(silent = false) {
  const [reportResult, sanctionResult] = await Promise.all([
    api.get<{ data: ReportRow[] }>("/api/v1/community/admin/reports", { silent: true }),
    api.get<{ data: typeof sanctions.value }>("/api/v1/community/admin/sanctions", { silent: true }),
  ])
  reports.value = reportResult.data
  sanctions.value = sanctionResult.data
  await Promise.all([loadPending(silent), loadPendingComments(silent), loadConfig(true)])
  lastRefresh.value = new Date()
}

// 待审内容自动轮询
usePolling({
  intervalMs: pollInterval,
  fetcher: () => load(true),
  immediate: false,
})

async function loadPending(silent = false) {
  if (!silent) loadingPending.value = true
  try {
    const result = await api.get<{ data: PostRow[] }>("/api/v1/community/posts", { query: { limit: 100 }, silent: true })
    pendingPosts.value = result.data.filter((p) => p.post.status === "pending")
  } catch {
    // 轮询失败保留旧数据，仅首载失败清空
    if (!silent) pendingPosts.value = []
  } finally {
    if (!silent) loadingPending.value = false
  }
}

async function loadPendingComments(silent = false) {
  if (!silent) loadingPendingComments.value = true
  try {
    const result = await api.get<{ data: typeof pendingComments.value }>(
      "/api/v1/community/admin/comments/pending",
      { query: { limit: 100 }, silent: true },
    )
    pendingComments.value = result.data
  } catch {
    // 轮询失败保留旧数据，仅首载失败清空
    if (!silent) pendingComments.value = []
  } finally {
    if (!silent) loadingPendingComments.value = false
  }
}

// ─── 配置草稿（本地编辑 + 统一保存，未保存状态有明确标识）──────
const numberInputs = reactive<Record<string, number | string>>({})

/** 布尔开关草稿：以 configKey 为键，未编辑的项不存在 */
const booleanDrafts = reactive<Record<string, boolean>>({})

function configValue(configKey: string): unknown {
  return (config.value as CommunityConfig | null)?.[configKey as keyof CommunityConfig]
}

function isBooleanDirty(configKey: string): boolean {
  const draft = booleanDrafts[configKey]
  if (draft === undefined) return false
  return draft !== Boolean(configValue(configKey))
}

function isNumberDirty(configKey: string): boolean {
  const draft = numberInputs[configKey]
  if (draft === undefined || draft === "") return false
  return Number(draft) !== Number(configValue(configKey))
}

const hasUnsaved = computed(() =>
  BOOLEAN_SETTINGS.some((item) => isBooleanDirty(item.configKey)) ||
  NUMBER_SETTINGS.some((item) => isNumberDirty(item.configKey)),
)

/** 应用预设：仅更新前端页面草稿（不调用后端 preset API），进入未保存状态 */
function applyPreset() {
  const p = COMMUNITY_PRESETS[preset.value as CommunityPresetName]
  if (!p || applyingPreset.value) return
  applyingPreset.value = true
  try {
    for (const item of BOOLEAN_SETTINGS) {
      const target = p.values[item.settingKey]
      if (target !== undefined) booleanDrafts[item.configKey] = target
    }
    toast.info(`已应用预设「${p.label}」，请点击"保存更改"生效`)
  } finally {
    applyingPreset.value = false
  }
}

/** 切换开关：仅改本地草稿，不立即写后端 */
function toggleSetting(_settingKey: string, configKey: string) {
  const current = booleanDrafts[configKey] ?? Boolean(configValue(configKey))
  booleanDrafts[configKey] = !current
}

/** 保存全部未保存更改（逐项 PUT；空输入跳过） */
async function saveAll() {
  if (savingAll.value || !hasUnsaved.value) return
  savingAll.value = true
  try {
    const dirty: Array<{ key: string; value: unknown }> = []
    for (const item of BOOLEAN_SETTINGS) {
      if (isBooleanDirty(item.configKey)) dirty.push({ key: item.settingKey, value: booleanDrafts[item.configKey] })
    }
    for (const item of NUMBER_SETTINGS) {
      if (isNumberDirty(item.configKey)) dirty.push({ key: item.settingKey, value: Number(numberInputs[item.configKey]) })
    }
    // 逐项写入后端（无批量端点，逐项 PUT 与既有设置保存机制一致）
    for (const { key, value } of dirty) {
      await api.put(`/api/v1/admin/settings/${key}`, { value }, { silent: true })
    }
    // 清除草稿并刷新后端权威配置
    for (const key of Object.keys(booleanDrafts)) delete booleanDrafts[key]
    for (const key of Object.keys(numberInputs)) delete numberInputs[key]
    await loadConfig(true)
    toast.success(`已保存 ${dirty.length} 项更改`)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  } finally {
    savingAll.value = false
  }
}

/** 放弃全部未保存更改：恢复为后端当前值 */
function discardAll() {
  if (savingAll.value) return
  for (const key of Object.keys(booleanDrafts)) delete booleanDrafts[key]
  for (const key of Object.keys(numberInputs)) delete numberInputs[key]
  toast.info("已放弃未保存的更改")
}

async function moderatePost(id: string, status: "published" | "hidden") {
  if (moderatingId.value) return
  moderatingId.value = id
  try {
    await api.post(`/api/v1/community/admin/posts/${id}/${status}`, { reason: "" })
    toast.success(status === "published" ? "内容已批准" : "内容已驳回")
    await loadPending()
  } finally {
    moderatingId.value = null
  }
}

async function moderateComment(id: string, status: "published" | "hidden") {
  if (moderatingCommentId.value) return
  moderatingCommentId.value = id
  try {
    await api.post(`/api/v1/community/admin/comments/${id}/${status}`, { reason: "" })
    toast.success(status === "published" ? "评论已批准" : "评论已驳回")
    await loadPendingComments()
  } finally {
    moderatingCommentId.value = null
  }
}

async function resolveReport(id: string, status: "resolved" | "dismissed") {
  if (resolvingReportId.value) return
  resolvingReportId.value = id
  try {
    await api.post(`/api/v1/community/admin/reports/${id}/${status}`, {})
    toast.success("举报已处理")
    await load()
  } finally {
    resolvingReportId.value = null
  }
}

// 用户搜索防抖（300ms）+ 请求序号（过期回调跳过写入，避免旧响应覆盖新结果）
let sanctionSearchTimer: ReturnType<typeof setTimeout> | undefined
let sanctionSearchVersion = 0

async function searchSanctionUser() {
  clearTimeout(sanctionSearchTimer)
  const q = sanctionUserQuery.value.trim()
  if (q.length < 2) {
    sanctionUserResults.value = []
    return
  }
  sanctionSearchTimer = setTimeout(async () => {
    const currentRequest = ++sanctionSearchVersion
    searchingSanctionUser.value = true
    try {
      const result = await api.get<{ data: { items: { id: string; username: string }[] } }>(
        "/api/v1/search",
        { query: { q, type: "user" }, silent: true },
      )
      if (currentRequest !== sanctionSearchVersion) return
      sanctionUserResults.value = result.data.items
    } catch {
      if (currentRequest !== sanctionSearchVersion) return
      sanctionUserResults.value = []
    } finally {
      if (currentRequest === sanctionSearchVersion) searchingSanctionUser.value = false
    }
  }, 300)
}

async function selectSanctionUser(u: { id: string; username: string }) {
  selectedSanctionUser.value = u
  sanctionUserQuery.value = u.username
  sanctionUserResults.value = []
  await loadUserSanctions(u.username)
}

async function loadUserSanctions(userId?: string) {
  if (!userId) {
    userSanctions.value = []
    return
  }
  try {
    const result = await api.get<{ data: typeof userSanctions.value }>(
      `/api/v1/community/admin/users/${userId}/sanctions`,
      { silent: true },
    )
    userSanctions.value = result.data
  } catch {
    userSanctions.value = []
  }
}

async function createSanction() {
  if (creatingSanction.value || !selectedSanctionUser.value || !sanctionReason.value.trim()) {
    if (!selectedSanctionUser.value || !sanctionReason.value.trim()) toast.warn("请选择用户并填写原因")
    return
  }
  creatingSanction.value = true
  try {
    await api.post("/api/v1/community/admin/sanctions", {
      user_id: selectedSanctionUser.value.username,
      reason: sanctionReason.value,
      expires_at: sanctionExpiresAt.value || null,
    })
    toast.success("处罚已生效")
    sanctionReason.value = ""
    sanctionExpiresAt.value = ""
    await Promise.all([load(), loadUserSanctions(selectedSanctionUser.value.username)])
  } finally {
    creatingSanction.value = false
  }
}

async function revokeSanction(sanctionId: string) {
  const ok = await dialog.confirm("确定撤销该处罚吗？", {
    title: "撤销处罚",
    danger: true,
    confirmText: "撤销",
  })
  if (!ok || revokingId.value) return
  revokingId.value = sanctionId
  try {
    await api.delete(`/api/v1/community/admin/sanctions/${sanctionId}`)
    toast.success("已撤销")
    await Promise.all([load(), loadUserSanctions(selectedSanctionUser.value?.id)])
  } finally {
    revokingId.value = null
  }
}

function configBoolean(configKey: string): boolean {
  return configValue(configKey) === true
}

/** 开关显示值：草稿优先，无草稿则取后端配置 */
function switchValue(configKey: string): boolean {
  return booleanDrafts[configKey] ?? configBoolean(configKey)
}

await load()
</script>

<template>
  <div class="space-y-6 p-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-text">社区管理</h1>
        <p class="mt-1 text-sm text-text-secondary">配置私域策略、独立开关，处理待审内容、举报与处罚。</p>
      </div>
      <RefreshControl
        v-model:interval="pollInterval"
        :last-refresh="lastRefresh"
        @refresh="load()"
      />
    </div>

    <!-- 未保存更改标识（明确提示 + 保存/放弃） -->
    <div v-if="hasUnsaved" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg">
      <UIcon name="i-lucide-triangle-alert" class="size-4 text-amber-600 shrink-0" />
      <span class="text-sm font-medium text-amber-800">有未保存的更改</span>
      <div class="ml-auto flex items-center gap-2">
        <UButton size="xs" color="primary" :loading="savingAll" @click="saveAll">保存更改</UButton>
        <UButton size="xs" color="neutral" variant="outline" :disabled="savingAll" @click="discardAll">放弃更改</UButton>
      </div>
    </div>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-shield-check" class="size-4.5" /><h2 class="font-semibold">部署预设</h2></div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <USelect v-model="preset" :items="[{ label: '公开社区', value: 'public' }, { label: '私域社区', value: 'private' }, { label: '只读知识库', value: 'knowledge' }]" :disabled="applyingPreset" class="min-w-[140px]" />
        <UButton color="primary" :disabled="applyingPreset" @click="applyPreset"><UIcon name="i-lucide-save" class="size-4" />{{ applyingPreset ? '应用中…' : '应用预设' }}</UButton>
        <span class="text-xs text-text-muted">预设仅写入本页草稿，点击"保存更改"生效</span>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-shield-check" class="size-4.5" /><h2 class="font-semibold">独立开关</h2></div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="item in BOOLEAN_SETTINGS" :key="item.settingKey" class="flex items-center justify-between gap-3 rounded border p-3" :class="isBooleanDirty(item.configKey) ? 'border-amber-400 bg-amber-50/40' : 'border-border'">
          <div>
            <p class="text-sm font-medium">{{ item.label }}</p>
            <p v-if="item.hint" class="mt-0.5 text-xs text-text-muted">{{ item.hint }}</p>
          </div>
          <button
            type="button"
            class="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors"
            :class="switchValue(item.configKey) ? 'bg-primary' : 'bg-gray-300'"
            :disabled="savingAll"
            :aria-label="item.label"
            @click="toggleSetting(item.settingKey, item.configKey)"
          >
            <span class="inline-block size-3.5 transform rounded-full bg-white shadow transition-transform" :class="switchValue(item.configKey) ? 'translate-x-4' : 'translate-x-1'" />
          </button>
        </div>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div v-for="item in NUMBER_SETTINGS" :key="item.settingKey" class="rounded border p-3" :class="isNumberDirty(item.configKey) ? 'border-amber-400 bg-amber-50/40' : 'border-border'">
          <p class="text-sm font-medium">{{ item.label }}</p>
          <div class="mt-2 flex items-center gap-2">
            <input
              v-model.number="numberInputs[item.configKey]"
              type="number"
              min="0"
              class="w-32 rounded border border-border px-2 py-1 text-sm"
              :placeholder="String(configValue(item.configKey) ?? '')"
              :disabled="savingAll"
            >
            <span class="text-xs text-text-muted">{{ item.suffix }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-flag" class="size-4.5" /><h2 class="font-semibold">待审内容</h2></div>
      <div v-if="loadingPending" class="py-6 text-sm text-text-secondary">加载中…</div>
      <div v-else-if="pendingPosts.length === 0" class="py-6 text-sm text-text-secondary">暂无待审内容。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="item in pendingPosts" :key="item.post.id" class="rounded border border-border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ item.post.title || '（无标题）' }}</p>
              <p class="mt-1 line-clamp-2 text-sm text-text-secondary">{{ item.post.content }}</p>
              <p class="mt-1 text-xs text-text-muted flex items-center gap-1.5"><UserIdentity :user="item.author" size="sm" /> · {{ item.post.type }}</p>
            </div>
            <div class="flex flex-shrink-0 gap-2">
              <UButton color="primary" class="text-sm" :disabled="moderatingId !== null" @click="moderatePost(item.post.id, 'published')">{{ moderatingId === item.post.id ? '处理中…' : '批准' }}</UButton>
              <UButton color="primary" variant="outline" class="text-sm" :disabled="moderatingId !== null" @click="moderatePost(item.post.id, 'hidden')">驳回</UButton>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-message-square" class="size-4.5" /><h2 class="font-semibold">待审评论</h2></div>
      <div v-if="loadingPendingComments" class="py-6 text-sm text-text-secondary">加载中…</div>
      <div v-else-if="pendingComments.length === 0" class="py-6 text-sm text-text-secondary">暂无待审评论。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="item in pendingComments" :key="item.comment.id" class="rounded border border-border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="line-clamp-2 text-sm text-text-secondary">{{ item.comment.content }}</p>
              <p class="mt-1 text-xs text-text-muted flex items-center gap-1.5"><UserIdentity :user="item.author" size="sm" /> 评论了「{{ item.post_title || '（无标题）' }}」</p>
            </div>
            <div class="flex flex-shrink-0 gap-2">
              <UButton color="primary" class="text-sm" :disabled="moderatingCommentId !== null" @click="moderateComment(item.comment.id, 'published')">{{ moderatingCommentId === item.comment.id ? '处理中…' : '批准' }}</UButton>
              <UButton color="primary" variant="outline" class="text-sm" :disabled="moderatingCommentId !== null" @click="moderateComment(item.comment.id, 'hidden')">驳回</UButton>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-flag" class="size-4.5" /><h2 class="font-semibold">待处理举报</h2></div>
      <div v-if="reports.length === 0" class="py-6 text-sm text-text-secondary">暂无待处理举报。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="report in reports" :key="report.id" class="rounded border border-border p-3">
          <p class="text-sm font-medium">{{ report.reason }}</p>
          <p class="mt-1 line-clamp-2 text-sm text-text-secondary">{{ report.content_snapshot }}</p>
          <div class="mt-3 flex gap-2">
            <UButton color="primary" class="text-sm" :disabled="resolvingReportId !== null" @click="resolveReport(report.id, 'resolved')">{{ resolvingReportId === report.id ? '处理中…' : '标记已处理' }}</UButton>
            <UButton color="primary" variant="outline" class="text-sm" :disabled="resolvingReportId !== null" @click="resolveReport(report.id, 'dismissed')">驳回</UButton>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-shield-check" class="size-4.5" /><h2 class="font-semibold">处罚管理（社区禁言）</h2></div>
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p class="text-sm font-medium">选择用户</p>
          <div class="relative mt-2">
            <div class="relative">
              <UIcon name="i-lucide-search" class="absolute left-2.5 top-2.5 text-text-secondary size-3.5" />
              <input v-model="sanctionUserQuery" class="w-full rounded border border-border py-2 pl-8 pr-3 text-sm" placeholder="搜索用户名（至少 2 个字符）" @input="searchSanctionUser">
            </div>
            <ul v-if="sanctionUserResults.length > 0" class="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded border border-border bg-white shadow-modal">
              <li v-for="u in sanctionUserResults" :key="u.id" class="cursor-pointer px-3 py-2 text-sm hover:bg-primary-bg" @mousedown.prevent="selectSanctionUser(u)">{{ u.username }}</li>
            </ul>
          </div>
          <p v-if="searchingSanctionUser" class="mt-1 text-xs text-text-muted">搜索中…</p>
          <p v-if="selectedSanctionUser" class="mt-2 text-sm text-text-secondary">已选择：<strong class="text-text">{{ selectedSanctionUser.username }}</strong></p>
          <div class="mt-3 space-y-2">
            <textarea v-model="sanctionReason" class="min-h-16 w-full rounded border border-border px-3 py-2 text-sm" placeholder="处罚原因" />
            <label class="block text-sm"><span class="mb-1 block text-xs text-text-secondary">截止时间（留空为永久）</span><input v-model="sanctionExpiresAt" type="datetime-local" class="w-full rounded border border-border px-3 py-2 text-sm"></label>
            <UButton color="primary" :disabled="creatingSanction || !selectedSanctionUser || !sanctionReason.trim()" @click="createSanction">{{ creatingSanction ? '创建中…' : '施加禁言' }}</UButton>
          </div>
        </div>
        <div>
          <p class="text-sm font-medium">当前处罚</p>
          <div v-if="sanctions.length === 0" class="py-4 text-sm text-text-secondary">暂无生效处罚。</div>
          <ul v-else class="mt-2 space-y-2">
            <li v-for="s in sanctions" :key="s.id" class="flex items-center justify-between gap-2 rounded border border-border p-2 text-sm">
              <div>
                <p class="font-medium">{{ s.user_id }}</p>
                <p class="text-xs text-text-secondary">{{ s.reason }} · {{ s.expires_at ? `截止 ${s.expires_at}` : '永久' }}</p>
              </div>
              <UButton color="primary" variant="outline" class="text-xs text-red-600" :disabled="revokingId !== null" @click="revokeSanction(s.id)">{{ revokingId === s.id ? '处理中…' : '撤销' }}</UButton>
            </li>
          </ul>
          <p class="mt-4 text-sm font-medium">用户处罚历史</p>
          <div v-if="userSanctions.length === 0" class="py-4 text-sm text-text-secondary">选中用户后可查看其全部处罚记录。</div>
          <ul v-else class="mt-2 space-y-2">
            <li v-for="s in userSanctions" :key="s.id" class="rounded border border-border p-2 text-sm">
              <p class="font-medium">{{ s.reason }}</p>
              <p class="text-xs text-text-secondary">
                {{ s.revoked_at ? '已撤销' : (s.expires_at ? `截止 ${s.expires_at}` : '永久') }} · 创建于 <NuxtTime :datetime="s.created_at" relative locale="zh-CN" />
              </p>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 讨论板块（独立子组件，状态自持） -->
    <CommunityBoardsSection />
  </div>
</template>

