<script setup lang="ts">
import { Save, ShieldCheck, LayoutList, Flag, Search, MessageSquare } from "@lucide/vue"
import type { CommunityConfig, PostRow, ReportRow } from "~/composables/useCommunity"

definePageMeta({ layout: "admin", middleware: "community-moderation", ssr: false })

const { toast } = useToast()
const { dialog } = useDialog()
const { config, loadConfig } = useCommunity()

const preset = ref("private")
const applyingPreset = ref(false)
const savingKey = ref<string | null>(null)
const pendingPosts = ref<PostRow[]>([])
const loadingPending = ref(false)
const moderatingId = ref<string | null>(null)
const pendingComments = ref<Array<{
  comment: { id: string; post_id: string; author_id: string; content: string; status: string }
  author: { id: string; username: string }
  post_title: string | null
}>>([])
const loadingPendingComments = ref(false)
const moderatingCommentId = ref<string | null>(null)

const boards = ref<{ id: string; name: string; slug: string; description: string | null; is_archived: boolean }[]>([])
const newBoard = reactive({ slug: "", name: "", description: "" })
const creatingBoard = ref(false)

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

function configValue(configKey: string): unknown {
  return (config.value as CommunityConfig | null)?.[configKey as keyof CommunityConfig]
}

async function load() {
  const [boardResult, reportResult, sanctionResult] = await Promise.all([
    $fetch<{ data: { id: string; name: string; slug: string; description: string | null; is_archived: boolean }[] }>("/api/v1/community/boards"),
    $fetch<{ data: ReportRow[] }>("/api/v1/community/admin/reports"),
    $fetch<{ data: typeof sanctions.value }>("/api/v1/community/admin/sanctions"),
  ])
  boards.value = boardResult.data
  reports.value = reportResult.data
  sanctions.value = sanctionResult.data
  await Promise.all([loadPending(), loadPendingComments(), loadConfig(true)])
}

async function loadPending() {
  loadingPending.value = true
  try {
    const result = await $fetch<{ data: PostRow[] }>("/api/v1/community/posts", { query: { limit: 100 } })
    pendingPosts.value = result.data.filter((p) => p.post.status === "pending")
  } catch {
    pendingPosts.value = []
  } finally {
    loadingPending.value = false
  }
}

async function loadPendingComments() {
  loadingPendingComments.value = true
  try {
    const result = await $fetch<{ data: typeof pendingComments.value }>(
      "/api/v1/community/admin/comments/pending",
      { query: { limit: 100 } },
    )
    pendingComments.value = result.data
  } catch {
    pendingComments.value = []
  } finally {
    loadingPendingComments.value = false
  }
}

async function applyPreset() {
  if (applyingPreset.value) return
  applyingPreset.value = true
  try {
    await $fetch(`/api/v1/community/admin/preset/${preset.value}`, { method: "POST" })
    toast.success("社区预设已应用")
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "保存失败")
  } finally {
    applyingPreset.value = false
  }
}

async function toggleSetting(settingKey: string, configKey: string) {
  if (savingKey.value) return
  savingKey.value = settingKey
  try {
    const current = Boolean(configValue(configKey))
    await $fetch(`/api/v1/admin/settings/${settingKey}`, {
      method: "PUT",
      body: { value: !current },
    })
    toast.success("设置已更新")
    await loadConfig(true)
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "保存失败")
  } finally {
    savingKey.value = null
  }
}

const numberInputs = reactive<Record<string, number>>({})

async function saveNumber(settingKey: string, configKey: string) {
  const value = numberInputs[configKey]
  // 空输入（v-model.number 清空后为 ''）不应写 0
  if (value === undefined || value === "" || savingKey.value) return
  savingKey.value = settingKey
  try {
    await $fetch(`/api/v1/admin/settings/${settingKey}`, {
      method: "PUT",
      body: { value: Number(value) },
    })
    toast.success("设置已更新")
    await loadConfig(true)
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "保存失败")
  } finally {
    savingKey.value = null
  }
}

async function moderatePost(id: string, status: "published" | "hidden") {
  if (moderatingId.value) return
  moderatingId.value = id
  try {
    await $fetch(`/api/v1/community/admin/posts/${id}/${status}`, {
      method: "POST",
      body: { reason: "" },
    })
    toast.success(status === "published" ? "内容已批准" : "内容已驳回")
    await loadPending()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "操作失败")
  } finally {
    moderatingId.value = null
  }
}

async function moderateComment(id: string, status: "published" | "hidden") {
  if (moderatingCommentId.value) return
  moderatingCommentId.value = id
  try {
    await $fetch(`/api/v1/community/admin/comments/${id}/${status}`, {
      method: "POST",
      body: { reason: "" },
    })
    toast.success(status === "published" ? "评论已批准" : "评论已驳回")
    await loadPendingComments()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "操作失败")
  } finally {
    moderatingCommentId.value = null
  }
}

async function createBoard() {
  if (creatingBoard.value || !newBoard.slug || !newBoard.name) {
    if (!newBoard.slug || !newBoard.name) toast.warn("请填写板块 slug 和名称")
    return
  }
  creatingBoard.value = true
  try {
    await $fetch("/api/v1/community/admin/boards", {
      method: "POST",
      body: { slug: newBoard.slug, name: newBoard.name, description: newBoard.description },
    })
    toast.success("板块已创建")
    newBoard.slug = ""
    newBoard.name = ""
    newBoard.description = ""
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "创建失败")
  } finally {
    creatingBoard.value = false
  }
}

async function toggleArchive(boardId: string, archived: boolean) {
  try {
    await $fetch(`/api/v1/community/admin/boards/${boardId}`, {
      method: "PATCH",
      body: { is_archived: !archived },
    })
    toast.success(archived ? "板块已恢复" : "板块已归档")
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "操作失败")
  }
}

async function resolveReport(id: string, status: "resolved" | "dismissed") {
  if (resolvingReportId.value) return
  resolvingReportId.value = id
  try {
    await $fetch(`/api/v1/community/admin/reports/${id}/${status}`, { method: "POST", body: {} })
    toast.success("举报已处理")
    await load()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "处理失败")
  } finally {
    resolvingReportId.value = null
  }
}

async function searchSanctionUser() {
  const q = sanctionUserQuery.value.trim()
  if (q.length < 2) {
    sanctionUserResults.value = []
    return
  }
  searchingSanctionUser.value = true
  try {
    const result = await $fetch<{ data: { items: { id: string; username: string }[] } }>(
      "/api/v1/search",
      { query: { q, type: "user" } },
    )
    sanctionUserResults.value = result.data.items
  } catch {
    sanctionUserResults.value = []
  } finally {
    searchingSanctionUser.value = false
  }
}

async function selectSanctionUser(u: { id: string; username: string }) {
  selectedSanctionUser.value = u
  sanctionUserQuery.value = u.username
  sanctionUserResults.value = []
  await loadUserSanctions(u.id)
}

async function loadUserSanctions(userId?: string) {
  if (!userId) {
    userSanctions.value = []
    return
  }
  try {
    const result = await $fetch<{ data: typeof userSanctions.value }>(
      `/api/v1/community/admin/users/${userId}/sanctions`,
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
    await $fetch("/api/v1/community/admin/sanctions", {
      method: "POST",
      body: {
        user_id: selectedSanctionUser.value.id,
        reason: sanctionReason.value,
        expires_at: sanctionExpiresAt.value || null,
      },
    })
    toast.success("处罚已生效")
    sanctionReason.value = ""
    sanctionExpiresAt.value = ""
    await Promise.all([load(), loadUserSanctions(selectedSanctionUser.value.id)])
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "创建失败")
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
    await $fetch(`/api/v1/community/admin/sanctions/${sanctionId}`, { method: "DELETE" })
    toast.success("已撤销")
    await Promise.all([load(), loadUserSanctions(selectedSanctionUser.value?.id)])
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "撤销失败")
  } finally {
    revokingId.value = null
  }
}

function configBoolean(configKey: string): boolean {
  return configValue(configKey) === true
}

await load()
</script>

<template>
  <div class="space-y-6 p-6">
    <div><h1 class="text-2xl font-bold text-text">社区管理</h1><p class="mt-1 text-sm text-text-secondary">配置私域策略、独立开关，处理待审内容、举报与处罚。</p></div>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><ShieldCheck :size="18" /><h2 class="font-semibold">部署预设</h2></div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <select v-model="preset" class="rounded border border-border px-3 py-2" :disabled="applyingPreset">
          <option value="public">公开社区</option>
          <option value="private">私域社区</option>
          <option value="knowledge">只读知识库</option>
        </select>
        <button class="btn-primary" :disabled="applyingPreset" @click="applyPreset"><Save :size="16" />{{ applyingPreset ? '应用中…' : '应用预设' }}</button>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><ShieldCheck :size="18" /><h2 class="font-semibold">独立开关</h2></div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="item in BOOLEAN_SETTINGS" :key="item.settingKey" class="flex items-center justify-between gap-3 rounded border border-border p-3">
          <div>
            <p class="text-sm font-medium">{{ item.label }}</p>
            <p v-if="item.hint" class="mt-0.5 text-xs text-text-muted">{{ item.hint }}</p>
          </div>
          <button
            type="button"
            class="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors"
            :class="configBoolean(item.configKey) ? 'bg-primary' : 'bg-gray-300'"
            :disabled="savingKey !== null"
            :aria-label="item.label"
            @click="toggleSetting(item.settingKey, item.configKey)"
          >
            <span class="inline-block size-3.5 transform rounded-full bg-white shadow transition-transform" :class="configBoolean(item.configKey) ? 'translate-x-4' : 'translate-x-1'" />
          </button>
        </div>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div v-for="item in NUMBER_SETTINGS" :key="item.settingKey" class="rounded border border-border p-3">
          <p class="text-sm font-medium">{{ item.label }}</p>
          <div class="mt-2 flex items-center gap-2">
            <input
              v-model.number="numberInputs[item.configKey]"
              type="number"
              min="0"
              class="w-32 rounded border border-border px-2 py-1 text-sm"
              :placeholder="String(configValue(item.configKey) ?? '')"
            >
            <span class="text-xs text-text-muted">{{ item.suffix }}</span>
            <button class="btn-outline text-xs" :disabled="savingKey !== null || numberInputs[item.configKey] === undefined" @click="saveNumber(item.settingKey, item.configKey)">保存</button>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><Flag :size="18" /><h2 class="font-semibold">待审内容</h2></div>
      <div v-if="loadingPending" class="py-6 text-sm text-text-secondary">加载中…</div>
      <div v-else-if="pendingPosts.length === 0" class="py-6 text-sm text-text-secondary">暂无待审内容。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="item in pendingPosts" :key="item.post.id" class="rounded border border-border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ item.post.title || '（无标题）' }}</p>
              <p class="mt-1 line-clamp-2 text-sm text-text-secondary">{{ item.post.content }}</p>
              <p class="mt-1 text-xs text-text-muted">{{ item.author.username }} · {{ item.post.type }}</p>
            </div>
            <div class="flex flex-shrink-0 gap-2">
              <button class="btn-primary text-sm" :disabled="moderatingId !== null" @click="moderatePost(item.post.id, 'published')">{{ moderatingId === item.post.id ? '处理中…' : '批准' }}</button>
              <button class="btn-outline text-sm" :disabled="moderatingId !== null" @click="moderatePost(item.post.id, 'hidden')">驳回</button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><MessageSquare :size="18" /><h2 class="font-semibold">待审评论</h2></div>
      <div v-if="loadingPendingComments" class="py-6 text-sm text-text-secondary">加载中…</div>
      <div v-else-if="pendingComments.length === 0" class="py-6 text-sm text-text-secondary">暂无待审评论。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="item in pendingComments" :key="item.comment.id" class="rounded border border-border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="line-clamp-2 text-sm text-text-secondary">{{ item.comment.content }}</p>
              <p class="mt-1 text-xs text-text-muted">{{ item.author.username }} 评论了「{{ item.post_title || '（无标题）' }}」</p>
            </div>
            <div class="flex flex-shrink-0 gap-2">
              <button class="btn-primary text-sm" :disabled="moderatingCommentId !== null" @click="moderateComment(item.comment.id, 'published')">{{ moderatingCommentId === item.comment.id ? '处理中…' : '批准' }}</button>
              <button class="btn-outline text-sm" :disabled="moderatingCommentId !== null" @click="moderateComment(item.comment.id, 'hidden')">驳回</button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><Flag :size="18" /><h2 class="font-semibold">待处理举报</h2></div>
      <div v-if="reports.length === 0" class="py-6 text-sm text-text-secondary">暂无待处理举报。</div>
      <div v-else class="mt-4 space-y-3">
        <article v-for="report in reports" :key="report.id" class="rounded border border-border p-3">
          <p class="text-sm font-medium">{{ report.reason }}</p>
          <p class="mt-1 line-clamp-2 text-sm text-text-secondary">{{ report.content_snapshot }}</p>
          <div class="mt-3 flex gap-2">
            <button class="btn-primary text-sm" :disabled="resolvingReportId !== null" @click="resolveReport(report.id, 'resolved')">{{ resolvingReportId === report.id ? '处理中…' : '标记已处理' }}</button>
            <button class="btn-outline text-sm" :disabled="resolvingReportId !== null" @click="resolveReport(report.id, 'dismissed')">驳回</button>
          </div>
        </article>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><ShieldCheck :size="18" /><h2 class="font-semibold">处罚管理（社区禁言）</h2></div>
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p class="text-sm font-medium">选择用户</p>
          <div class="relative mt-2">
            <div class="relative">
              <Search class="absolute left-2.5 top-2.5 text-text-secondary" :size="15" />
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
            <button class="btn-primary" :disabled="creatingSanction || !selectedSanctionUser || !sanctionReason.trim()" @click="createSanction">{{ creatingSanction ? '创建中…' : '施加禁言' }}</button>
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
              <button class="btn-outline text-xs text-red-600" :disabled="revokingId !== null" @click="revokeSanction(s.id)">{{ revokingId === s.id ? '处理中…' : '撤销' }}</button>
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

    <section class="rounded-lg border border-border bg-white p-5 shadow-card">
      <div class="flex items-center gap-2"><LayoutList :size="18" /><h2 class="font-semibold">讨论板块</h2></div>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <article v-for="board in boards" :key="board.id" class="rounded border border-border p-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h3 class="font-medium">{{ board.name }}</h3>
              <p class="mt-1 text-sm text-text-secondary">{{ board.description || '暂无描述' }}</p>
              <p class="mt-1 text-xs text-text-muted">{{ board.slug }}</p>
            </div>
            <button class="btn-outline text-xs" @click="toggleArchive(board.id, board.is_archived)">{{ board.is_archived ? '恢复' : '归档' }}</button>
          </div>
        </article>
      </div>
      <div class="mt-4 rounded border border-dashed border-border p-3">
        <p class="text-sm font-medium">新建板块</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <input v-model="newBoard.slug" class="w-32 rounded border border-border px-2 py-1 text-sm" placeholder="slug">
          <input v-model="newBoard.name" class="w-40 rounded border border-border px-2 py-1 text-sm" placeholder="名称">
          <input v-model="newBoard.description" class="w-52 flex-1 rounded border border-border px-2 py-1 text-sm" placeholder="描述（可选）">
          <button class="btn-primary text-sm" :disabled="creatingBoard" @click="createBoard">{{ creatingBoard ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </section>
  </div>
</template>

