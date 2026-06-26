<script setup lang="ts">
import { Plus, Trash2, Pencil } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"

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

const problems = ref<Problem[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20

const difficultyLabels: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

const columns: Column<Problem>[] = [
  { key: "display_id", label: "题号" },
  { key: "type", label: "类型", format: (val) => (val as string) === "U" ? "用户题库" : "主题库" },
  { key: "title", label: "标题" },
  { key: "difficulty", label: "难度", format: (val) => difficultyLabels[val as string] || (val as string) },
  {
    key: "categories",
    label: "分类",
    format: (val) => (val as { name: string }[]).map((c) => c.name).join(", ") || "-",
  },
  {
    key: "created_at",
    label: "创建时间",
    format: (val) => new Date(val as string).toLocaleDateString("zh-CN"),
  },
]

async function loadProblems(page = 1) {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: Problem[]; total: number; page: number; limit: number }>(
      `/api/v1/problems?page=${page}&limit=${perPage}`,
    )
    problems.value = res.data
    totalPages.value = Math.ceil(res.total / perPage)
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载题目列表失败"
  } finally {
    tableLoading.value = false
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
    await $fetch(`/api/v1/problems/${deleteTarget.value.id}`, {
      method: "DELETE",
    })
    showDeleteConfirm.value = false
    // 如果当前页只有这一个题目，删除后自动回到上一页
    if (problems.value.length <= 1 && currentPage.value > 1) {
      await loadProblems(currentPage.value - 1)
    } else {
      await loadProblems(currentPage.value)
    }
  } catch (err: unknown) {
    deleteError.value = err instanceof Error ? err.message : "删除失败"
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[22px] font-bold text-text">题目管理</h1>
        <span class="text-sm text-text-secondary">管理所有题目</span>
      </div>
      <NuxtLink to="/admin/problem-new" class="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
        <Plus :size="16" />
        创建题目
      </NuxtLink>
    </div>

    <AdminTable
      :columns="columns"
      :data="problems"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无题目"
    >
      <template #cell-difficulty="{ row }">
        <span class="inline-block px-2 py-0.5 rounded text-xs font-semibold" :class="row.difficulty === 'easy' ? 'bg-green-50 text-success-text' : row.difficulty === 'medium' ? 'bg-amber-50 text-warning-text' : 'bg-red-50 text-error-text'">
          {{ difficultyLabels[row.difficulty] || row.difficulty }}
        </span>
      </template>

      <template #actions="{ row }">
        <div class="flex gap-1.5 justify-center">
          <NuxtLink :to="`/admin/problem-edit/${row.id}`" class="inline-flex items-center justify-center w-[30px] h-[30px] border border-border rounded bg-transparent text-text-secondary cursor-pointer no-underline transition-all duration-150 hover:bg-[#f5f5f5] hover:text-text" title="编辑">
            <Pencil :size="15" />
          </NuxtLink>
          <button class="inline-flex items-center justify-center w-[30px] h-[30px] border border-border rounded bg-transparent text-text-secondary cursor-pointer transition-all duration-150 hover:bg-red-50 hover:text-[#dc2626] hover:border-red-200" title="删除" @click="confirmDelete(row)">
            <Trash2 :size="15" />
          </button>
        </div>
      </template>
    </AdminTable>

    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      @page-change="onPageChange"
    />
  </div>

  <!-- 删除确认 -->
  <AdminModal
    v-if="showDeleteConfirm"
    title="删除题目"
    confirm-text="确认删除"
    :loading="deleting"
    danger
    @confirm="handleDelete"
    @cancel="showDeleteConfirm = false"
  >
    <p>确定要删除题目 <strong>{{ deleteTarget?.title }}</strong>（{{ deleteTarget?.id }}）吗？此操作不可撤销，相关提交记录也会被级联删除。</p>
    <p v-if="deleteError" class="mt-2 text-error-text text-[13px]">{{ deleteError }}</p>
  </AdminModal>
</template>
