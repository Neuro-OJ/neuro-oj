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
  // ID 必须可见：平台默认 LLM 配置（llm_default_provider_id）要求填 gateway
  // 内部 UUID，而此前列表不展示 id，运营者无从获取（2026-09-22 评审发现）。
  { key: "id", label: "Provider ID" },
  { key: "base_url", label: "Base URL" },
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

// ─── 平台默认 Provider / 模型 ─────────────────────────────
// 两项是 noj-core 的 runtime 系统设置；此前只能在「系统设置」的平铺长表里找，
// 运营者建完 Provider 后不知道还要去那里填模型，LLM 题提交直接 400。
// 这里复用系统设置的通用读写接口，就近提供配置入口。

const DEFAULT_PROVIDER_KEY = "llm_default_provider_id"
const DEFAULT_MODEL_KEY = "llm_default_model"

interface PlatformSetting {
  key: string
  effective_value: unknown
  source: "db" | "env" | "default"
  updated_at: string | null
}

const SOURCE_LABEL: Record<PlatformSetting["source"], string> = {
  db: "后台设置",
  env: "环境变量",
  default: "未配置",
}

const defaultSettings = ref<Record<string, PlatformSetting>>({})
const defaultLoading = ref(true)
const defaultError = ref("")
const defaultSaving = ref(false)
const formDefaultProviderId = ref("")
const formDefaultModel = ref("")

function settingString(key: string): string {
  return String(defaultSettings.value[key]?.effective_value ?? "").trim()
}

const currentDefaultProviderId = computed(() => settingString(DEFAULT_PROVIDER_KEY))
const currentDefaultModel = computed(() => settingString(DEFAULT_MODEL_KEY))
function sourceLabel(key: string): string {
  const source = defaultSettings.value[key]?.source
  return source ? SOURCE_LABEL[source] : ""
}
const providerSourceLabel = computed(() => sourceLabel(DEFAULT_PROVIDER_KEY))
const modelSourceLabel = computed(() => sourceLabel(DEFAULT_MODEL_KEY))
const defaultConfigured = computed(() =>
  !!currentDefaultProviderId.value && !!currentDefaultModel.value
)
const defaultDirty = computed(() =>
  formDefaultProviderId.value.trim() !== currentDefaultProviderId.value ||
  formDefaultModel.value.trim() !== currentDefaultModel.value
)

/** 当前已生效的默认 Provider 在列表中的状态（用于提示 ID 失效 / 已停用） */
const defaultProviderWarning = computed(() => {
  const id = currentDefaultProviderId.value
  if (!id || tableLoading.value || tableError.value) return ""
  const provider = items.value.find((p) => p.id === id)
  if (!provider) return "当前默认 Provider ID 在列表中不存在，LLM 题提交会失败，请重新选择"
  if (!provider.enabled) return `当前默认 Provider「${provider.name}」已停用，LLM 题提交会失败`
  return ""
})

async function loadPlatformDefault() {
  if (!isLoggedIn.value) return
  defaultLoading.value = true
  defaultError.value = ""
  try {
    const res = await api.get<{ data: PlatformSetting[] }>("/api/v1/admin/system/settings", { silent: true })
    const next: Record<string, PlatformSetting> = {}
    for (const s of res.data) {
      if (s.key === DEFAULT_PROVIDER_KEY || s.key === DEFAULT_MODEL_KEY) next[s.key] = s
    }
    defaultSettings.value = next
    formDefaultProviderId.value = settingString(DEFAULT_PROVIDER_KEY)
    formDefaultModel.value = settingString(DEFAULT_MODEL_KEY)
  } catch (err: unknown) {
    defaultError.value = extractApiError(err).message
  } finally {
    defaultLoading.value = false
  }
}

watch(isLoggedIn, (val) => { if (val) loadPlatformDefault() }, { immediate: true })

// 两项必须同时配置（noj-core 无回退），只提交有变化的键
async function savePlatformDefault() {
  const providerId = formDefaultProviderId.value.trim()
  const model = formDefaultModel.value.trim()
  if (!providerId || !model) {
    defaultError.value = "默认 Provider 与默认模型需同时填写"
    return
  }
  defaultSaving.value = true
  defaultError.value = ""
  try {
    const changes: [string, string][] = [
      [DEFAULT_PROVIDER_KEY, providerId],
      [DEFAULT_MODEL_KEY, model],
    ]
    for (const [key, value] of changes) {
      if (value === settingString(key)) continue
      const updatedAt = defaultSettings.value[key]?.updated_at
      const res = await api.put<{ data: PlatformSetting }>(`/api/v1/admin/system/settings/${key}`, { value }, {
        silent: true,
        headers: updatedAt ? { "If-Match": `"${updatedAt}"` } : undefined,
      })
      defaultSettings.value = { ...defaultSettings.value, [key]: res.data }
    }
    toast.success("平台默认 LLM 配置已保存")
  } catch (err: unknown) {
    defaultError.value = extractApiError(err).message
  } finally {
    defaultSaving.value = false
  }
}

const showForm = ref(false)
const editingItem = ref<LlmProvider | null>(null)
const formName = ref("")
const formBaseUrl = ref("")
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
  formCostPer1k.value = item.cost_per_1k_tokens ?? 0
  formApiKey.value = ""
  formEnabled.value = item.enabled
  formError.value = ""
  showForm.value = true
}

// 保存 Provider：编辑时未填 Key 则不更新；新增时 Key 必填
async function handleSave() {
  if (!formName.value.trim() || !formBaseUrl.value.trim()) {
    formError.value = "名称与 Base URL 均为必填"
    return
  }
  saving.value = true
  formError.value = ""
  try {
    if (editingItem.value) {
      const payload: Record<string, unknown> = {
        name: formName.value.trim(),
        base_url: formBaseUrl.value.trim(),
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

// ─── 连接测试 ─────────────────────────────────────────────
// gateway 用已保存的 Key 向上游发起 1 token 的真实请求，验证 Base URL / Key / 模型。
// 上游不通（鉴权失败、限流、超时等）以 status=failed 返回原因，不走错误提示。

interface ProviderTestResult {
  status: "ok" | "failed"
  model: string
  latency_ms: number
  code?: string
  message?: string
}

const showTest = ref(false)
const testingItem = ref<LlmProvider | null>(null)
const testModel = ref("")
const testing = ref(false)
const testResult = ref<ProviderTestResult | null>(null)
const testError = ref("")

// 打开连接测试面板；模型默认取平台默认模型
function openTest(item: LlmProvider) {
  testingItem.value = item
  testModel.value = currentDefaultModel.value
  testResult.value = null
  testError.value = ""
  showTest.value = true
}

async function runTest() {
  if (!testingItem.value) return
  const model = testModel.value.trim()
  if (!model) {
    testError.value = "请填写要测试的模型名称"
    return
  }
  testing.value = true
  testResult.value = null
  testError.value = ""
  try {
    const res = await api.post<{ data: ProviderTestResult }>(
      `/api/v1/admin/gateway/llm/providers/${testingItem.value.id}/test`,
      { model },
      { silent: true },
    )
    testResult.value = res.data
  } catch (err: unknown) {
    testError.value = extractApiError(err).message
  } finally {
    testing.value = false
  }
}

// ─── 模型别名 ─────────────────────────────────────────────
// 题目只引用别名（default 恒等于上方平台默认）；这里维护 别名 → Provider + 真实模型。
// 改映射只影响此后新建的评测尝试，已冻结的尝试与重测不受影响。

interface ModelAlias {
  alias: string
  provider_id: string
  model: string
  description: string
  updated_at: string
  problem_count: number
}

const aliases = ref<ModelAlias[]>([])
const aliasLoading = ref(true)
const aliasError = ref("")
const showAliasForm = ref(false)
const editingAlias = ref<ModelAlias | null>(null)
const aliasName = ref("")
const aliasProviderId = ref("")
const aliasModel = ref("")
const aliasDescription = ref("")
const aliasSaving = ref(false)
const aliasFormError = ref("")

function providerName(id: string): string {
  return items.value.find((p) => p.id === id)?.name ?? `未知（${id.slice(0, 8)}）`
}

async function loadAliases() {
  if (!isLoggedIn.value) return
  aliasLoading.value = true
  aliasError.value = ""
  try {
    const res = await api.get<{ data: ModelAlias[] }>("/api/v1/admin/gateway/llm/model-aliases", { silent: true })
    aliases.value = res.data
  } catch (err: unknown) {
    aliasError.value = extractApiError(err).message
  } finally {
    aliasLoading.value = false
  }
}

watch(isLoggedIn, (val) => { if (val) loadAliases() }, { immediate: true })

function openAliasCreate() {
  editingAlias.value = null
  aliasName.value = ""
  aliasProviderId.value = currentDefaultProviderId.value || items.value[0]?.id || ""
  aliasModel.value = ""
  aliasDescription.value = ""
  aliasFormError.value = ""
  showAliasForm.value = true
}

function openAliasEdit(item: ModelAlias) {
  editingAlias.value = item
  aliasName.value = item.alias
  aliasProviderId.value = item.provider_id
  aliasModel.value = item.model
  aliasDescription.value = item.description
  aliasFormError.value = ""
  showAliasForm.value = true
}

async function saveAlias() {
  const alias = aliasName.value.trim()
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) {
    aliasFormError.value = "别名须以小写字母开头，仅含小写字母、数字、_、-，且不超过 32 字符"
    return
  }
  if (alias === "default") {
    aliasFormError.value = "default 是保留别名，请在上方「平台默认 Provider / 模型」中配置"
    return
  }
  if (!aliasProviderId.value || !aliasModel.value.trim()) {
    aliasFormError.value = "Provider 与模型均为必填"
    return
  }
  aliasSaving.value = true
  aliasFormError.value = ""
  try {
    await api.put(`/api/v1/admin/gateway/llm/model-aliases/${encodeURIComponent(alias)}`, {
      provider_id: aliasProviderId.value,
      model: aliasModel.value.trim(),
      description: aliasDescription.value.trim(),
    }, { silent: true })
    showAliasForm.value = false
    await loadAliases()
    toast.success("模型别名已保存")
  } catch (err: unknown) {
    aliasFormError.value = extractApiError(err).message
  } finally {
    aliasSaving.value = false
  }
}

async function removeAlias(item: ModelAlias) {
  const used = item.problem_count > 0
  const tip = used
    ? `别名「${item.alias}」被 ${item.problem_count} 道题引用，删除后这些题的提交会失败（已冻结的重测不受影响）。确定强制删除？`
    : `确定删除别名「${item.alias}」？`
  if (!window.confirm(tip)) return
  try {
    await api.delete(`/api/v1/admin/gateway/llm/model-aliases/${encodeURIComponent(item.alias)}${used ? "?force=true" : ""}`, { silent: true })
    await loadAliases()
    toast.success("模型别名已删除")
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
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

    <!-- 平台默认 Provider / 模型（LLM 题评测必需，两项须同时配置） -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border bg-bg-page flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-sliders-horizontal" class="size-4 text-primary" />
          <h2 class="text-base font-semibold text-text">平台默认 Provider / 模型</h2>
          <span
            v-if="!defaultLoading"
            class="text-11px px-1.5 py-0.5 rounded font-medium"
            :class="defaultConfigured ? 'bg-success-bg text-success-text' : 'bg-error-bg text-error-text'"
          >
            {{ defaultConfigured ? "已配置" : "未配置" }}
          </span>
        </div>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3">
        <p class="text-xs text-text-secondary">
          所有 LLM 题评测统一使用此处的 Provider 与模型；两项须同时配置，否则 LLM 题提交会被拒绝。保存后即时生效，无需重启。
        </p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-text">
              默认 Provider
              <span v-if="providerSourceLabel" class="ml-1 font-normal text-text-muted">
                （来源：{{ providerSourceLabel }}）
              </span>
            </label>
            <select
              v-model="formDefaultProviderId"
              :disabled="defaultLoading"
              class="px-3 py-2 text-sm border border-border rounded outline-none bg-white transition-colors duration-150 focus:border-primary disabled:opacity-50"
            >
              <option value="">请选择 Provider</option>
              <option
                v-if="formDefaultProviderId && !items.some((p) => p.id === formDefaultProviderId)"
                :value="formDefaultProviderId"
              >
                未知 Provider（{{ formDefaultProviderId }}）
              </option>
              <option v-for="p in items" :key="p.id" :value="p.id">
                {{ p.name }}{{ p.enabled ? "" : "（已停用）" }}
              </option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-text">
              默认模型
              <span v-if="modelSourceLabel" class="ml-1 font-normal text-text-muted">
                （来源：{{ modelSourceLabel }}）
              </span>
            </label>
            <input
              v-model="formDefaultModel"
              :disabled="defaultLoading"
              class="px-3 py-2 text-sm font-mono border border-border rounded outline-none transition-colors duration-150 focus:border-primary disabled:opacity-50"
              placeholder="如：gpt-4o-mini / qwen-plus / deepseek-chat"
            />
          </div>
        </div>
        <p v-if="defaultProviderWarning" class="text-warning-text text-xs">{{ defaultProviderWarning }}</p>
        <p v-if="defaultError" class="text-error-text text-xs">{{ defaultError }}</p>
        <div class="flex justify-end">
          <UButton
            color="primary"
            size="sm"
            :loading="defaultSaving"
            :disabled="defaultLoading || !defaultDirty"
            @click="savePlatformDefault"
          >
            保存默认配置
          </UButton>
        </div>
      </div>
    </section>


    <!-- 模型别名（题目只引用别名；default 即上方平台默认） -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border bg-bg-page flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-tags" class="size-4 text-primary" />
          <h2 class="text-base font-semibold text-text">模型别名</h2>
        </div>
        <UButton color="primary" size="sm" variant="outline" @click="openAliasCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新增别名
        </UButton>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3">
        <p class="text-xs text-text-secondary">
          出题人为每道题选择允许调用的别名；<span class="font-mono">default</span> 恒等于上方平台默认。改映射只影响此后新建的评测，已冻结的评测与重测仍使用当时的模型。同一道题的别名须属于同一 Provider。
        </p>
        <p v-if="aliasError" class="text-error-text text-xs">{{ aliasError }}</p>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-text-secondary border-b border-border">
              <th class="py-1.5 pr-3 font-semibold">别名</th>
              <th class="py-1.5 pr-3 font-semibold">Provider</th>
              <th class="py-1.5 pr-3 font-semibold">真实模型</th>
              <th class="py-1.5 pr-3 font-semibold">说明</th>
              <th class="py-1.5 pr-3 font-semibold">引用题数</th>
              <th class="py-1.5 font-semibold text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-b border-border/60 text-text-muted">
              <td class="py-1.5 pr-3 font-mono">default</td>
              <td class="py-1.5 pr-3">{{ currentDefaultProviderId ? providerName(currentDefaultProviderId) : "未配置" }}</td>
              <td class="py-1.5 pr-3 font-mono">{{ currentDefaultModel || "未配置" }}</td>
              <td class="py-1.5 pr-3">平台默认（在上方配置）</td>
              <td class="py-1.5 pr-3">-</td>
              <td class="py-1.5"></td>
            </tr>
            <tr v-for="a in aliases" :key="a.alias" class="border-b border-border/60">
              <td class="py-1.5 pr-3 font-mono">{{ a.alias }}</td>
              <td class="py-1.5 pr-3">{{ providerName(a.provider_id) }}</td>
              <td class="py-1.5 pr-3 font-mono">{{ a.model }}</td>
              <td class="py-1.5 pr-3">{{ a.description || "-" }}</td>
              <td class="py-1.5 pr-3 tabular-nums">{{ a.problem_count }}</td>
              <td class="py-1.5 text-right">
                <div class="flex gap-1.5 justify-end">
                  <UButton color="neutral" variant="outline" size="xs" title="编辑" aria-label="编辑" @click="openAliasEdit(a)">
                    <UIcon name="i-lucide-pencil" class="size-3.5" />
                  </UButton>
                  <UButton color="neutral" variant="outline" size="xs" title="删除" aria-label="删除" @click="removeAlias(a)">
                    <UIcon name="i-lucide-trash-2" class="size-3.5" />
                  </UButton>
                </div>
              </td>
            </tr>
            <tr v-if="!aliasLoading && aliases.length === 0">
              <td colspan="6" class="py-3 text-center text-xs text-text-muted">尚未配置自定义别名，所有 LLM 题使用 default</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <AdminTable
      :columns="columns"
      :items="items as unknown as Record<string, unknown>[]"
      :loading="tableLoading"
      :error="tableError || undefined"
      :total-pages="1"
      :current-page="1"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'name'">
          {{ (row as unknown as LlmProvider).name }}
          <span
            v-if="(row as unknown as LlmProvider).id === currentDefaultProviderId"
            class="ml-1 text-11px px-1.5 py-0.5 rounded font-medium bg-success-bg text-success-text"
          >默认</span>
        </template>
        <template v-else-if="column.key === 'enabled'">
          {{ (row as unknown as LlmProvider).enabled ? "启用" : "停用" }}
        </template>
        <template v-else-if="column.key === 'created_at'">
          <span v-if="!isNaN(new Date((row as unknown as LlmProvider).created_at).getTime())">{{ new Date((row as unknown as LlmProvider).created_at).toLocaleString("zh-CN") }}</span>
          <span v-else>-</span>
        </template>
      </template>
      <template #actions="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="测试连接" aria-label="测试连接" @click="openTest(row as unknown as LlmProvider)">
            <UIcon name="i-lucide-plug-zap" class="size-3.5" />
          </UButton>
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row as unknown as LlmProvider)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </AdminTable>
  </div>

  <!-- Provider 编辑抽屉 (Slideover) -->
  <AdminEditPanel
    :open="showForm"
    :title="editingItem ? '编辑 LLM Provider' : '新增 LLM Provider'"
    :loading="saving"
    :save-text="editingItem ? '保存 Provider' : '立即新增'"
    @close="showForm = false"
    @save="handleSave"
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">名称 <span class="text-error-text">*</span></label>
        <input v-model="formName" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：学校 OpenAI 兼容网关" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">Base URL <span class="text-error-text">*</span></label>
        <input v-model="formBaseUrl" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：https://api.openai.com/v1" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">费用 / 1K token</label>
        <input v-model.number="formCostPer1k" type="number" min="0" step="0.01" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="0" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">API Key {{ editingItem ? "（留空则保持不变）" : "" }} <span v-if="!editingItem" class="text-error-text">*</span></label>
        <input v-model="formApiKey" type="password" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="sk-..." />
      </div>
      <div class="flex items-center gap-2 pt-1">
        <USwitch v-model="formEnabled" />
        <span class="text-xs text-text-secondary font-medium">启用此 Provider</span>
      </div>
      <p v-if="formError" class="text-error-text text-xs">{{ formError }}</p>
    </div>
  </AdminEditPanel>
  <!-- Provider 连接测试抽屉 -->
  <AdminEditPanel
    :open="showTest"
    :title="testingItem ? `测试连接：${testingItem.name}` : '测试连接'"
    :loading="testing"
    save-text="开始测试"
    @close="showTest = false"
    @save="runTest"
  >
    <div class="flex flex-col gap-3">
      <p class="text-xs text-text-secondary">
        使用已保存的 API Key 向 <span class="font-mono">{{ testingItem?.base_url }}</span> 发起一次 1 token 的真实请求（10 秒超时），会产生极少量费用。
      </p>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">模型 <span class="text-error-text">*</span></label>
        <input
          v-model="testModel"
          class="px-3 py-2 text-sm font-mono border border-border rounded outline-none transition-colors duration-150 focus:border-primary"
          placeholder="如：gpt-4o-mini / Qwen/Qwen3-8B"
          @keydown.enter="runTest"
        />
      </div>
      <p v-if="testError" class="text-error-text text-xs">{{ testError }}</p>
      <div
        v-if="testResult"
        class="flex items-start gap-2 px-3 py-2 rounded border text-sm"
        :class="testResult.status === 'ok' ? 'bg-success-bg border-success-text/30 text-success-text' : 'bg-error-bg border-error-text/30 text-error-text'"
      >
        <UIcon :name="testResult.status === 'ok' ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-4 mt-0.5 shrink-0" />
        <div class="flex flex-col gap-0.5">
          <span class="font-semibold">
            {{ testResult.status === "ok" ? "连接成功" : "连接失败" }}
            <span class="font-normal tabular-nums">（{{ testResult.latency_ms }} ms）</span>
          </span>
          <span v-if="testResult.message" class="text-xs">{{ testResult.message }}</span>
          <span class="text-xs font-mono opacity-80">{{ testResult.model }}{{ testResult.code ? ` · ${testResult.code}` : "" }}</span>
        </div>
      </div>
    </div>
  </AdminEditPanel>
  <!-- 模型别名编辑抽屉 -->
  <AdminEditPanel
    :open="showAliasForm"
    :title="editingAlias ? `编辑别名：${editingAlias.alias}` : '新增模型别名'"
    :loading="aliasSaving"
    save-text="保存别名"
    @close="showAliasForm = false"
    @save="saveAlias"
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">别名 <span class="text-error-text">*</span></label>
        <input v-model="aliasName" :disabled="!!editingAlias" class="px-3 py-2 text-sm font-mono border border-border rounded outline-none transition-colors duration-150 focus:border-primary disabled:opacity-60" placeholder="如：fast / reasoning" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">Provider <span class="text-error-text">*</span></label>
        <select v-model="aliasProviderId" class="px-3 py-2 text-sm border border-border rounded outline-none bg-white focus:border-primary">
          <option v-for="p in items" :key="p.id" :value="p.id">{{ p.name }}{{ p.enabled ? "" : "（已停用）" }}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">真实模型名 <span class="text-error-text">*</span></label>
        <input v-model="aliasModel" class="px-3 py-2 text-sm font-mono border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：Qwen/Qwen3-8B" />
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">说明（出题人可见，≤ 80 字）</label>
        <input v-model="aliasDescription" maxlength="80" class="px-3 py-2 text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary" placeholder="如：低延迟、低成本" />
      </div>
      <p v-if="aliasFormError" class="text-error-text text-xs">{{ aliasFormError }}</p>
    </div>
  </AdminEditPanel>
</template>
