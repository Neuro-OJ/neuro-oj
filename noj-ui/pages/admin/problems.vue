<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import type { AdminColumn } from "~/components/admin/AdminTable.vue"
import { useDialog } from "~/composables/useDialog"
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

interface Problem {
  id: string
  title: string
  difficulty: string
  display_id: string
  type: string
  owner_id: string
  owner_username?: string
  visibility?: string
  tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[]
  created_at: string
}

const { api } = useApi()

const problems = ref<Problem[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20
let requestVersion = 0

// 搜索关键字（300ms 防抖，自动重置到第 1 页）
const keyword = ref("")
let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchInput(val: string) {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    keyword.value = val
    loadProblems(1)
  }, 300)
}

const difficultyLabels: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

const columns: AdminColumn[] = [
  { key: "display_id", label: "题号" },
  { key: "type", label: "类型" },
  { key: "title", label: "标题" },
  { key: "difficulty", label: "难度" },
  { key: "tags", label: "标签" },
  { key: "created_at", label: "创建时间" },
  { key: "actions", label: "操作" },
]

async function loadProblems(page = 1) {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const params = new URLSearchParams({ page: String(page), limit: String(perPage) })
    if (keyword.value) params.set("keyword", keyword.value)
    const res = await api.get<{ data: Problem[]; total: number; page: number; limit: number }>(
      `/api/v1/problems?${params.toString()}`,
      { silent: true },
    )
    if (currentRequest !== requestVersion) return
    problems.value = res.data
    totalPages.value = Math.ceil(res.total / perPage)
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    tableError.value = extractApiError(err).message
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadProblems()
}, { immediate: true })

function onPageChange(page: number) {
  loadProblems(page)
}

// 删除确认
const deleteTarget = ref<Problem | null>(null)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const deleteError = ref("")

function confirmDelete(problem: Problem) {
  deleteTarget.value = problem
  deleteError.value = ""
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  deleteError.value = ""
  try {
    await api.delete(`/api/v1/problems/${deleteTarget.value.display_id}`)
    showDeleteConfirm.value = false
    // 如果当前页只有这一个题目，删除后自动回到上一页
    if (problems.value.length <= 1 && currentPage.value > 1) {
      await loadProblems(currentPage.value - 1)
    } else {
      await loadProblems(currentPage.value)
    }
  } catch (err: unknown) {
    deleteError.value = extractApiError(err).message
  } finally {
    deleting.value = false
  }
}

const { toast, showToast } = useToast()
const { dialog } = useDialog()
const rejudgingProblemIds = ref(new Set<string>())
const preflight = ref<{ problem_id: string; fingerprint: string; can_publish: boolean; checks: { name: string; status: string; message: string }[] } | null>(null)
const preflightOpen = ref(false)

async function runPreflight(problem: Problem) {
  try {
    const result = await api.get<{ data: NonNullable<typeof preflight.value> }>(`/api/v1/admin/catalog/problems/${problem.display_id}/preflight`, { silent: true })
    preflight.value = result.data
    preflightOpen.value = true
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  }
}

async function batchRejudge(problemId: string) {
  if (rejudgingProblemIds.value.has(problemId)) return
  const confirmed = await dialog.confirm(
    "确定要重测该题目的所有已完结提交吗？这将重新运行评测并覆盖现有结果。",
    { title: "确认批量重测" },
  )
  if (!confirmed) return

  rejudgingProblemIds.value = new Set(rejudgingProblemIds.value).add(problemId)
  try {
    const res = await api.post<{ message: string; total: number; queued: number; skipped: number }>(
      `/api/v1/admin/submission/problems/${problemId}/rejudge`,
    )
    showToast(
      "success",
      `批量重测共 ${res.total} 条，已入队 ${res.queued} 条${res.skipped > 0 ? `，未入队 ${res.skipped} 条` : ""}`,
    )
    loadProblems(currentPage.value)
  } finally {
    const next = new Set(rejudgingProblemIds.value)
    next.delete(problemId)
    rejudgingProblemIds.value = next
  }
}

// ── 题目评定队列 ─────────────────────────────────────────────
const activeTab = ref<'all' | 'review'>('all')
const reviewQueue = ref<'public' | 'p'>('public')
const reviewProblems = ref<Problem[]>([])
const reviewLoading = ref(false)
const reviewError = ref('')
const selectedIds = ref<Set<string>>(new Set())
const reviewing = ref(false)

const reviewColumns: AdminColumn[] = [
  { key: 'selected', label: '' },
  { key: 'display_id', label: '题号' },
  { key: 'title', label: '标题' },
  { key: 'owner_username', label: '所有者' },
  { key: 'created_at', label: '创建时间' },
]

const selectedCount = computed(() => selectedIds.value.size)

async function loadReview() {
  reviewLoading.value = true
  reviewError.value = ''
  selectedIds.value = new Set()
  try {
    const res = await api.get<{ data: Problem[]; total: number }>(
      `/api/v1/admin/catalog/problems/review?queue=${reviewQueue.value}&page=1&limit=100`,
      { silent: true },
    )
    reviewProblems.value = res.data
  } catch (err: unknown) {
    reviewError.value = extractApiError(err).message
  } finally {
    reviewLoading.value = false
  }
}

watch(reviewQueue, () => void loadReview())
watch(activeTab, (value) => {
  if (value === 'review') void loadReview()
})

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  if (reviewProblems.value.length > 0 &&
    reviewProblems.value.every((p) => selectedIds.value.has(p.id))) {
    selectedIds.value = new Set()
  } else {
    selectedIds.value = new Set(reviewProblems.value.map((p) => p.id))
  }
}

async function batchReview(action: 'to_public' | 'to_p') {
  if (selectedIds.value.size === 0) return
  reviewing.value = true
  try {
    const res = await api.post<{ data: { updated: number } }>(
      '/api/v1/admin/catalog/problems/review',
      { problem_ids: [...selectedIds.value], action },
    )
    showToast(
      'success',
      action === 'to_public'
        ? `已批量转公开 ${res.data.updated} 题`
        : `已批量转为 P 型 ${res.data.updated} 题`,
    )
    await loadReview()
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  } finally {
    reviewing.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader title="题目管理" description="管理所有题目">
      <template #actions>
        <div class="flex items-center gap-2">
          <input
            type="text"
            placeholder="搜索题号或标题…"
            class="px-3 py-2 text-sm border border-border rounded outline-none focus:border-signal transition-colors"
            @input="onSearchInput(($event.target as HTMLInputElement).value)"
          />
          <NuxtLink to="/admin/problem-new" class="inline-flex items-center gap-1.5 px-4 py-2 text-13px font-semibold bg-signal text-on-signal border-[1.5px] border-signal rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-signal/80 hover:border-signal/80">
            <UIcon name="i-lucide-plus" class="size-4" />
            创建题目
          </NuxtLink>
        </div>
      </template>
    </AdminPageHeader>

    <div class="flex gap-1 border-b border-border">
      <button
        type="button"
        class="px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
        :class="activeTab === 'all' ? 'border-signal text-text' : 'border-transparent text-text-muted hover:text-text'"
        @click="activeTab = 'all'"
      >全部题目</button>
      <button
        type="button"
        class="px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
        :class="activeTab === 'review' ? 'border-signal text-text' : 'border-transparent text-text-muted hover:text-text'"
        @click="activeTab = 'review'"
      >题目评定</button>
    </div>

    <template v-if="activeTab === 'all'">
      <AdminTable
        :columns="columns"
        :items="problems as unknown as Record<string, unknown>[]"
        :loading="tableLoading"
        :error="tableError || undefined"
        :total-pages="totalPages"
        :current-page="currentPage"
        @update:page="onPageChange"
      >
        <template #cell="{ row, column }">
          <template v-if="column.key === 'type'">
            {{ (row as unknown as Problem).type === "U" ? "用户题库" : "主题库" }}
          </template>
          <template v-else-if="column.key === 'difficulty'">
            <span class="inline-block px-2 py-0.5 rounded text-xs font-semibold" :class="(row as unknown as Problem).difficulty === 'easy' ? 'bg-green-50 text-success-text' : (row as unknown as Problem).difficulty === 'medium' ? 'bg-amber-50 text-warning-text' : 'bg-red-50 text-error-text'">
              {{ difficultyLabels[(row as unknown as Problem).difficulty] || (row as unknown as Problem).difficulty }}
            </span>
          </template>
          <template v-else-if="column.key === 'tags'">
            {{ ((row as unknown as Problem).tags ?? []).map((c) => c.name).join(", ") || "-" }}
          </template>
          <template v-else-if="column.key === 'created_at'">
            {{ new Date((row as unknown as Problem).created_at).toLocaleDateString("zh-CN") }}
          </template>
        </template>
        <template #actions="{ row }">
          <div class="flex gap-1.5 justify-center">
            <NuxtLink :to="`/admin/problem-edit/${(row as unknown as Problem).display_id}`" class="inline-flex items-center justify-center w-9 h-9 border border-border rounded bg-transparent text-text-secondary cursor-pointer no-underline transition-all duration-150 hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑">
              <UIcon name="i-lucide-pencil" class="size-3.5" />
            </NuxtLink>
            <UButton color="neutral" variant="outline" class="w-9 h-9 border-border text-text-secondary hover:bg-amber-50 hover:text-warning-600 hover:border-warning-600/30" :disabled="rejudgingProblemIds.has((row as unknown as Problem).id)" :title="rejudgingProblemIds.has((row as unknown as Problem).id) ? '重测提交中' : '重测'" :aria-label="rejudgingProblemIds.has((row as unknown as Problem).id) ? '重测提交中' : '重测'" @click="batchRejudge((row as unknown as Problem).display_id)">
              <UIcon name="i-lucide-refresh-cw" class="size-3.5" />
            </UButton>
            <UButton color="neutral" variant="outline" class="w-9 h-9" title="发布前预检" aria-label="发布前预检" @click="runPreflight(row as unknown as Problem)"><UIcon name="i-lucide-clipboard-check" class="size-3.5" /></UButton>
            <UButton color="neutral" variant="outline" class="w-9 h-9 border-border text-text-secondary hover:bg-red-50 hover:text-error-text hover:border-error-text/30" title="删除" aria-label="删除" @click="confirmDelete(row as unknown as Problem)">
              <UIcon name="i-lucide-trash-2" class="size-3.5" />
            </UButton>
          </div>
        </template>
      </AdminTable>
    </template>

    <template v-else>
      <div class="flex items-center gap-2">
        <UButton
          size="sm"
          :variant="reviewQueue === 'public' ? 'solid' : 'outline'"
          @click="reviewQueue = 'public'"
        >待转公开</UButton>
        <UButton
          size="sm"
          :variant="reviewQueue === 'p' ? 'solid' : 'outline'"
          @click="reviewQueue = 'p'"
        >待转 P</UButton>
      </div>

      <AdminTable
        :columns="reviewColumns"
        :items="reviewProblems as unknown as Record<string, unknown>[]"
        :loading="reviewLoading"
        :error="reviewError || undefined"
        :total-pages="1"
        :current-page="1"
      >
        <template #cell="{ row, column }">
          <template v-if="column.key === 'selected'">
            <input
              type="checkbox"
              class="size-4 accent-primary"
              :checked="selectedIds.has((row as unknown as Problem).id)"
              :aria-label="`选择 ${(row as unknown as Problem).display_id}`"
              @change="toggleSelect((row as unknown as Problem).id)"
            />
          </template>
          <template v-else-if="column.key === 'owner_username'">{{ (row as unknown as Problem).owner_username || (row as unknown as Problem).owner_id }}</template>
          <template v-else-if="column.key === 'created_at'">{{ new Date((row as unknown as Problem).created_at).toLocaleDateString("zh-CN") }}</template>
        </template>
      </AdminTable>

      <div class="flex items-center gap-2">
        <UButton color="primary" :loading="reviewing" :disabled="selectedCount === 0 || reviewing" @click="batchReview('to_public')">批量转公开</UButton>
        <UButton color="primary" variant="outline" :loading="reviewing" :disabled="selectedCount === 0 || reviewing" @click="batchReview('to_p')">批量转 P</UButton>
        <span class="text-xs text-text-muted">已选 {{ selectedCount }} 题</span>
      </div>
    </template>
  </div>

  <!-- 删除确认 -->
  <UModal v-model:open="showDeleteConfirm" title="删除题目" :unmount-on-hide="true">
    <template #body>
      <p>确定要删除题目 <strong>{{ deleteTarget?.title }}</strong>（{{ deleteTarget?.display_id }}）吗？此操作不可撤销，相关提交记录也会被级联删除。</p>
      <p v-if="deleteError" class="mt-2 text-error-text text-13px">{{ deleteError }}</p>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">取消</UButton>
      <UButton color="error" :loading="deleting" @click="handleDelete">确认删除</UButton>
    </template>
  </UModal>

  <UModal v-model:open="preflightOpen" title="发布前质量预检">
    <template #body>
      <p class="mb-3 text-sm text-text-secondary">结果指纹：<code>{{ preflight?.fingerprint }}</code></p>
      <div class="space-y-2">
        <div v-for="check in preflight?.checks" :key="check.name" class="flex gap-2 text-sm">
          <UIcon :name="check.status === 'pass' ? 'i-lucide-check-circle' : check.status === 'error' ? 'i-lucide-x-circle' : 'i-lucide-alert-triangle'" :class="check.status === 'pass' ? 'text-success-text' : check.status === 'error' ? 'text-error-text' : 'text-warning-text'" class="size-4 shrink-0" />
          <span>{{ check.message }}</span>
        </div>
      </div>
      <p class="mt-4 font-semibold" :class="preflight?.can_publish ? 'text-success-text' : 'text-error-text'">{{ preflight?.can_publish ? '可进入发布流程' : '存在阻断错误，暂不可发布' }}</p>
    </template>
  </UModal>
</template>
