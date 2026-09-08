<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import type { AdminColumn } from "~/components/admin/AdminTable.vue"
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
  cost_per_1k_tokens: number
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

const columns: AdminColumn[] = [
  { key: "name", label: "名称" },
  { key: "base_url", label: "Base URL" },
  { key: "model", label: "默认模型" },
  { key: "cost_per_1k_tokens", label: "费用/1K token" },
  { key: "api_key_masked", label: "API Key" },
  { key: "enabled", label: "状态" },
  { key: "created_at", label: "创建时间" },
  { key: "actions", label: "操作" },
]

// 加载 Provider 列表；用 requestVersion 防止快速切换时的旧响应覆盖新数据
async function loadItems() {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: LlmProvider[] }>("/api/v1/admin/gateway/llm/providers", { silent: true })
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
const formCostPer1k = ref(0)
const formApiKey = ref("")
const formEnabled = ref(true)
const saving = ref(false)
const formError = ref("")

// 打开新增表单并清空状态
function openCreate() {
  editingItem.value = null
  formName.value = ""
  formBaseUrl.value = ""
  formModel.value = ""
  formCostPer1k.value = 0
  formApiKey.value = ""
  formEnabled.value = true
  formError.value = ""
  showForm.value = true
}

// 打开编辑表单；API Key 留空表示不修改
function openEdit(item: LlmProvider) {
  editingItem.value = item
  formName.value = item.name
  formBaseUrl.value = item.base_url
  formModel.value = item.model
  formCostPer1k.value = item.cost_per_1k_tokens ?? 0
  formApiKey.value = ""
  formEnabled.value = item.enabled
  formError.value = ""
  showForm.value = true
}

// 保存 Provider：编辑时未填 Key 则不更新；新增时 Key 必填
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
        cost_per_1k_tokens: Number(formCostPer1k.value) || 0,
        enabled: formEnabled.value,
      }
      if (formApiKey.value.trim()) payload.api_key = formApiKey.value.trim()
      await api.put(`/api/v1/admin/gateway/llm/providers/${editingItem.value.id}`, payload, {
        headers: { "If-Match": `"${editingItem.value.updated_at}"` },
      })
    } else {
      if (!formApiKey.value.trim()) {
        formError.value = "API Key 为必填"
        saving.value = false
        return
      }
      await api.post("/api/v1/admin/gateway/llm/providers", {
        name: formName.value.trim(),
        base_url: formBaseUrl.value.trim(),
        model: formModel.value.trim(),
        cost_per_1k_tokens: Number(formCostPer1k.value) || 0,
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
    <AdminPageHeader title="LLM Provider 管理" description="配置上游 OpenAI 兼容服务（Key 加密存储，永不回显明文）">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新增 Provider
        </UButton>
      </template>
    </AdminPageHeader>

    <AdminTable
      :columns="columns"
      :items="items as unknown as Record<string, unknown>[]"
      :loading="tableLoading"
      :error="tableError || undefined"
      :total-pages="1"
      :current-page="1"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'enabled'">
          {{ (row as unknown as LlmProvider).enabled ? "启用" : "停用" }}
        </template>
        <template v-else-if="column.key === 'created_at'">
          <span v-if="!isNaN(new Date((row as unknown as LlmProvider).created_at).getTime())">{{ new Date((row as unknown as LlmProvider).created_at).toLocaleString("zh-CN") }}</span>
          <span v-else>-</span>
        </template>
      </template>
      <template #actions="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row as unknown as LlmProvider)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </AdminTable>
  </div>

  <UModal v-model:open="showForm" :title="editingItem ? '编辑 LLM Provider' : '新增 LLM Provider'" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
          <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal" placeholder="如：学校 OpenAI 兼容网关" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">Base URL <span class="text-error-text">*</span></label>
          <input v-model="formBaseUrl" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal" placeholder="如：https://api.openai.com/v1" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">默认模型 <span class="text-error-text">*</span></label>
          <input v-model="formModel" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal" placeholder="如：qwen-plus" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">费用 / 1K token</label>
          <input v-model.number="formCostPer1k" type="number" min="0" step="0.01" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal" placeholder="0" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">API Key {{ editingItem ? "（留空则保持不变）" : "" }} <span v-if="!editingItem" class="text-error-text">*</span></label>
          <input v-model="formApiKey" type="password" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-signal" placeholder="sk-..." />
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
