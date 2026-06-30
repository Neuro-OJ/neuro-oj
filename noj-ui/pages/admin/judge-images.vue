<script setup lang="ts">
import { Plus, Pencil, Trash2 } from "@lucide/vue"
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

interface JudgeImage {
  id: string
  image: string
  mode: string
  description: string
  created_at: string
}

const items = ref<JudgeImage[]>([])
const tableLoading = ref(true)
const tableError = ref("")

const columns: Column<JudgeImage>[] = [
  { key: "image", label: "镜像名" },
  {
    key: "mode",
    label: "匹配模式",
    format: (val) => (val as string) === "exact" ? "精确版本" : "所有版本",
  },
  {
    key: "description",
    label: "介绍",
    format: (val) => (val as string) || "-",
  },
  {
    key: "created_at",
    label: "创建时间",
    format: (val) => {
      const d = new Date(val as string)
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
    },
  },
]

async function loadItems() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await $fetch<{ data: JudgeImage[] }>("/api/v1/admin/judge-images")
    items.value = res.data
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    tableError.value = apiErr?.data?.error || apiErr?.message || "加载评测镜像列表失败"
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadItems()
}, { immediate: true })

// 创建/编辑弹窗
const showForm = ref(false)
const editingItem = ref<JudgeImage | null>(null)
const formImage = ref("")
const formMode = ref<"exact" | "all_versions">("exact")
const formDescription = ref("")
const saving = ref(false)
const formError = ref("")
const showAllVersionsWarning = ref(false)

function openCreate() {
  editingItem.value = null
  formImage.value = ""
  formMode.value = "exact"
  formDescription.value = ""
  formError.value = ""
  showAllVersionsWarning.value = false
  showForm.value = true
}

function openEdit(item: JudgeImage) {
  editingItem.value = item
  formImage.value = item.image
  formMode.value = item.mode as "exact" | "all_versions"
  formDescription.value = item.description
  formError.value = ""
  showAllVersionsWarning.value = formMode.value === "all_versions"
  showForm.value = true
}

function onModeChange() {
  if (formMode.value === "all_versions") {
    showAllVersionsWarning.value = true
  } else {
    showAllVersionsWarning.value = false
  }
}

async function handleSave() {
  if (!formImage.value.trim()) {
    formError.value = "镜像名不能为空"
    return
  }

  saving.value = true
  formError.value = ""
  try {
    if (editingItem.value) {
      await $fetch(`/api/v1/admin/judge-images/${editingItem.value.id}`, {
        method: "PUT",
        body: {
          image: formImage.value.trim(),
          mode: formMode.value,
          description: formDescription.value.trim(),
        },
      })
    } else {
      await $fetch("/api/v1/admin/judge-images", {
        method: "POST",
        body: {
          image: formImage.value.trim(),
          mode: formMode.value,
          description: formDescription.value.trim(),
        },
      })
    }
    showForm.value = false
    await loadItems()
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    formError.value = apiErr?.data?.error || apiErr?.message || "保存失败"
  } finally {
    saving.value = false
  }
}

// 删除确认
const deleteTarget = ref<JudgeImage | null>(null)
const showDeleteConfirm = ref(false)
const deleting = ref(false)

function confirmDelete(item: JudgeImage) {
  deleteTarget.value = item
  formError.value = ""
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await $fetch(`/api/v1/admin/judge-images/${deleteTarget.value.id}`, {
      method: "DELETE",
    })
    showDeleteConfirm.value = false
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    formError.value = apiErr?.data?.error || apiErr?.message || "删除失败"
  } finally {
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-[22px] font-bold text-text">评测镜像管理</h1>
        <span class="text-sm text-text-secondary">配置允许使用的 Docker 评测镜像白名单</span>
      </div>
      <button class="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark" @click="openCreate">
        <Plus :size="16" />
        新增镜像
      </button>
    </div>

    <AdminTable
      :columns="columns"
      :data="items"
      :loading="tableLoading"
      :error="tableError"
      empty-text="暂无评测镜像"
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
    :title="editingItem ? '编辑评测镜像' : '新增评测镜像'"
    :confirm-text="editingItem ? '保存' : '新增'"
    :loading="saving"
    @confirm="handleSave"
    @cancel="showForm = false"
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">镜像名 <span class="text-error-text">*</span></label>
        <input v-model="formImage" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="如：noj-judge-python" :disabled="!!editingItem" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">匹配模式</label>
        <select v-model="formMode" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" @change="onModeChange">
          <option value="exact">精确版本 — 仅匹配指定镜像名（含标签）</option>
          <option value="all_versions">所有版本 — 匹配镜像名所有标签</option>
        </select>
      </div>

      <!-- 全版本安全警告 -->
      <div v-if="showAllVersionsWarning" class="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
        <p class="font-semibold mb-1">⚠ 安全风险</p>
        <p>选择"所有版本"将允许该镜像的所有版本标签（如 <code>:latest</code>、<code>:dev</code> 等）。攻击者可能利用此宽松规则使用非预期镜像版本。</p>
        <p class="mt-1">请仅在完全信任该镜像所有版本的情况下使用此选项。</p>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[13px] font-semibold text-text">介绍</label>
        <input v-model="formDescription" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]" placeholder="在题目编辑器中展示的说明文字" />
      </div>
      <p v-if="formError" class="text-error-text text-[13px]">{{ formError }}</p>
    </div>
  </AdminModal>

  <!-- 删除确认弹窗 -->
  <AdminModal
    v-if="showDeleteConfirm"
    title="删除评测镜像"
    confirm-text="确认删除"
    :loading="deleting"
    danger
    @confirm="handleDelete"
    @cancel="showDeleteConfirm = false"
  >
    <p>确定要删除评测镜像 <strong>{{ deleteTarget?.image }}</strong> 吗？此操作将导致使用了此镜像的题目无法通过白名单校验。</p>
    <p v-if="formError" class="text-error-text text-[13px]">{{ formError }}</p>
  </AdminModal>
</template>
