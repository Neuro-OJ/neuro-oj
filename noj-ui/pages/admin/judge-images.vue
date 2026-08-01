<script setup lang="ts">
import { useToast } from "~/composables/useToast"

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
const { toast } = useToast()
let requestVersion = 0

const columns = [
  { accessorKey: "image", header: "镜像名" },
  {
    accessorKey: "mode",
    header: "匹配模式",
    cell: (info) => (info.getValue() as string) === "exact" ? "精确版本" : "所有版本",
  },
  {
    accessorKey: "description",
    header: "介绍",
    cell: (info) => (info.getValue() as string) || "-",
  },
  {
    accessorKey: "created_at",
    header: "创建时间",
    cell: (info) => {
      const d = new Date(info.getValue() as string)
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
    },
  },

  { accessorKey: "actions", header: "操作" },]

async function loadItems() {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await $fetch<{ data: JudgeImage[] }>("/api/v1/admin/judge-images")
    if (currentRequest !== requestVersion) return
    items.value = res.data
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    tableError.value = apiErr?.data?.error || apiErr?.message || "加载评测镜像列表失败"
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false
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
    items.value = items.value.filter((item) => item.id !== deleteTarget.value!.id)
    showDeleteConfirm.value = false
    toast.success("评测镜像已删除")
  } catch (err: unknown) {
    const apiErr = err as { data?: { error?: string }; message?: string } | undefined
    formError.value = apiErr?.data?.error || apiErr?.message || "删除失败"
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="评测镜像管理" description="配置允许使用的 Docker 评测镜像白名单">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新增镜像
        </UButton>
      </template>
    </PageHeader>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="items"
      :loading="tableLoading"
      :empty="'暂无评测镜像'">
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
  <UModal v-model:open="showForm" :title="editingItem ? '编辑评测镜像' : '新增评测镜像'" :unmount-on-hide="true">
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
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showForm = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">editingItem ? '保存' : '新增'</UButton>
    </template>
  </UModal>

  <!-- 删除确认弹窗 -->
  <UModal v-model:open="showDeleteConfirm" :title="'删除评测镜像'" :unmount-on-hide="true">
    <p>确定要删除评测镜像 <strong>{{ deleteTarget?.image }}</strong> 吗？此操作将导致使用了此镜像的题目无法通过白名单校验。</p>
    <p v-if="formError" class="text-error-text text-[13px]">{{ formError }}</p>
  
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">取消</UButton>
      <UButton color="error" :loading="deleting" @click="handleDelete">确认删除</UButton>
    </template>
  </UModal>
</template>
