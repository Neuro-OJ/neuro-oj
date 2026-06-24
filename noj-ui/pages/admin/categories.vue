<script setup lang="ts">
import { Plus, Pencil, Trash2, X, Check } from "@lucide/vue"
import type { Column } from "~/components/admin/AdminTable.vue"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { token, isLoggedIn, loading } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface Category {
  id: string
  name: string
  slug: string
  description: string
}

const categories = ref<Category[]>([])
const tableLoading = ref(true)
const tableError = ref("")

const columns: Column<Category>[] = [
  { key: "name", label: "名称" },
  { key: "slug", label: "标识" },
  { key: "description", label: "描述", format: (val) => (val as string) || "-" },
]

async function loadCategories() {
  if (!token.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await $fetch<{ data: Category[] }>("/api/v1/categories")
    categories.value = res.data
  } catch (err: unknown) {
    tableError.value = err instanceof Error ? err.message : "加载分类失败"
  } finally {
    tableLoading.value = false
  }
}

watch(token, (val) => {
  if (val) loadCategories()
}, { immediate: true })

// 创建/编辑弹窗
const showForm = ref(false)
const editingCategory = ref<Category | null>(null)
const formName = ref("")
const formSlug = ref("")
const formDesc = ref("")
const saving = ref(false)
const formError = ref("")

function openCreate() {
  editingCategory.value = null
  formName.value = ""
  formSlug.value = ""
  formDesc.value = ""
  formError.value = ""
  showForm.value = true
}

function openEdit(cat: Category) {
  editingCategory.value = cat
  formName.value = cat.name
  formSlug.value = cat.slug
  formDesc.value = cat.description
  formError.value = ""
  showForm.value = true
}

async function handleSave() {
  if (!token.value) return
  if (!formName.value.trim()) {
    formError.value = "名称不能为空"
    return
  }
  if (!formSlug.value.trim()) {
    formError.value = "标识不能为空"
    return
  }

  saving.value = true
  formError.value = ""
  try {
    if (editingCategory.value) {
      await $fetch(`/api/v1/categories/${editingCategory.value.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token.value}` },
        body: { name: formName.value, slug: formSlug.value, description: formDesc.value },
      })
    } else {
      await $fetch("/api/v1/categories", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.value}` },
        body: { name: formName.value, slug: formSlug.value, description: formDesc.value },
      })
    }
    showForm.value = false
    await loadCategories()
  } catch (err: unknown) {
    formError.value = err instanceof Error ? err.message : "保存失败"
  } finally {
    saving.value = false
  }
}

// 删除确认
const deleteTarget = ref<Category | null>(null)
const showDeleteConfirm = ref(false)
const deleting = ref(false)

function confirmDelete(cat: Category) {
  deleteTarget.value = cat
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value || !token.value) return
  deleting.value = true
  try {
    await $fetch(`/api/v1/categories/${deleteTarget.value.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token.value}` },
    })
    showDeleteConfirm.value = false
    await loadCategories()
  } catch (err: unknown) {
    formError.value = err instanceof Error ? err.message : "删除失败"
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="header">
      <div>
        <h1 class="title">分类管理</h1>
        <span class="subtitle">管理题目分类</span>
      </div>
      <button class="btn btn-primary" @click="openCreate">
        <Plus :size="16" />
        新建分类
      </button>
    </div>

    <AdminTable
      :columns="columns"
      :data="categories"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无分类"
    >
      <template #actions="{ row }">
        <div class="action-btns">
          <button class="icon-btn" title="编辑" @click="openEdit(row)">
            <Pencil :size="15" />
          </button>
          <button class="icon-btn danger" title="删除" @click="confirmDelete(row)">
            <Trash2 :size="15" />
          </button>
        </div>
      </template>
    </AdminTable>
  </div>

  <!-- 创建/编辑弹窗 -->
  <AdminModal
    v-if="showForm"
    :title="editingCategory ? '编辑分类' : '新建分类'"
    :confirm-text="editingCategory ? '保存' : '创建'"
    :loading="saving"
    @confirm="handleSave"
    @cancel="showForm = false"
  >
    <div class="form">
      <div class="field">
        <label class="label">名称 <span class="required">*</span></label>
        <input v-model="formName" class="input" placeholder="分类名称" />
      </div>
      <div class="field">
        <label class="label">标识 <span class="required">*</span></label>
        <input v-model="formSlug" class="input" placeholder="分类标识（英文）" />
      </div>
      <div class="field">
        <label class="label">描述</label>
        <input v-model="formDesc" class="input" placeholder="可选描述" />
      </div>
      <p v-if="formError" class="error-text">{{ formError }}</p>
    </div>
  </AdminModal>

  <!-- 删除确认弹窗 -->
  <AdminModal
    v-if="showDeleteConfirm"
    title="删除分类"
    confirm-text="确认删除"
    :loading="deleting"
    danger
    @confirm="handleDelete"
    @cancel="showDeleteConfirm = false"
  >
    <p>确定要删除分类 <strong>{{ deleteTarget?.name }}</strong> 吗？此操作不可撤销。</p>
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
  transition: all 0.15s;
}

.btn-primary:hover {
  background: var(--c-primary-dark);
  border-color: var(--c-primary-dark);
}

.action-btns {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: transparent;
  color: var(--c-text-secondary);
  cursor: pointer;
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

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.required {
  color: #dc2626;
}

.input {
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.error-text {
  color: #dc2626;
  font-size: 13px;
}
</style>
