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
  <div class="page">
    <div class="header">
      <div>
        <h1 class="title">题目管理</h1>
        <span class="subtitle">管理所有题目</span>
      </div>
      <NuxtLink to="/admin/problem-new" class="btn btn-primary">
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
        <span class="diff-badge" :class="row.difficulty">
          {{ difficultyLabels[row.difficulty] || row.difficulty }}
        </span>
      </template>

      <template #actions="{ row }">
        <div class="action-btns">
          <NuxtLink :to="`/admin/problem-edit/${row.id}`" class="icon-btn" title="编辑">
            <Pencil :size="15" />
          </NuxtLink>
          <button class="icon-btn danger" title="删除" @click="confirmDelete(row)">
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
    <p v-if="deleteError" class="error-text">{{ deleteError }}</p>
  </AdminModal>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  color: var(--c-text);
}

.subtitle {
  font-size: 14px;
  color: var(--c-text-secondary);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  background: var(--c-primary);
  color: var(--c-white);
  border: 1.5px solid var(--c-primary);
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}

.btn-primary:hover {
  background: var(--c-primary-dark);
  border-color: var(--c-primary-dark);
}

.diff-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
}

.diff-badge.easy { background: #ecfdf5; color: #10b981; }
.diff-badge.medium { background: #fffbeb; color: #f59e0b; }
.diff-badge.hard { background: #fef2f2; color: #ef4444; }

.action-btns {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: transparent;
  color: var(--c-text-secondary);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}

.icon-btn:hover {
  background: var(--c-bg-hover, #f5f5f5);
  color: var(--c-text);
}

.icon-btn.danger:hover {
  background: #fef2f2;
  color: #dc2626;
  border-color: #fecaca;
}

.error-text {
  margin-top: 8px;
  color: #dc2626;
  font-size: 13px;
}
</style>
