<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import type { AdminColumn } from "~/components/admin/AdminTable.vue"
import { extractApiError } from "~/utils/apiError"
import {
  buildQuotaPayload,
  findDuplicateQuota,
  formatQuotaLimit,
  isPlaceholderQuota,
  type LlmQuotaRow,
  QUOTA_SCOPE_OPTIONS,
  QUOTA_WINDOW_OPTIONS,
  type QuotaForm,
  type QuotaScopeType,
  scopeLabel,
  validateQuotaForm,
  windowLabel,
} from "~/utils/llmQuota"

definePageMeta({
  layout: "admin",
  middleware: "admin",
  ssr: false,
})

const { isLoggedIn } = useAuth()
useRequireLogin()

const { api } = useApi()
const { toast } = useToast()
const items = ref<LlmQuotaRow[]>([])
const tableLoading = ref(true)
const tableError = ref("")
let requestVersion = 0

// 作用域筛选（纯前端过滤：gateway 一次返回全部配额行）。
// USelect 不允许空串作为选项值，"全部"用 all 哨兵表示
const filterScope = ref<QuotaScopeType | "all">("all")
const filterItems = [
  { label: "全部", value: "all" },
  ...QUOTA_SCOPE_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
]
const filteredItems = computed(() =>
  filterScope.value === "all" ? items.value : items.value.filter((r) => r.scope_type === filterScope.value)
)

const columns: AdminColumn[] = [
  { key: "scope_type", label: "作用域" },
  { key: "scope_id", label: "作用域 ID" },
  { key: "window_type", label: "窗口" },
  { key: "max_calls", label: "调用次数上限" },
  { key: "max_tokens", label: "Token 上限" },
  { key: "max_cost", label: "成本上限" },
  { key: "updated_at", label: "更新时间" },
  { key: "actions", label: "操作" },
]

// 加载配额列表；用 requestVersion 防止旧响应覆盖新数据
async function loadItems() {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: LlmQuotaRow[] }>("/api/v1/admin/gateway/llm/quotas", { silent: true })
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
const editingItem = ref<LlmQuotaRow | null>(null)
const form = reactive<QuotaForm>({
  scope_type: "user",
  scope_id: "",
  window_type: "day",
  max_calls: "",
  max_tokens: "",
  max_cost: "",
})
const saving = ref(false)
const formError = ref("")

const scopeHint = computed(() => QUOTA_SCOPE_OPTIONS.find((o) => o.value === form.scope_type)?.hint ?? "")

/**
 * 新增时若同键 (scope/scope_id/window) 已存在，改为更新已有行：
 * gateway 按 id upsert，不带 id 会插入重复行且命中不确定。
 */
const duplicate = computed(() =>
  editingItem.value ? undefined : findDuplicateQuota(items.value, form.scope_type, form.scope_id, form.window_type)
)

// 打开新增表单；限额留空表示使用 gateway 环境变量默认值
function openCreate() {
  editingItem.value = null
  Object.assign(form, {
    scope_type: "user",
    scope_id: "",
    window_type: "day",
    max_calls: "",
    max_tokens: "",
    max_cost: "",
  })
  formError.value = ""
  showForm.value = true
}

// 打开编辑表单；作用域三元组是计数键，编辑时只读
function openEdit(item: LlmQuotaRow) {
  editingItem.value = item
  Object.assign(form, {
    scope_type: item.scope_type,
    scope_id: item.scope_id,
    window_type: item.window_type,
    max_calls: item.max_calls,
    max_tokens: item.max_tokens,
    max_cost: item.max_cost,
  })
  formError.value = ""
  showForm.value = true
}

// v-model.number 清空输入时会得到 ""，这里统一回写为空串
function onLimitInput(key: "max_calls" | "max_tokens" | "max_cost", event: Event) {
  const raw = (event.target as HTMLInputElement).value
  form[key] = raw === "" ? "" : Number(raw)
}

async function handleSave() {
  const error = validateQuotaForm(form, !editingItem.value && !duplicate.value)
  if (error) {
    formError.value = error
    return
  }
  saving.value = true
  formError.value = ""
  try {
    const targetId = editingItem.value?.id ?? duplicate.value?.id
    await api.post("/api/v1/admin/gateway/llm/quotas", buildQuotaPayload(form, targetId))
    showForm.value = false
    await loadItems()
    toast.success(targetId ? "配额已更新" : "配额已新增")
  } catch (err: unknown) {
    formError.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}

function formatTime(value: string) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN")
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AdminPageHeader title="LLM 配额" description="按全局 / 用户 / 题目 / 用户×题目维度配置每日、每月的调用次数、Token 与成本上限">
      <template #actions>
        <UButton color="primary" size="sm" @click="openCreate">
          <UIcon name="i-lucide-plus" class="size-4" />
          新增配额
        </UButton>
      </template>
    </AdminPageHeader>

    <div class="flex flex-col gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-13px text-blue-900">
      <p class="m-0 flex items-center gap-1.5 font-semibold">
        <UIcon name="i-lucide-info" class="size-4" />
        生效规则
      </p>
      <ul class="m-0 list-disc pl-5 leading-relaxed">
        <li>按「作用域 + 作用域 ID + 窗口」精确匹配；没有对应行时使用网关环境变量 <code class="font-mono">NOJ_LLM_DEFAULT_*</code> 的默认值。</li>
        <li>上限取值：<code class="font-mono">-1</code> 不限，<code class="font-mono">0</code> 禁止调用，正数为上限。成本单位与 Provider 的「费用 / 1K token」一致。</li>
        <li>窗口按 UTC 自然日 / 自然月重置。修改后对下一次调用立即生效。</li>
      </ul>
    </div>

    <div class="flex flex-wrap items-end gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-13px font-semibold text-text">作用域</label>
        <USelect
          v-model="filterScope"
          :items="filterItems"
          class="w-40"
        />
      </div>
      <span class="pb-2 text-xs text-text-muted tabular-nums">共 {{ filteredItems.length }} 条</span>
    </div>

    <AdminTable
      :columns="columns"
      :items="filteredItems as unknown as Record<string, unknown>[]"
      :loading="tableLoading"
      :error="tableError || undefined"
      :total-pages="1"
      :current-page="1"
    >
      <template #cell="{ row, column }">
        <template v-if="column.key === 'scope_type'">
          {{ scopeLabel((row as unknown as LlmQuotaRow).scope_type) }}
        </template>
        <template v-else-if="column.key === 'scope_id'">
          <UBadge
            v-if="isPlaceholderQuota(row as unknown as LlmQuotaRow)"
            color="neutral"
            variant="subtle"
            size="sm"
            title="seed 写入的占位行：计数按具体 ID 精确匹配，此行不会命中任何调用；默认值请改网关 env NOJ_LLM_DEFAULT_*"
          >占位（不生效）</UBadge>
          <span v-else class="font-mono text-xs">{{ (row as unknown as LlmQuotaRow).scope_id || "—" }}</span>
        </template>
        <template v-else-if="column.key === 'window_type'">
          {{ windowLabel((row as unknown as LlmQuotaRow).window_type) }}
        </template>
        <template v-else-if="column.key === 'max_calls' || column.key === 'max_tokens' || column.key === 'max_cost'">
          <span
            class="tabular-nums"
            :class="Number(row[column.key]) === 0 ? 'text-error-text font-semibold' : ''"
          >{{ formatQuotaLimit(Number(row[column.key])) }}</span>
        </template>
        <template v-else-if="column.key === 'updated_at'">
          {{ formatTime((row as unknown as LlmQuotaRow).updated_at) }}
        </template>
      </template>
      <template #actions="{ row }">
        <div class="flex gap-1.5 justify-center">
          <UButton color="neutral" variant="outline" class="flex w-9 h-9 border-border text-text-secondary hover:bg-primary-bg hover:text-text" title="编辑" aria-label="编辑" @click="openEdit(row as unknown as LlmQuotaRow)">
            <UIcon name="i-lucide-pencil" class="size-3.5" />
          </UButton>
        </div>
      </template>
    </AdminTable>
  </div>

  <!-- 配额编辑抽屉 -->
  <AdminEditPanel
    :open="showForm"
    :title="editingItem ? '编辑 LLM 配额' : '新增 LLM 配额'"
    :loading="saving"
    :save-text="editingItem || duplicate ? '保存配额' : '立即新增'"
    @close="showForm = false"
    @save="handleSave"
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">作用域 <span class="text-error-text">*</span></label>
        <USelect
          v-model="form.scope_type"
          :items="QUOTA_SCOPE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))"
          :disabled="!!editingItem"
        />
      </div>
      <div v-if="form.scope_type !== 'global'" class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">作用域 ID <span class="text-error-text">*</span></label>
        <input
          v-model="form.scope_id"
          :disabled="!!editingItem"
          class="px-3 py-2 font-mono text-sm border border-border rounded outline-none transition-colors duration-150 focus:border-primary disabled:bg-bg-sunken disabled:text-text-muted"
          :placeholder="form.scope_type === 'user_problem' ? '<用户 UUID>:<题目 UUID>' : 'UUID'"
        />
        <p class="m-0 text-xs text-text-muted">{{ scopeHint }}</p>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">窗口 <span class="text-error-text">*</span></label>
        <USelect
          v-model="form.window_type"
          :items="QUOTA_WINDOW_OPTIONS.map((o) => ({ label: o.label, value: o.value }))"
          :disabled="!!editingItem"
        />
      </div>
      <p v-if="editingItem && isPlaceholderQuota(editingItem)" class="m-0 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        这是网关 seed 写入的占位行（作用域 ID 为空），不会命中任何调用，修改它不会改变实际限额。要调整默认值请修改网关环境变量 <code class="font-mono">NOJ_LLM_DEFAULT_*</code>；要限制具体对象请新增一条带作用域 ID 的配额。
      </p>
      <p v-else-if="editingItem" class="m-0 text-xs text-text-muted">作用域与窗口是计数键，创建后不可修改；如需调整请新增一条配额。</p>
      <p v-else-if="duplicate" class="m-0 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        该作用域与窗口已有配额，保存将更新已有记录而不是新增。
      </p>

      <div v-for="field in ([['max_calls', '调用次数上限'], ['max_tokens', 'Token 上限'], ['max_cost', '成本上限']] as const)" :key="field[0]" class="flex flex-col gap-1">
        <label class="text-xs font-semibold text-text">{{ field[1] }}</label>
        <input
          :value="form[field[0]]"
          type="number"
          min="-1"
          step="1"
          class="px-3 py-2 text-sm tabular-nums border border-border rounded outline-none transition-colors duration-150 focus:border-primary"
          :placeholder="editingItem || duplicate ? '' : '留空使用网关默认值'"
          @input="onLimitInput(field[0], $event)"
        />
      </div>
      <p class="m-0 text-xs text-text-muted">-1 不限，0 禁止调用。</p>
      <p v-if="formError" class="text-error-text text-xs">{{ formError }}</p>
    </div>
  </AdminEditPanel>
</template>
