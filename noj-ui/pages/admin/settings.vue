<script setup lang="ts">
import {
  RotateCcw,
  Save,
  Info,
  ChevronDown,
  Database,
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

type SettingType = "boolean" | "string" | "text"
type SettingSource = "db" | "env" | "default"
type SettingCategory =
  | "auth"
  | "maintenance"
  | "email"
  | "rate_limit"
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
}

const CATEGORY_LABEL: Record<SettingCategory, string> = {
  auth: "认证",
  maintenance: "维护与公告",
  email: "邮件",
  rate_limit: "速率限制",
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
    // 初始化草稿：与当前 effective_value 同步
    drafts.value = {}
    for (const s of res.data) {
      drafts.value[s.key] = s.effective_value
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

const dbSettings = computed(() =>
  settings.value.filter((s) =>
    [
      "allow_register",
      "smtp_from",
      "rate_limit_login_enabled",
      "maintenance_mode",
      "homepage_banner",
    ].includes(s.key)
  )
)

const envOnlySettings = computed(() =>
  settings.value.filter((s) =>
    ![
      "allow_register",
      "smtp_from",
      "rate_limit_login_enabled",
      "maintenance_mode",
      "homepage_banner",
    ].includes(s.key)
  )
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
    "database",
    "redis",
    "cors",
    "other",
  ]
  return order
    .filter((c) => groups.has(c))
    .map((c) => ({ category: c, items: groups.get(c)! }))
})

/** 该 key 是否有未保存的修改 */
function isDirty(key: string): boolean {
  const s = settings.value.find((x) => x.key === key)
  if (!s) return false
  const draft = drafts.value[key]
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
  savingKey.value = key
  try {
    await $fetch(`/api/v1/admin/settings/${key}`, {
      method: "PUT",
      body: { value: drafts.value[key] },
    })
    toast.success("设置已保存")
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

function toggleBoolean(key: string, currentVal: boolean) {
  drafts.value[key] = !currentVal
}
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

    <!-- ─── 第一组：DB-backed 可编辑设置（5 项） ─────────────── -->
    <section class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-5 py-3 border-b border-border bg-gray-50">
        <div class="flex items-center gap-2">
          <Database :size="16" class="text-primary" />
          <h2 class="text-base font-semibold text-text">运行时配置（可编辑）</h2>
        </div>
        <p class="text-xs text-text-secondary mt-1">
          修改后点击行内「保存」按钮，写入数据库；点击「重置」恢复 env / 默认值
        </p>
      </div>

      <div v-if="tableLoading" class="p-8 text-center text-sm text-text-secondary">
        加载中...
      </div>
      <div v-else-if="dbSettings.length === 0" class="p-8 text-center text-sm text-text-secondary">
        暂无可编辑设置项
      </div>
      <table v-else class="w-full text-sm">
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
              <label
                v-if="s.type === 'boolean'"
                class="inline-flex items-center gap-2 cursor-pointer"
              >
                <button
                  type="button"
                  class="relative w-10 h-5 rounded-full transition-colors duration-150"
                  :class="drafts[s.key] ? 'bg-primary' : 'bg-gray-300'"
                  @click="toggleBoolean(s.key, !!drafts[s.key])"
                >
                  <span
                    class="absolute top-0.5 size-4 bg-white rounded-full shadow transition-transform duration-150"
                    :class="drafts[s.key] ? 'translate-x-5' : 'translate-x-0.5'"
                  />
                </button>
                <span class="text-[13px] font-mono">
                  {{ drafts[s.key] ? "true" : "false" }}
                </span>
              </label>

              <!-- string：Input -->
              <input
                v-else-if="s.type === 'string'"
                v-model="drafts[s.key]"
                :placeholder="s.is_secret ? '••• 敏感字段' : ''"
                class="w-full px-2.5 py-1.5 text-[13px] font-mono border border-border rounded outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
              />

              <!-- text：textarea -->
              <textarea
                v-else
                v-model="drafts[s.key]"
                rows="2"
                maxlength="1000"
                class="w-full px-2.5 py-1.5 text-[13px] border border-border rounded outline-none transition-colors resize-y focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
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
              {{ s.description }}
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
        <div v-else class="flex flex-col">
          <div
            v-for="group in envOnlyGrouped"
            :key="group.category"
            class="border-b border-border last:border-b-0"
          >
            <div class="px-5 py-2 bg-gray-50/60 border-b border-border">
              <h3 class="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
                {{ CATEGORY_LABEL[group.category] }}
                <span class="ml-1 text-text-muted normal-case font-normal">
                  ({{ group.items.length }})
                </span>
              </h3>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-white border-b border-border">
                  <th class="px-3 py-2 text-left font-semibold text-text w-[240px]">键名</th>
                  <th class="px-3 py-2 text-left font-semibold text-text">当前值</th>
                  <th class="px-3 py-2 text-left font-semibold text-text">描述</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in group.items"
                  :key="s.key"
                  class="border-b border-border last:border-b-0 hover:bg-gray-50"
                >
                  <td class="px-3 py-2 align-top">
                    <code class="font-mono text-[13px] text-text">{{ s.key }}</code>
                  </td>
                  <td class="px-3 py-2 align-top">
                    <code
                      class="font-mono text-[13px] px-2 py-0.5 rounded"
                      :class="s.is_secret ? 'bg-amber-50 text-amber-800' : 'bg-gray-50 text-text'"
                    >
                      {{ String(s.effective_value) }}
                    </code>
                  </td>
                  <td class="px-3 py-2 align-top text-[13px] text-text-secondary">
                    {{ s.description }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </section>
  </div>
</template>
