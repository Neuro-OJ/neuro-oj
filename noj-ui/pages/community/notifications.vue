<script setup lang="ts">
import type { NotificationRow } from "~/composables/useCommunity"
import { extractApiError } from "~/utils/apiError"
import { useToast } from "~/composables/useToast"
import { publicUrl, userUrl } from "~/utils/publicIdentifiers"

definePageMeta({ middleware: "auth" })

const { toast } = useToast()
const { api } = useApi()
const { loadUnreadCount } = useCommunityNotifications()

const notifications = ref<NotificationRow[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const error = ref("")
const limit = ref(30)
const markingRead = ref(false)

const typeLabel: Record<NotificationRow["notification"]["type"], string> = {
  reply: "回复了你",
  like: "赞了你的内容",
  follow: "关注了你",
  moderation: "更新了内容审核状态",
  clarification: "回复了你的竞赛提问",
  report: "举报通知",
  ban: "封禁通知",
}
const typeIcon = {
  reply: 'i-lucide-reply',
  like: 'i-lucide-heart',
  follow: 'i-lucide-user-plus',
  moderation: 'i-lucide-shield-check',
  clarification: 'i-lucide-message-circle-question',
  report: 'i-lucide-flag',
  ban: 'i-lucide-ban',
}

async function load(reset = true) {
  if (reset) loading.value = true
  else loadingMore.value = true
  error.value = ""
  try {
    const result = await api.get<{ data: NotificationRow[] }>(
      "/api/v1/community/notifications",
      { query: { limit: limit.value }, silent: true },
    )
    notifications.value = result.data
  } catch (err: unknown) {
    error.value = extractApiError(err).message
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || limit.value >= 100) return
  limit.value = Math.min(limit.value + 30, 100)
  await load(false)
}

async function markAllRead() {
  if (markingRead.value || notifications.value.length === 0) return
  markingRead.value = true
  try {
    await api.post("/api/v1/community/notifications/read")
    toast.success("通知已标记为已读")
    await Promise.all([load(), loadUnreadCount()])
  } finally {
    markingRead.value = false
  }
}

function notificationHref(item: NotificationRow): string {
  if (item.notification.type === "report" && item.notification.data.report_id) {
    return `/community/reports/${item.notification.data.report_id}`
  }
  if (item.notification.post_id) return publicUrl("post", item.notification.post_id)
  if (item.notification.type === "follow" && item.actor) return userUrl(item.actor.username)
  if (item.notification.type === "clarification" && item.notification.data.contest_id) return `${publicUrl("contest", item.notification.data.contest_id as string)}?tab=clarifications`
  return "/community"
}

async function handleClick(item: NotificationRow) {
  // 点击即标记单条已读，不阻塞跳转
  if (!item.notification.read_at) {
    try {
      await api.post(`/api/v1/community/notifications/${item.notification.id}/read`, undefined, { silent: true })
      item.notification.read_at = new Date().toISOString()
      await loadUnreadCount()
    } catch {
      // 已读失败不阻塞跳转
    }
  }
  navigateTo(notificationHref(item))
}

await load()
</script>

<template>
  <main class="mx-auto w-full max-w-4xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between">
      <div><h1 class="text-2xl font-bold text-text">社区通知</h1><p class="mt-1 text-sm text-text-secondary">回复、互动和审核结果会保留在这里。</p></div>
      <UButton color="primary" variant="outline" :disabled="markingRead || notifications.length === 0" @click="markAllRead"><UIcon name="i-lucide-check-check" class="size-4" />{{ markingRead ? '处理中…' : '全部已读' }}</UButton>
    </div>
    <p v-if="error" class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{{ error }}</p>
    <div v-else-if="loading" class="py-12 text-center text-text-secondary">加载中…</div>
    <div v-else-if="notifications.length === 0" class="rounded-lg border border-dashed border-border p-10 text-text-secondary flex items-center justify-center gap-2"><UIcon name="i-lucide-bell" class="size-[28px]" />暂无通知。</div>
    <div v-else class="space-y-3">
      <button
        v-for="item in notifications"
        :key="item.notification.id"
        type="button"
        class="block w-full rounded-lg border border-border bg-white p-4 text-left no-underline shadow-card transition-colors hover:bg-primary-bg"
        :class="!item.notification.read_at && 'border-primary/40 bg-primary-bg/30'"
        @click="handleClick(item)"
      >
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-full" :class="item.notification.type === 'moderation' ? 'bg-red-50 text-red-600' : 'bg-primary-bg text-primary'">
            <UIcon :name="typeIcon[item.notification.type]" class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-text flex items-center gap-1"><template v-if="item.actor"><UserIdentity :user="item.actor" size="sm" /></template><template v-else><strong>系统</strong></template>{{ typeLabel[item.notification.type] }}</p>
            <p v-if="item.notification.data.message" class="mt-1 text-xs text-text-secondary">{{ item.notification.data.message }}</p>
            <p v-else-if="item.notification.data.reason" class="mt-1 text-xs text-text-secondary">{{ item.notification.data.reason }}</p>
            <p v-if="item.notification.type === 'ban'" class="mt-1 text-xs text-text-secondary">
              封禁范围：{{ item.notification.data.scope === "social" ? "仅限制社交功能" : "限制使用平台" }}。
              理由：{{ item.notification.data.reason || "（未填写）" }}。
              封禁时间：{{ item.notification.data.banned_at ? new Date(item.notification.data.banned_at).toLocaleString("zh-CN") : "" }}
              {{ item.notification.data.banned_until ? `，封禁至 ${new Date(item.notification.data.banned_until).toLocaleString("zh-CN")}` : "（永久封禁）" }}
            </p>
            <NuxtTime class="mt-1 block text-xs text-text-muted" :datetime="item.notification.created_at" relative locale="zh-CN" />
          </div>
        </div>
      </button>
      <div v-if="limit < 100" class="text-center">
        <UButton color="primary" variant="outline" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中…' : '加载更多' }}</UButton>
      </div>
    </div>
  </main>
</template>
