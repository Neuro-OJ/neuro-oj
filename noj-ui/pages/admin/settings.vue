<script setup lang="ts">
import { Switch } from "@headlessui/vue"
import {
  RotateCcw,
  Save,
  Info,
  RefreshCw,
  ChevronDown,
  Database,
  Lock,
} from "@lucide/vue"

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
  other: "其他",
}

// ─── 数据加载 ────────────────────────────────────────────

const settings = ref<SystemSetting[]>([])
const tableLoading = ref(true)
const tableError = ref("")

async function loadSettings() {
  if (!isLoggedIn.value) return
  tableLoading.value = true
  tableError.value = ""
  try {
    const res = await $fetch<{ data: SystemSetting[] }>(
      "/api/v1/admin/settings",
    )
    settings.value = res.data
    // 初始化草稿：普通字段同步当前值，敏感字段初始化为 null（需显式编辑）
    drafts.value = {}
    for (const s of res.data) {
      drafts.value[s.key] = s.is_secret ? null : s.effective_value
    }
  } catch (err: unknown) {
    tableError.value = err instanceof Error
      ? err.message
      : "加载系统设置失败"
  } finally {
    tableLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadSettings()
}, { immediate: true })

// ─── 草稿状态 ────────────────────────────────────────────

const drafts = ref<Record<string, unknown>>({})

/** infrastructure env-only 键名白名单（与 ENV_ONLY_DEFINITIONS 同步） */
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

/** AdminTable 列定义（env-only 只读面板） */
const envOnlyColumns = [
  { key: "key", label: "键名" },
  { key: "effective_value", label: "当前值" },
  { key: "description", label: "描述" },
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b)
  return false
}

// ─── 保存单个设置 ─────────────────────────────────────────

const savingKey = ref<string | null>(null)
const { toast } = useToast()

async function saveSetting(key: string) {
  // 敏感字段未显式编辑 → 跳过保存
  if (drafts.value[key] === null) return
  savingKey.value = key
  try {
    await $fetch(`/api/v1/admin/settings/${key}`, {
      method: "PUT",
      body: { value: drafts.value[key] },
    })
    // 检查是否需要重启生效
    const s = settings.value.find((x) => x.key === key)
    if (s?.needsRestart) {
      toast.success("设置已保存，需重启 noj-core 服务才能生效")
    } else {
      toast.success("设置已保存")
    }
    await loadSettings()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "保存失败")
  } finally {
    savingKey.value = null
  }
}

// ─── 重置单个设置 ─────────────────────────────────────────

const resetting = ref(false)
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

  resetting.value = true
  try {
    await $fetch(`/api/v1/admin/settings/${s.key}`, {
      method: "DELETE",
    })
    toast.success(`已重置 ${s.key}`)
    await loadSettings()
  } catch (err: unknown) {
    toast.error(err instanceof Error ? err.message : "重置失败")
  } finally {
    resetting.value = false
  }
}

// ─── 编辑控件辅助 ─────────────────────────────────────────
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text">系统设置</h1>
      <span class="text-sm text-text-secondary">
        运行时可改的配置项，修改即时生效；只读配置需重启服务
      </span>
    </div>

    <!-- 顶部提示横幅 -->
    <div class="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md text-[13px] text-info-text">
      <Info :size="16" class="shrink-0 mt-0.5" />
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
      class="p-3 bg-red-50 border border-red-200 rounded-md text-[13px] text-error-text"
    >
      {{ tableError }}
      <button class="ml-2 underline cursor-pointer" @click="loadSettings">
        重试
      </button>
    </div>

    <!-- ─── 第一组：DB-backed 可编辑设置 ─────────────── -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border bg-gray-50">
        <div class="flex items-center gap-2">
          <Database :size="16" class="text-primary" />
          <h2 class="text-base font-semibold text-text">
            运行时配置（可编辑）
            <span class="ml-1 text-sm font-normal text-text-secondary">{{ dbSettings.length }} 项</span>
          </h2>
        </div>
        <p class="text-xs text-text-secondary mt-1">
          修改后点击行内「保存」按钮，写入数据库；点击「重置」恢复 env / 默认值
        </p>
        <p class="text-[11px] text-text-muted mt-0.5">
          读取优先级：<span class="font-semibold">DB 写入值</span> → env 值（.env） → 系统默认值。
          带 <RefreshCw :size="12" class="inline -mt-0.5 text-warning-text" /> 标记的项保存后需要重启 noj-core 服务才能生效。
        </p>
      </div>

      <AsyncContent
        :status="tableLoading ? 'loading' : dbSettings.length === 0 ? 'empty' : 'data'"
        empty-text="暂无可编辑设置项"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-gray-50 border-b border-border">
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
            :class="isDirty(s.key) ? 'bg-amber-50' : 'hover:bg-gray-50'"
          >
            <!-- 设置项 key + 类型 -->
            <td class="px-3 py-3 align-top">
              <div class="flex flex-col gap-0.5">
                <code class="font-mono text-[13px] font-semibold text-text">{{ s.key }}</code>
                <span class="text-[11px] text-text-secondary">{{ s.type }}</span>
              </div>
            </td>

            <!-- 当前值（可编辑） -->
            <td class="px-3 py-3 align-top">
              <!-- boolean：Switch -->
              <div
                v-if="s.type === 'boolean'"
                class="inline-flex items-center gap-2"
              >
                <Switch
                  :model-value="!!drafts[s.key]"
                  @update:model-value="(v) => drafts[s.key] = v"
                  :class="drafts[s.key] ? 'bg-primary' : 'bg-gray-300'"
                  class="relative inline-flex h-5 w-10 shrink-0 items-center rounded-full transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  <span
                    class="inline-block size-4 transform rounded-full bg-white shadow transition-transform duration-150"
                    :class="drafts[s.key] ? 'translate-x-[22px]' : 'translate-x-[2px]'"
                  />
                </Switch>
                <span class="text-[13px] font-mono">{{ drafts[s.key] ? "true" : "false" }}</span>
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
                    class="w-full px-2.5 py-1.5 text-[13px] font-mono border border-border rounded outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <button
                    v-if="drafts[s.key] === null"
                    class="shrink-0 px-2 py-1.5 text-[12px] font-semibold text-primary border border-primary rounded cursor-pointer hover:bg-primary-bg transition-colors"
                    @click="drafts[s.key] = ''"
                  >
                    编辑
                  </button>
                </template>
                <!-- 非敏感字段：正常可编辑 -->
                <input
                  v-else
                  v-model="drafts[s.key]"
                  class="w-full px-2.5 py-1.5 text-[13px] font-mono border border-border rounded outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
                />
              </div>

              <!-- text：textarea -->
              <textarea
                v-else-if="s.type === 'text'"
                v-model="drafts[s.key]"
                rows="2"
                maxlength="1000"
                class="w-full px-2.5 py-1.5 text-[13px] border border-border rounded outline-none transition-colors resize-y focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
              />

              <!-- integer：number input -->
              <input
                v-else-if="s.type === 'integer'"
                v-model.number="drafts[s.key]"
                type="number"
                step="1"
                :min="s.min"
                :max="s.max"
                class="w-full px-2.5 py-1.5 text-[13px] font-mono border border-border rounded outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
              />
            </td>

            <!-- 来源标签 -->
            <td class="px-3 py-3 align-top">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold"
                :class="{
                  'bg-blue-50 text-info-text': s.source === 'db',
                  'bg-gray-100 text-text-secondary': s.source !== 'db',
                }"
              >
                {{ s.source === 'db' ? 'DB' : s.source === 'env' ? 'env' : '默认' }}
              </span>
            </td>

            <!-- 描述 -->
            <td class="px-3 py-3 align-top text-[13px] text-text-secondary">
              <div class="flex flex-col gap-1">
                <span>{{ s.description }}</span>
                <span v-if="s.needsRestart" class="inline-flex items-center gap-0.5 text-[11px] font-semibold text-warning-text">
                  <RefreshCw :size="12" /> 需重启生效
                </span>
              </div>
            </td>

            <!-- 操作按钮 -->
            <td class="px-3 py-3 align-top">
              <div class="flex items-center justify-end gap-1.5">
                <button
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-semibold text-white bg-primary border-[1.5px] border-primary rounded cursor-pointer transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="!isDirty(s.key) || savingKey === s.key"
                  @click="saveSetting(s.key)"
                >
                  <Save :size="13" />
                  {{ savingKey === s.key ? "保存中..." : "保存" }}
                </button>
                <button
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-semibold text-text-secondary bg-white border-[1.5px] border-border rounded cursor-pointer transition-all duration-150 hover:border-warning-text hover:text-warning-text disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="resetting"
                  title="重置为默认值"
                  @click="confirmReset(s)"
                >
                  <RotateCcw :size="13" />
                  重置
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      </AsyncContent>
    </section>

    <!-- ─── 第二组：env-only 只读设置（折叠面板） ───────────── -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <details class="group">
        <summary class="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-border cursor-pointer select-none hover:bg-gray-100 transition-colors">
          <div class="flex items-center gap-2">
            <ChevronDown
              :size="16"
              class="text-text-secondary transition-transform group-open:rotate-180"
            />
            <h2 class="text-base font-semibold text-text">
              环境变量（只读，需重启生效）
            </h2>
            <span class="text-xs text-text-secondary">
              {{ envOnlySettings.length }} 项
            </span>
          </div>
        </summary>

        <!-- 顶部提示文字（spec 要求） -->
        <div class="flex items-start gap-2 px-5 py-3 bg-blue-50 border-b border-blue-100 text-[13px] text-info-text">
          <Info :size="15" class="shrink-0 mt-0.5" />
          <div>
            修改这些项需要更新 .env 并重启 noj-core 服务。当前展示的是已
            <code class="px-1 py-0.5 bg-blue-100 rounded font-mono text-[12px]">snapshotEnv()</code>
            启动时快照的值。
          </div>
        </div>

        <div v-if="envOnlySettings.length === 0" class="p-6 text-center text-sm text-text-secondary">
          当前 .env 中没有白名单内的环境变量
        </div>
        <AdminTable
          v-else
          :columns="envOnlyColumns"
          :data="envOnlySettings"
          :loading="false"
        >
          <template #cell-key="{ row }">
            <code class="font-mono text-[13px] text-text">{{ row.key }}</code>
          </template>
          <template #cell-effective_value="{ row }">
            <Tooltip v-if="row.is_secret" :content="getSecretTooltip(row.key)" class="cursor-help">
              <span class="inline-flex items-center gap-1">
                <Lock :size="12" class="shrink-0 text-amber-700" />
                <code
                  class="font-mono text-[13px] px-2 py-0.5 rounded underline decoration-dotted underline-offset-2 bg-amber-50 text-amber-800"
                >
                  {{ String(row.effective_value) }}
                </code>
              </span>
            </Tooltip>
            <code
              v-else
              class="font-mono text-[13px] px-2 py-0.5 rounded bg-gray-50 text-text"
            >
              {{ String(row.effective_value) }}
            </code>
          </template>
          <template #cell-description="{ row }">
            <span class="text-[13px] text-text-secondary">{{ row.description }}</span>
          </template>
        </AdminTable>
      </details>
    </section>
  </div>
</template>
