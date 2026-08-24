<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn } = useAuth()
useRequireLogin()

interface LlmUsageRow {
  id: string
  submission_id: string
  problem_id: string
  user_id: string
  provider_id: string
  model: string
  request_messages: unknown
  request_params: Record<string, unknown>
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated_cost: number
  latency_ms: number
  status: string
  error_code: string | null
  prompt_hash: string
  created_at: string
}

const { api } = useApi()
const rows = ref<LlmUsageRow[]>([])
const loading = ref(false)
const error = ref("")

const filterUser = ref("")
const filterProblem = ref("")
const filterSubmission = ref("")
const limit = ref(100)

const columns = [
  { accessorKey: "created_at", header: "时间" },
  { accessorKey: "submission_id", header: "提交" },
  { accessorKey: "user_id", header: "用户" },
  { accessorKey: "problem_id", header: "题目" },
  { accessorKey: "provider_id", header: "Provider" },
  { accessorKey: "model", header: "模型" },
  { accessorKey: "total_tokens", header: "Token" },
  { accessorKey: "status", header: "状态" },
  { accessorKey: "actions", header: "操作" },
]

async function load() {
  if (!isLoggedIn.value) return
  loading.value = true
  error.value = ""
  try {
    const params = new URLSearchParams()
    if (filterUser.value.trim()) params.set("user_id", filterUser.value.trim())
    if (filterProblem.value.trim()) params.set("problem_id", filterProblem.value.trim())
    if (filterSubmission.value.trim()) params.set("submission_id", filterSubmission.value.trim())
    params.set("limit", String(limit.value))
    const qs = params.toString()
    const res = await api.get<{ data: LlmUsageRow[] }>(`/api/v1/admin/llm/usage${qs ? `?${qs}` : ""}`, { silent: true })
    rows.value = res.data
  } catch (err: unknown) {
    error.value = extractApiError(err).message
  } finally {
    loading.value = false
  }
}

watch(isLoggedIn, (val) => { if (val) load() }, { immediate: true })

const summary = computed(() => {
  return {
    calls: rows.value.length,
    tokens: rows.value.reduce((s, r) => s + (r.total_tokens ?? 0), 0),
    cost: rows.value.reduce((s, r) => s + (r.estimated_cost ?? 0), 0),
    errors: rows.value.filter((r) => r.status !== "ok").length,
  }
})

function exportCsv() {
  const header = ["created_at", "submission_id", "user_id", "problem_id", "provider_id", "model", "total_tokens", "estimated_cost", "status", "error_code"]
  const lines = rows.value.map((r) =>
    header.map((h) => {
      const v = r[h as keyof LlmUsageRow]
      return typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v ?? "")
    }).join(",")
  )
  const csv = [header.join(","), ...lines].join("\n")
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `llm-usage-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const detail = ref<LlmUsageRow | null>(null)
const showDetail = ref(false)

function openDetail(row: LlmUsageRow) {
  detail.value = row
  showDetail.value = true
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="LLM 用量" description="按用户/题目/提交查询 LLM 调用记录与用量">
      <template #actions>
        <UButton color="primary" size="sm" @click="exportCsv">
          <UIcon name="i-lucide-download" class="size-4" />
          导出 CSV
        </UButton>
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-end gap-3 p-4 bg-white border border-border rounded-xl">
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">用户 ID</label>
        <input v-model="filterUser" class="px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary" placeholder="user_id" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">题目 ID</label>
        <input v-model="filterProblem" class="px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary" placeholder="problem_id" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">提交 ID</label>
        <input v-model="filterSubmission" class="px-3 py-2 text-sm border border-border rounded outline-none focus:border-primary" placeholder="submission_id" />
      </div>
      <UButton color="primary" size="sm" :loading="loading" @click="load">查询</UButton>
    </div>

    <div v-if="!loading" class="grid grid-cols-4 gap-3">
      <div class="p-4 bg-white border border-border rounded-xl">
        <p class="text-13px text-text-secondary">调用次数</p>
        <p class="text-2xl font-semibold">{{ summary.calls }}</p>
      </div>
      <div class="p-4 bg-white border border-border rounded-xl">
        <p class="text-13px text-text-secondary">总 Token</p>
        <p class="text-2xl font-semibold">{{ summary.tokens }}</p>
      </div>
      <div class="p-4 bg-white border border-border rounded-xl">
        <p class="text-13px text-text-secondary">估算费用</p>
        <p class="text-2xl font-semibold">{{ summary.cost }}</p>
      </div>
      <div class="p-4 bg-white border border-border rounded-xl">
        <p class="text-13px text-text-secondary">失败次数</p>
        <p class="text-2xl font-semibold text-error-text">{{ summary.errors }}</p>
      </div>
    </div>

    <div v-if="error" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ error }}</span></div>
    <UTable
      :columns="columns"
      :data="rows"
      :loading="loading"
      :empty="'暂无用量记录'">
      <template #created_at-cell="{ row }">
        <span>{{ new Date(row.original.created_at).toLocaleString("zh-CN") }}</span>
      </template>
      <template #submission_id-cell="{ row }">
        <code class="text-xs">{{ row.original.submission_id.slice(0, 8) }}</code>
      </template>
      <template #status-cell="{ row }">
        <UBadge :color="row.original.status === 'ok' ? 'success' : 'error'" variant="soft">{{ row.original.status }}</UBadge>
      </template>
      <template #actions-cell="{ row }">
        <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary" title="详情" aria-label="详情" @click="openDetail(row.original)">
          <UIcon name="i-lucide-eye" class="size-3.5" />
        </UButton>
      </template>
    </UTable>

    <UModal v-model:open="showDetail" title="LLM 调用详情" :unmount-on-hide="true">
      <template #body>
        <div v-if="detail" class="flex flex-col gap-2 text-sm">
          <p><strong>模型：</strong>{{ detail.model }}</p>
          <p><strong>Token：</strong>{{ detail.prompt_tokens }} / {{ detail.completion_tokens }} / {{ detail.total_tokens }}</p>
          <p><strong>费用：</strong>{{ detail.estimated_cost }}</p>
          <p><strong>耗时：</strong>{{ detail.latency_ms }}ms</p>
          <p><strong>状态：</strong>{{ detail.status }}{{ detail.error_code ? ` (${detail.error_code})` : "" }}</p>
          <div class="mt-1">
            <p class="font-semibold mb-1">请求消息</p>
            <pre class="text-xs bg-bg-page p-3 rounded overflow-auto max-h-80">{{ JSON.stringify(detail.request_messages, null, 2) }}</pre>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
