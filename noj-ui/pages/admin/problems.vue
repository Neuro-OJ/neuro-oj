<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import { useDialog } from "~/composables/useDialog"
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface Problem {
  id: string
  title: string
  difficulty: string
  display_id: string
  type: string
  owner_id: string
  categories: { id: string; name: string }[]
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

const difficultyLabels: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

const columns = [
  { accessorKey: "display_id", header: "题号" },
  { accessorKey: "type", header: "类型", cell: (info) => (info.getValue() as string) === "U" ? "用户题库" : "主题库" },
  { accessorKey: "title", header: "标题" },
  { accessorKey: "difficulty", header: "难度", cell: (info) => difficultyLabels[info.getValue() as string] || (info.getValue() as string) },
  {
    accessorKey: "categories",
    header: "分类",
    cell: (info) => (info.getValue() as { name: string }[]).map((c) => c.name).join(", ") || "-",
  },
  {
    accessorKey: "created_at",
    header: "创建时间",
    cell: (info) => new Date(info.getValue() as string).toLocaleDateString("zh-CN"),
  },

  { accessorKey: "actions", header: "操作" },]

async function loadProblems(page = 1) {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await api.get<{ data: Problem[]; total: number; page: number; limit: number }>(
      `/api/v1/problems?page=${page}&limit=${perPage}`,
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
    await api.delete(`/api/v1/problems/${deleteTarget.value.id}`)
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

const toast = useToast()
const { dialog } = useDialog()
const rejudgingProblemIds = ref(new Set<string>())

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
      `/api/v1/admin/problems/${problemId}/rejudge`,
    )
    toast.showToast(
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
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="题目管理" description="管理所有题目">
      <template #actions>
        <NuxtLink to="/admin/problem-new" class="inline-flex items-center gap-1.5 px-4 py-2 text-13px font-semibold bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
          <UIcon name="i-lucide-plus" class="size-4" />
          创建题目
        </NuxtLink>
      </template>
    </PageHeader>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="problems"
      :loading="tableLoading"
      :empty="'暂无题目'">
      <template #difficulty-cell="{ row }">
        <span class="inline-block px-2 py-0.5 rounded text-xs font-semibold" :class="row.difficulty === 'easy' ? 'bg-green-50 text-success-text' : row.difficulty === 'medium' ? 'bg-amber-50 text-warning-text' : 'bg-red-50 text-error-text'">
          {{ difficultyLabels[row.difficulty] || row.difficulty }}
        </span>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <NuxtLink :to="`/admin/problem-edit/${row.id}`" class="inline-flex items-center justify-center w-[30px] h-[30px] border border-border rounded bg-transparent text-text-secondary cursor-pointer no-underline transition-all duration-150 hover:bg-[#f5f5f5] hover:text-text" title="编辑">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </NuxtLink>
          <UButton color="neutral" variant="outline" class="w-[30px] h-[30px] border-border text-text-secondary hover:bg-amber-50 hover:text-[#d97706] hover:border-amber-200" :disabled="rejudgingProblemIds.has(row.id)" :title="rejudgingProblemIds.has(row.id) ? '重测提交中' : '重测'" @click="batchRejudge(row.id)">
            <UIcon name="i-lucide-refresh-cw" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="w-[30px] h-[30px] border-border text-text-secondary hover:bg-red-50 hover:text-[#dc2626] hover:border-red-200" title="删除" @click="confirmDelete(row)">
            <UIcon name="i-lucide-trash-2" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </UTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>

  <!-- 删除确认 -->
  <UModal v-model:open="showDeleteConfirm" :title="'删除题目'" :unmount-on-hide="true">
    <p>确定要删除题目 <strong>{{ deleteTarget?.title }}</strong>（{{ deleteTarget?.id }}）吗？此操作不可撤销，相关提交记录也会被级联删除。</p>
    <p v-if="deleteError" class="mt-2 text-error-text text-13px">{{ deleteError }}</p>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">取消</UButton>
      <UButton color="error" :loading="deleting" @click="handleDelete">确认删除</UButton>
    </template>
  </UModal>
</template>
