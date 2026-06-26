<script setup lang="ts">
import { Plus, Pencil, Trash2, X, Check } from "@lucide/vue"
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
  if (!isLoggedIn.value) return
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

watch(isLoggedIn, (val) => {
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
        body: { name: formName.value, slug: formSlug.value, description: formDesc.value },
      })
    } else {
      await $fetch("/api/v1/categories", {
        method: "POST",
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
  formError.value = ""
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await $fetch(`/api/v1/categories/${deleteTarget.value.id}`, {
      method: "DELETE",
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
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[22px] font-bold text-text">分类管理</h1>
        <span class="text-sm text-text-secondary">管理题目分类</span>
      </div>
      <button class="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark" @click="openCreate">
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
        <div class="flex gap-1.5 justify-center">
          <button class="flex items-center justify-center w-[30px] h-[30px] border border-border rounded bg-transparent text-text-secondary cursor-pointer transition-all duration-150 hover:bg-[#f5f5f5] hover:text-text" title="编辑" @click="openEdit(row)">
            <Pencil :size="15" />
          </button>
          <button class="flex items-center justify-center w-[30px] h-[30px] border border-border rounded bg-transparent text-text-secondary cursor-pointer transition-all duration-150 hover:bg-red-50 hover:text-[#dc2626] hover:border-red-200" title="删除" @click="confirmDelete(row)">
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
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">名称 <span class="text-error-text">*</span></label>
        <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="分类名称" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">标识 <span class="text-error-text">*</span></label>
        <input v-model="formSlug" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="分类标识（英文）" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">描述</label>
        <input v-model="formDesc" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="可选描述" />
      </div>
      <p v-if="formError" class="text-error-text text-[13px]">{{ formError }}</p>
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
    <p v-if="formError" class="text-error-text text-[13px]">{{ formError }}</p>
  </AdminModal>
</template>
