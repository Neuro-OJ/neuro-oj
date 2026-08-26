<script setup lang="ts">
definePageMeta({ middleware: "auth" })

const route = useRoute()
const { api } = useApi()

interface ReportDetail {
  report: {
    id: string
    reporter_id: string
    post_id: string | null
    comment_id: string | null
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
  reporter: { id: string; username: string }
  post: {
    id: string
    title: string | null
    content: string
    type: string
    author_id: string
  } | null
  comment: {
    id: string
    content: string
    post_id: string
    author_id: string
  } | null
  ban: {
    id: string
    scope: "platform" | "social"
    banned_until: string | null
    unbanned_at: string | null
  } | null
}

const reportId = computed(() => String(route.params.id))
const report = ref<ReportDetail | null>(null)
const loading = ref(true)
const error = ref("")

const typeLabel: Record<string, string> = {
  discussion: "讨论",
  solution: "题解",
  moment: "动态",
}
const statusLabel: Record<string, string> = {
  pending: "待审核",
  resolved: "已处理",
  dismissed: "已驳回",
}
const statusClass: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  resolved: "bg-green-50 text-green-700",
  dismissed: "bg-gray-100 text-text-secondary",
}

function targetHref(): string {
  const pid = report.value?.post?.id ?? report.value?.comment?.post_id
  return pid ? `/community/posts/${pid}` : "#"
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    const result = await api.get<{ data: ReportDetail }>(
      `/api/v1/community/reports/${reportId.value}`,
    )
    report.value = result.data
  } catch (err: unknown) {
    error.value = "举报工单不存在或无权查看"
  } finally {
    loading.value = false
  }
}

await load()
</script>

<template>
  <main class="mx-auto w-full max-w-3xl px-6 py-10">
    <NuxtLink to="/community/notifications" class="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" />返回通知</NuxtLink>

    <div v-if="loading" class="mt-8 py-12 text-center text-text-secondary">加载中…</div>
    <p v-else-if="error" class="mt-8 py-12 text-center text-text-secondary">{{ error }}</p>

    <template v-else-if="report">
      <div class="mt-4 rounded-lg border border-border bg-white p-6 shadow-card">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-4">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-flag" class="text-primary size-5" />
            <h1 class="text-xl font-bold">举报工单 <span class="font-mono text-sm text-text-secondary">#{{ report.report.id.slice(0, 8) }}</span></h1>
          </div>
          <span class="rounded px-2 py-0.5 text-xs font-medium" :class="statusClass[report.report.status]">
            {{ statusLabel[report.report.status] }}
          </span>
        </div>

        <dl class="mt-4 space-y-3 text-sm">
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">举报内容</dt>
            <dd class="text-text-secondary">{{ report.report.content_type === "comment" ? "评论" : (typeLabel[report.post?.type ?? ""] ?? "内容") }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">举报分类</dt>
            <dd><span class="rounded bg-primary-bg px-2 py-0.5 text-xs text-primary">{{ report.report.category }}</span></dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">举报理由</dt>
            <dd class="text-text">{{ report.report.reason }}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">提交时间</dt>
            <dd class="text-text-secondary"><NuxtTime :datetime="report.report.created_at" locale="zh-CN" /></dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 text-text-muted">被举报内容</dt>
            <dd>
              <NuxtLink :to="targetHref()" class="rounded border border-border bg-bg-page px-3 py-2 text-text-secondary hover:bg-primary-bg block">
                {{ report.report.content_snapshot }}
              </NuxtLink>
            </dd>
          </div>
          <template v-if="report.report.status !== 'pending'">
            <div class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">处理结果</dt>
              <dd class="text-text">{{ report.report.resolution || "（未填写）" }}</dd>
            </div>
            <div v-if="report.ban" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁类型</dt>
              <dd class="text-text">{{ report.ban.scope === "social" ? "仅限制社交功能" : "限制使用平台" }}</dd>
            </div>
            <div v-if="report.ban" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">封禁期限</dt>
              <dd class="text-text-secondary">{{ report.ban.banned_until ? `至 ${new Date(report.ban.banned_until).toLocaleString("zh-CN")}` : "永久封禁" }}</dd>
            </div>
            <div v-if="report.report.resolved_at" class="flex gap-3">
              <dt class="w-24 shrink-0 text-text-muted">处理时间</dt>
              <dd class="text-text-secondary"><NuxtTime :datetime="report.report.resolved_at" locale="zh-CN" /></dd>
            </div>
          </template>
        </dl>
      </div>
    </template>
  </main>
</template>
