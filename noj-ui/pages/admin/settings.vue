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

// ─── 类型定义 ────────────────────────────────────────────

type SettingType = "boolean" | "string" | "text" | "integer"
type SettingSource = "db" | "env" | "default"
type SettingCategory =
  | "auth"
  | "maintenance"
  | "email"
  | "rate_limit"
  | "storage"
  | "database"
  | "redis"
  | "cors"
  | "judge"
  | "review"
  | "other"

interface SystemSetting {
  key: string
  type: SettingType
  effective_value: unknown
  raw_value: string
  source: SettingSource
  is_secret: boolean
  description: string
  updated_at: string | null
  updated_by: string | null
  category: SettingCategory
  min?: number
  max?: number
  needsRestart?: boolean
}

const CATEGORY_LABEL: Record<SettingCategory, string> = {
  auth: "认证",
  maintenance: "维护与公告",
  email: "邮件",
  rate_limit: "速率限制",
  storage: "对象存储",
  database: "数据库",
  redis: "Redis",
  cors: "CORS",
  judge: "评测资源限制",
  review: "内容合规审核",
  other: "其他",
}

const { api } = useApi()

// ─── 数据加载 ────────────────────────────────────────────

const settings = ref<SystemSetting[]>([])
const tableLoading = ref(true)
const tableError = ref("")
let requestVersion = 0

async function loadSettings() {
  if (!isLoggedIn.value) return
  const currentRequest = ++requestVersion
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await api.get<{ data: SystemSetting[] }>(
      "/api/v1/admin/settings",
      { silent: true },
    )
    if (currentRequest !== requestVersion) return
    settings.value = res.data
    // 初始化草稿：普通字段同步当前值，敏感字段初始化为 null（需显式编辑）
    drafts.value = {}
    for (const s of res.data) {
      drafts.value[s.key] = s.is_secret ? null : s.effective_value
    }
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return
    tableError.value = extractApiError(err).message
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadSettings()
}, { immediate: true })

// ─── 草稿状态 ────────────────────────────────────────────

const drafts = ref<Record<string, unknown>>({})

/** infrastructure env-only 键名白名单（与 noj-core settings-registry 的 env-only 定义同步） */
const ENV_ONLY_KEYS = new Set([
  "DATABASE_URL", "DATABASE_POOL_MAX", "DATABASE_CONNECT_TIMEOUT",
  "DATABASE_IDLE_TIMEOUT", "DATABASE_MAX_LIFETIME",
  "REDIS_URL",
  "JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASS", "BCRYPT_SALT_ROUNDS",
  "CORS_ALLOWED_ORIGINS",
  "PORT", "NOJ_ENV",
])

const dbSettings = computed(() =>
  settings.value.filter((s) => !ENV_ONLY_KEYS.has(s.key))
)

const envOnlySettings = computed(() =>
  settings.value.filter((s) => ENV_ONLY_KEYS.has(s.key))
)

// 按 category 分组（spec 要求），未声明分类的归到 other
const envOnlyGrouped = computed(() => {
  const groups = new Map<SettingCategory, SystemSetting[]>()
  for (const s of envOnlySettings.value) {
    const cat = (s.category ?? "other") as SettingCategory
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(s)
  }
  // 固定分组顺序
  const order: SettingCategory[] = [
    "auth",
    "maintenance",
    "email",
    "rate_limit",
    "storage",
    "database",
    "redis",
    "cors",
    "other",
  ]
  return order
    .filter((c) => groups.has(c))
    .map((c) => ({ category: c, items: groups.get(c)! }))
})

/** UTable 列定义（env-only 只读面板） */
const envOnlyColumns = [
  { accessorKey: "key", header: "键名" },
  { accessorKey: "effective_value", header: "当前值" },
  { accessorKey: "description", header: "描述" },
]

/** 获取敏感字段的脱敏方式说明（显示在 tooltip 中） */
function getSecretTooltip(key: string): string {
  if (key === "DATABASE_URL") return "已脱敏：仅移除 user:password@，保留协议+主机+路径"
  if (key === "REDIS_URL") return "已脱敏：仅移除 :password@，保留协议+主机+路径"
  if (key === "JWT_SECRET") return "已脱敏：SHA-256 哈希（前16位），仅用于部署密钥比对"
  return "敏感值（已脱敏）"
}

/** 该 key 是否有未保存的修改 */
function isDirty(key: string): boolean {
  const s = settings.value.find((x) => x.key === key)
  if (!s) return false
  const draft = drafts.value[key]
  if (draft === null) return false // 敏感字段未显式编辑时不视为 dirty
  return !deepEqual(draft, s.effective_value)
}

/** 未保存修改项数（页面级标识用） */
const dirtyCount = computed(() => settings.value.filter((s) => isDirty(s.key)).length)

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b)
  return false
}

// ─── 保存单个设置 ─────────────────────────────────────────

const savingKeys = ref(new Set<string>())
const saveErrors = ref<Record<string, string>>({})
const { toast } = useToast()

function applySetting(item: SystemSetting) {
  const index = settings.value.findIndex((setting) => setting.key === item.key)
  if (index >= 0) settings.value.splice(index, 1, item)
  else settings.value.push(item)
  drafts.value[item.key] = item.is_secret ? null : item.effective_value
}

async function saveSetting(key: string) {
  // 敏感字段未显式编辑 → 跳过保存
  if (drafts.value[key] === null) return
  if (savingKeys.value.has(key)) return
  savingKeys.value = new Set(savingKeys.value).add(key)
  const errors = { ...saveErrors.value }
  delete errors[key]
  saveErrors.value = errors
  try {
    // silent: 错误由下方 catch 内联处理（saveErrors + 保留表单值），避免 useApi 默认 toast 双弹
    const res = await api.put<{ data: SystemSetting }>(`/api/v1/admin/settings/${key}`, {
      value: drafts.value[key],
    }, { silent: true })
    applySetting(res.data)
    // 检查是否需要重启生效
    const s = settings.value.find((x) => x.key === key)
    if (s?.needsRestart) {
      toast.success("设置已保存，需重启 noj-core 服务才能生效")
    } else {
      toast.success("设置已保存")
    }
  } catch (err: unknown) {
    // 内联错误提示：不丢失已填写的表单值
    saveErrors.value = { ...saveErrors.value, [key]: extractApiError(err).message }
  } finally {
    const next = new Set(savingKeys.value)
    next.delete(key)
    savingKeys.value = next
  }
}

// ─── 重置单个设置 ─────────────────────────────────────────

const resettingKeys = ref(new Set<string>())
const { dialog } = useDialog()

async function confirmReset(s: SystemSetting) {
  // spec 要求 SweetAlert2 弹窗，文案：
  // "确认将 XXX 重置为默认值？此操作不可撤销"
  // DELETE 是幂等的：DB 中无此行也不报错（直接回退到 env/default）
  const ok = await dialog({
    title: `确认将 ${s.key} 重置为默认值？`,
    text: "此操作不可撤销。数据库中保存的值将被删除，回退到 .env 环境变量或系统默认值。",
    icon: "warning",
    danger: true,
    confirmText: "确认重置",
  })
  if (!ok) return

  if (resettingKeys.value.has(s.key)) return
  resettingKeys.value = new Set(resettingKeys.value).add(s.key)
  const errors = { ...saveErrors.value }
  delete errors[s.key]
  saveErrors.value = errors
  try {
    // silent: 错误由下方 catch 内联处理（saveErrors），避免 useApi 默认 toast 双弹
    await api.delete(`/api/v1/admin/settings/${s.key}`, { silent: true })
    const res = await api.get<{ data: SystemSetting[] }>("/api/v1/admin/settings", { silent: true })
    const updated = res.data.find((item) => item.key === s.key)
    if (updated) applySetting(updated)
    toast.success(`已重置 ${s.key}`)
  } catch (err: unknown) {
    saveErrors.value = { ...saveErrors.value, [s.key]: extractApiError(err).message }
  } finally {
    const next = new Set(resettingKeys.value)
    next.delete(s.key)
    resettingKeys.value = next
  }
}

// ─── 编辑控件辅助 ─────────────────────────────────────────
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="系统设置" description="运行时可改的配置项，修改即时生效；只读配置需重启服务" />

    <!-- 未保存更改标识 -->
    <div
      v-if="dirtyCount > 0"
      class="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-13px text-amber-800"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 text-amber-600" />
      <span class="font-medium">有未保存的更改（{{ dirtyCount }} 项）</span>
      <span class="text-amber-700">修改后请逐项点击行内"保存"按钮写入数据库</span>
    </div>

    <!-- 顶部提示横幅 -->
    <div class="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md text-13px text-info-text">
      <UIcon name="i-lucide-info" class="size-4 shrink-0 mt-0.5" />
      <div>
        <strong>运行时可改：</strong>第一组设置项写入数据库，下次请求立即生效，可随时重置。
        <strong>只读配置：</strong>第二组（折叠面板）展示当前
        <code class="px-1 py-0.5 bg-blue-100 rounded font-mono text-[12px]">.env</code>
        中存在的环境变量，修改需更新 .env 并重启 noj-core 服务。
      </div>
    </div>

    <!-- 错误条 -->
    <div
      v-if="tableError"
      class="p-3 bg-red-50 border border-red-200 rounded-md text-13px text-error-text"
    >
      {{ tableError }}
      <UButton size="xs" color="primary" variant="ghost" @click="loadSettings">重试</UButton>
    </div>

    <!-- ─── 第一组：DB-backed 可编辑设置 ─────────────── -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border bg-bg-page">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-database" class="size-4 text-primary" />
          <h2 class="text-base font-semibold text-text">
            运行时配置（可编辑）
            <span class="ml-1 text-sm font-normal text-text-secondary">{{ dbSettings.length }} 项</span>
          </h2>
        </div>
        <p class="text-xs text-text-secondary mt-1">
          修改后点击行内「保存」按钮，写入数据库；点击「重置」恢复 env / 默认值
        </p>
        <p class="text-11px text-text-muted mt-0.5">
          读取优先级：<span class="font-semibold">DB 写入值</span> → env 值（.env） → 系统默认值。
          带 <UIcon name="i-lucide-refresh-cw" class="size-3 inline -mt-0.5 text-warning-text" /> 标记的项保存后需要重启 noj-core 服务才能生效。
        </p>
      </div>

      <AsyncContent
        :status="tableLoading ? 'loading' : dbSettings.length === 0 ? 'empty' : 'data'"
        empty-text="暂无可编辑设置项"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-bg-page border-b border-border">
              <th class="px-3 py-2.5 text-left font-semibold text-text w-[180px]">设置项</th>
              <th class="px-3 py-2.5 text-left font-semibold text-text">当前值</th>
              <th class="px-3 py-2.5 text-left font-semibold text-text w-[90px]">来源</th>
              <th class="px-3 py-2.5 text-left font-semibold text-text">描述</th>
              <th class="px-3 py-2.5 text-right font-semibold text-text w-[200px]">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in dbSettings"
              :key="s.key"
            class="border-b border-border last:border-b-0 transition-colors"
            :class="isDirty(s.key) ? 'bg-amber-50' : 'hover:bg-primary-bg'"
          >
            <!-- 设置项 key + 类型 -->
            <td class="px-3 py-3 align-top">
              <div class="flex flex-col gap-0.5">
                <code class="font-mono text-13px font-semibold text-text">{{ s.key }}</code>
                <span class="text-11px text-text-secondary">{{ s.type }}</span>
              </div>
            </td>

            <!-- 当前值（可编辑） -->
            <td class="px-3 py-3 align-top">
              <!-- boolean：Switch -->
              <div
                v-if="s.type === 'boolean'"
                class="inline-flex items-center gap-2"
              >
                <USwitch
                  :model-value="!!drafts[s.key]"
                  @update:model-value="(v) => drafts[s.key] = v"
                  color="primary"
                />
                <span class="text-13px font-mono">{{ drafts[s.key] ? "true" : "false" }}</span>
              </div>

              <!-- string：Input -->
              <div
                v-else-if="s.type === 'string'"
                class="flex items-center gap-2"
              >
                <!-- 敏感字段：初始为 null 时显示只读占位，需点击编辑才能修改 -->
                <template v-if="s.is_secret">
                  <input
                    v-model="drafts[s.key]"
                    :disabled="drafts[s.key] === null"
                    :placeholder="drafts[s.key] === null ? '•••••••• 点击「编辑」以修改' : ''"
                    class="w-full px-2.5 py-1.5 text-13px font-mono border border-border rounded outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)] disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <UButton v-if="drafts[s.key] === null" size="xs" color="primary" variant="outline" @click="drafts[s.key] = ''">编辑</UButton>
                </template>
                <!-- 非敏感字段：正常可编辑 -->
                <input
                  v-else
                  v-model="drafts[s.key]"
                  class="w-full px-2.5 py-1.5 text-13px font-mono border border-border rounded outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
                />
              </div>

              <!-- text：textarea -->
              <textarea
                v-else-if="s.type === 'text'"
                v-model="drafts[s.key]"
                rows="2"
                maxlength="1000"
                class="w-full px-2.5 py-1.5 text-13px border border-border rounded outline-none transition-colors resize-y focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
              />

              <!-- integer：number input -->
              <input
                v-else-if="s.type === 'integer'"
                v-model.number="drafts[s.key]"
                type="number"
                step="1"
                :min="s.min"
                :max="s.max"
                class="w-full px-2.5 py-1.5 text-13px font-mono border border-border rounded outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
              />
            </td>

            <!-- 来源标签 -->
            <td class="px-3 py-3 align-top">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded text-11px font-semibold"
                :class="{
                  'bg-blue-50 text-info-text': s.source === 'db',
                  'bg-gray-100 text-text-secondary': s.source !== 'db',
                }"
              >
                {{ s.source === 'db' ? 'DB' : s.source === 'env' ? 'env' : '默认' }}
              </span>
            </td>

            <!-- 描述 -->
            <td class="px-3 py-3 align-top text-13px text-text-secondary">
              <div class="flex flex-col gap-1">
                <span>{{ s.description }}</span>
                <span v-if="s.needsRestart" class="inline-flex items-center gap-0.5 text-11px font-semibold text-warning-text">
                  <UIcon name="i-lucide-refresh-cw" class="size-3" /> 需重启生效
                </span>
              </div>
            </td>

            <!-- 操作按钮 -->
            <td class="px-3 py-3 align-top">
              <div class="flex items-center justify-end gap-1.5">
                <UButton
                  size="xs"
                  color="primary"
                  :loading="savingKeys.has(s.key)"
                  :disabled="!isDirty(s.key)"
                  icon="i-lucide-save"
                  @click="saveSetting(s.key)"
                >
                  {{ savingKeys.has(s.key) ? "保存中..." : "保存" }}
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :disabled="resettingKeys.has(s.key)"
                  title="重置为默认值"
                  icon="i-lucide-rotate-ccw"
                  @click="confirmReset(s)"
                >
                  重置
                </UButton>
              </div>
              <p v-if="saveErrors[s.key]" class="mt-1.5 text-11px text-error-text">{{ saveErrors[s.key] }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      </AsyncContent>
    </section>

    <!-- ─── 第二组：env-only 只读设置（折叠面板） ───────────── -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <details class="group">
        <summary class="flex items-center justify-between px-5 py-3 bg-bg-page border-b border-border cursor-pointer select-none hover:bg-primary-hover transition-colors">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-secondary transition-transform group-open:rotate-180" />
            <h2 class="text-base font-semibold text-text">
              环境变量（只读，需重启生效）
            </h2>
            <span class="text-xs text-text-secondary">
              {{ envOnlySettings.length }} 项
            </span>
          </div>
        </summary>

        <!-- 顶部提示文字（spec 要求） -->
        <div class="flex items-start gap-2 px-5 py-3 bg-blue-50 border-b border-blue-100 text-13px text-info-text">
          <UIcon name="i-lucide-info" class="size-3.5 shrink-0 mt-0.5" />
          <div>
            修改这些项需要更新 .env 并重启 noj-core 服务。当前展示的是已
            <code class="px-1 py-0.5 bg-blue-100 rounded font-mono text-[12px]">snapshotEnv()</code>
            启动时快照的值。
          </div>
        </div>

        <div v-if="envOnlySettings.length === 0" class="p-6 text-center text-sm text-text-secondary">
          当前 .env 中没有白名单内的环境变量
        </div>
        <UTable
          v-else
          :columns="envOnlyColumns"
          :data="envOnlySettings"
          :loading="false"
        >
          <template #key-cell="{ row }">
            <code class="font-mono text-13px text-text">{{ row.original.key }}</code>
          </template>
          <template #effective_value-cell="{ row }">
            <UTooltip v-if="row.original.is_secret" :text="getSecretTooltip(row.original.key)" class="cursor-help">
              <span class="inline-flex items-center gap-1">
                <UIcon name="i-lucide-lock" class="size-3 shrink-0 text-amber-700" />
                <code
                  class="font-mono text-13px px-2 py-0.5 rounded underline decoration-dotted underline-offset-2 bg-amber-50 text-amber-800"
                >
                  {{ String(row.original.effective_value) }}
                </code>
              </span>
            </UTooltip>
            <code
              v-else
              class="font-mono text-13px px-2 py-0.5 rounded bg-bg-page text-text"
            >
              {{ String(row.original.effective_value) }}
            </code>
          </template>
          <template #description-cell="{ row }">
            <span class="text-13px text-text-secondary">{{ row.original.description }}</span>
          </template>
        </UTable>
      </details>
    </section>
  </div>
</template>
