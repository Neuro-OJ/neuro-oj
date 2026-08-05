<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn, loading } = useAuth()
const router = useRouter()

useRequireLogin()

interface Category {
  id: string
  name: string
  slug: string
  description: string
}

const { api } = useApi()

const categories = ref<Category[]>([])
const tableLoading = ref(true)
const tableError = ref("")

const columns = [
  { accessorKey: "name", header: "名称" },
  { accessorKey: "slug", header: "标识" },
  { accessorKey: "description", header: "描述", cell: (info) => (info.getValue() as string) || "-" },

  { accessorKey: "actions", header: "操作" },]

async function loadCategories() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: Category[] }>("/api/v1/categories", { silent: true })
    categories.value = res.data
  } catch (err: unknown) {
    tableError.value = extractApiError(err).message
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
      await api.put(`/api/v1/categories/${editingCategory.value.id}`, {
        name: formName.value, slug: formSlug.value, description: formDesc.value,
      })
    } else {
      await api.post("/api/v1/categories", {
        name: formName.value, slug: formSlug.value, description: formDesc.value,
      })
    }
    showForm.value = false
    await loadCategories()
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
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
    await api.delete(`/api/v1/categories/${deleteTarget.value.id}`)
    showDeleteConfirm.value = false
    await loadCategories()
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="分类管理" description="管理题目分类">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新建分类
        </UButton>
      </template>
    </PageHeader>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="categories"
      :loading="tableLoading"
      :empty="'暂无分类'">
      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-[30px] h-[30px] border-border text-text-secondary hover:bg-[#f5f5f5] hover:text-text" title="编辑" @click="openEdit(row)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="flex w-[30px] h-[30px] border-border text-text-secondary hover:bg-red-50 hover:text-[#dc2626] hover:border-red-200" title="删除" @click="confirmDelete(row)">
            <UIcon name="i-lucide-trash-2" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </UTable>
  </div>

  <!-- 创建/编辑弹窗 -->
  <UModal v-model:open="showForm" :title="editingCategory ? '编辑分类' : '新建分类'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
        <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="分类名称" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">标识 <span class="text-error-text">*</span></label>
        <input v-model="formSlug" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="分类标识（英文）" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">描述</label>
        <input v-model="formDesc" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="可选描述" />
      </div>
      <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
      </div>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showForm = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">editingCategory ? '保存' : '创建'</UButton>
    </template>
  </UModal>

  <!-- 删除确认弹窗 -->
  <UModal v-model:open="showDeleteConfirm" title="删除分类" :unmount-on-hide="true">
    <template #body>
      <p>确定要删除分类 <strong>{{ deleteTarget?.name }}</strong> 吗？此操作不可撤销。</p>
      <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
    </template>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">取消</UButton>
      <UButton color="error" :loading="deleting" @click="handleDelete">确认删除</UButton>
    </template>
  </UModal>
</template>
