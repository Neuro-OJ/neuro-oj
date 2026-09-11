<script setup lang="ts">
/**
 * 通知详情页。
 *
 * 承接「没有可跳转关联内容」的通知（封禁通知、内容已删除、触发者已注销）：
 * 列表页点击这类通知时进入本页，而不是退回社区首页。有关联内容时本页
 * 额外提供「查看相关内容」入口，直接打开本页 URL 也能继续跳转。
 */
import type { NotificationRow } from "~/composables/useCommunity"
import { extractApiError } from "~/utils/apiError"
import {
  notificationTarget,
  notificationTypeIcon,
  notificationTypeLabel,
} from "~/utils/communityNotifications"

definePageMeta({ middleware: "auth", ssr: false })

const route = useRoute()
const { api } = useApi()
const { loadUnreadCount } = useCommunityNotifications()

const notificationId = computed(() => String(route.params.id ?? ""))
const item = ref<NotificationRow | null>(null)
const loading = ref(true)
const error = ref("")

/** 关联内容入口（无关联内容时为 null） */
const targetHref = computed(() => (item.value ? notificationTarget(item.value) : null))

async function load() {
  loading.value = true
  error.value = ""
  try {
    const result = await api.get<{ data: NotificationRow }>(
      `/api/v1/community/notifications/${notificationId.value}`,
      { silent: true },
    )
    item.value = result.data
    await markRead()
  } catch (err: unknown) {
    error.value = extractApiError(err).message || "通知不存在或无权查看"
  } finally {
    loading.value = false
  }
}

/** 进入详情页即视为已读；失败不阻塞阅读 */
async function markRead() {
  // 取局部引用：await 之后 TS 不再保留 item.value 的收窄
  const current = item.value
  if (!current || current.notification.read_at) return
  try {
    await api.post(
      `/api/v1/community/notifications/${notificationId.value}/read`,
      undefined,
      { silent: true },
    )
    current.notification.read_at = new Date().toISOString()
    await loadUnreadCount()
  } catch {
    // 已读失败不影响详情展示
  }
}

onMounted(() => {
  void load()
})

function formatDateTime(value?: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN")
}
</script>

<template>
  <main class="mx-auto w-full max-w-3xl px-6 py-10">
    <NuxtLink
      to="/community/notifications"
      class="inline-flex items-center gap-1 text-sm text-text-secondary no-underline hover:text-primary"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" />返回通知列表
    </NuxtLink>

    <!-- 标题在所有状态下都渲染：加载/未找到时页面不应该是“无标题”的 -->
    <h1 class="mt-4 text-2xl font-bold text-text">通知详情</h1>

    <div v-if="loading" class="mt-6 py-12 text-center text-text-secondary">加载中…</div>
    <p v-else-if="error" class="mt-6 py-12 text-center text-text-secondary">{{ error }}</p>

    <template v-else-if="item">
      <article class="mt-4 rounded-lg border border-border bg-white p-6 shadow-card">
        <header class="flex items-start gap-3 border-b border-border pb-4">
          <span
            class="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full"
            :class="item.notification.type === 'moderation' || item.notification.type === 'ban' ? 'bg-red-50 text-red-600' : 'bg-primary-bg text-primary'"
          >
            <UIcon :name="notificationTypeIcon(item.notification.type)" class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-1 text-sm text-text">
              <template v-if="item.actor">
                <UserIdentity :user="item.actor" size="sm" />
              </template>
              <template v-else>
                <strong>系统</strong>
              </template>
              {{ notificationTypeLabel(item.notification.type) }}
            </p>
          </div>
          <span
            class="shrink-0 rounded px-2 py-0.5 text-xs font-medium"
            :class="item.notification.read_at ? 'bg-bg-page text-text-muted' : 'bg-primary-bg text-primary'"
          >
            {{ item.notification.read_at ? "已读" : "未读" }}
          </span>
        </header>

        <dl class="mt-4 space-y-3 text-sm">
          <div v-if="item.notification.data.message" class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">通知内容</dt>
            <dd class="whitespace-pre-line text-text">{{ item.notification.data.message }}</dd>
          </div>

          <template v-if="item.notification.type === 'ban'">
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁范围</dt>
              <dd class="text-text">
                {{ item.notification.data.scope === "social" ? "仅限制社交功能" : "限制使用平台" }}
              </dd>
            </div>
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁理由</dt>
              <dd class="whitespace-pre-line text-text">
                {{ item.notification.data.reason || "（未填写）" }}
              </dd>
            </div>
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁时间</dt>
              <dd class="text-text-secondary">{{ formatDateTime(item.notification.data.banned_at) }}</dd>
            </div>
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁期限</dt>
              <dd class="text-text-secondary">
                {{ item.notification.data.banned_until ? `至 ${formatDateTime(item.notification.data.banned_until)}` : "永久封禁" }}
              </dd>
            </div>
          </template>

          <template v-if="item.notification.type === 'moderation'">
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">审核状态</dt>
              <dd class="text-text">{{ item.notification.data.status ?? "—" }}</dd>
            </div>
            <div v-if="item.notification.data.reason" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">审核理由</dt>
              <dd class="whitespace-pre-line text-text">{{ item.notification.data.reason }}</dd>
            </div>
          </template>

          <template v-if="item.notification.type === 'report'">
            <div v-if="item.notification.data.status" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">处理状态</dt>
              <dd class="text-text">{{ item.notification.data.status }}</dd>
            </div>
            <div v-if="item.notification.data.resolution" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">处理结果</dt>
              <dd class="whitespace-pre-line text-text">{{ item.notification.data.resolution }}</dd>
            </div>
          </template>

          <template v-if="item.notification.type === 'clarification'">
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">提问公开性</dt>
              <dd class="text-text">{{ item.notification.data.is_public ? "公开提问" : "私密提问" }}</dd>
            </div>
            <div v-if="item.notification.data.problem_label" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">关联题目</dt>
              <dd class="font-mono text-text">{{ item.notification.data.problem_label }}</dd>
            </div>
          </template>

          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">时间</dt>
            <dd class="text-text-secondary">
              <NuxtTime :datetime="item.notification.created_at" locale="zh-CN" />
            </dd>
          </div>
        </dl>

        <div class="mt-6 flex flex-wrap gap-2 border-t border-border pt-4">
          <UButton v-if="targetHref" color="primary" variant="outline" :to="targetHref">
            <UIcon name="i-lucide-external-link" class="size-4" />查看相关内容
          </UButton>
          <p v-else class="text-xs text-text-muted">
            这条通知没有可跳转的关联内容（<template v-if="item.notification.type === 'ban'">封禁通知不关联具体内容</template><template v-else>关联内容可能已被删除</template>）。
          </p>
        </div>
      </article>
    </template>
  </main>
</template>
