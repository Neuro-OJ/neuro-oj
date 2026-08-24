<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import { extractApiError } from '~/utils/apiError'

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn } = useAuth()
useRequireLogin()

interface LlmProvider {
  id: string
  name: string
  base_url: string
  model: string
  api_key_masked: string
  enabled: boolean
  created_at: string
  updated_at: string
}

const { api } = useApi()
const items = ref<LlmProvider[]>([])
const tableLoading = ref(true)
const tableError = ref("")
const { toast } = useToast()
let requestVersion = 0

const columns = [
  { accessorKey: "name", header: "名称" },
  { accessorKey: "base_url", header: "Base URL" },
  { accessorKey: "model", header: "默认模型" },
  { accessorKey: "api_key_masked", header: "API Key" },
  {
    accessorKey: "enabled",
    header: "状态",
    cell: (info) => (info.getValue() ? "启用" : "停用"),
  },
  {
    accessorKey: "created_at",
    header: "创建时间",
    cell: (info) => {
      const d = new Date(info.getValue() as string)
      return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
    },
  },
  { accessorKey: "actions", header: "操作" },
]

async function loadItems() {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: LlmProvider[] }>("/api/v1/admin/llm/providers", { silent: true })
    if (currentRequest !== requestVersion) return
    items.value = res.data
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    tableError.value = extractApiError(err).message
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => { if (val) loadItems() }, { immediate: true })

const showForm = ref(false)
const editingItem = ref<LlmProvider | null>(null)
const formName = ref("")
const formBaseUrl = ref("")
const formModel = ref("")
const formApiKey = ref("")
const formEnabled = ref(true)
const saving = ref(false)
const formError = ref("")

function openCreate() {
  editingItem.value = null
  formName.value = ""
  formBaseUrl.value = ""
  formModel.value = ""
  formApiKey.value = ""
  formEnabled.value = true
  formError.value = ""
  showForm.value = true
}

function openEdit(item: LlmProvider) {
  editingItem.value = item
  formName.value = item.name
  formBaseUrl.value = item.base_url
  formModel.value = item.model
  formApiKey.value = ""
  formEnabled.value = item.enabled
  formError.value = ""
  showForm.value = true
}

async function handleSave() {
  if (!formName.value.trim() || !formBaseUrl.value.trim() || !formModel.value.trim()) {
    formError.value = "名称、Base URL 与默认模型均为必填"
    return
  }
  saving.value = true
  formError.value = ""
  try {
    if (editingItem.value) {
      const payload: Record<string, unknown> = {
        name: formName.value.trim(),
        base_url: formBaseUrl.value.trim(),
        model: formModel.value.trim(),
        enabled: formEnabled.value,
      }
      if (formApiKey.value.trim()) payload.api_key = formApiKey.value.trim()
      await api.put(`/api/v1/admin/llm/providers/${editingItem.value.id}`, payload)
    } else {
      if (!formApiKey.value.trim()) {
        formError.value = "API Key 为必填"
        saving.value = false
        return
      }
      await api.post("/api/v1/admin/llm/providers", {
        name: formName.value.trim(),
        base_url: formBaseUrl.value.trim(),
        model: formModel.value.trim(),
        api_key: formApiKey.value.trim(),
        enabled: formEnabled.value,
      })
    }
    showForm.value = false
    await loadItems()
    toast.success("LLM Provider 已保存")
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="LLM Provider 管理" description="配置上游 OpenAI 兼容服务（Key 加密存储，永不回显明文）">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新增 Provider
        </UButton>
      </template>
    </PageHeader>

    <div v-if="tableError" class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-sm text-error-text"><span>{{ tableError }}</span></div>
    <UTable
      :columns="columns"
      :data="items"
      :loading="tableLoading"
      :empty="'暂无 LLM Provider'">
      <template #actions-cell="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row.original)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </UTable>
  </div>

  <UModal v-model:open="showForm" :title="editingItem ? '编辑 LLM Provider' : '新增 LLM Provider'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
          <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：学校 OpenAI 兼容网关" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">Base URL <span class="text-error-text">*</span></label>
          <input v-model="formBaseUrl" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：https://api.openai.com/v1" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">默认模型 <span class="text-error-text">*</span></label>
          <input v-model="formModel" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：qwen-plus" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">API Key {{ editingItem ? "（留空则保持不变）" : "" }} <span v-if="!editingItem" class="text-error-text">*</span></label>
          <input v-model="formApiKey" type="password" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="sk-..." />
        </div>
        <div class="flex items-center gap-2">
          <USwitch v-model="formEnabled" />
          <span class="text-sm text-text-secondary">启用</span>
        </div>
        <p v-if="formError" class="text-error-text text-13px">{{ formError }}</p>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="showForm = false">取消</UButton>
      <UButton color="primary" :loading="saving" @click="handleSave">{{ editingItem ? '保存' : '新增' }}</UButton>
    </template>
  </UModal>
</template>
