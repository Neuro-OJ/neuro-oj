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
type SettingScope = "runtime" | "bootstrap"

interface SystemSetting {
  key: string
  type: SettingType
  effective_value: unknown
  raw_value: string
  source: SettingSource
  /** 生命周期归属：runtime=DB 可热改；bootstrap=env 启动期定型只读 */
  scope: SettingScope
  is_secret: boolean
  description: string
  updated_at: string | null
  updated_by: string | null
  category: string
  min?: number
  max?: number
  needsRestart?: boolean
  /** bootstrap 项在 DB 中是否有被忽略的残留旧值 */
  db_orphaned?: boolean
  /** runtime 项：对应的 env 兜底键名（envFallback） */
  env_key?: string
  /** runtime 项：env 兜底当前是否非空存在 */
  env_present?: boolean
  /** runtime 项：DB 是否已写入该键 */
  db_present?: boolean
  /** runtime 项：DB 与 env 同时存在（当前 DB 值优先） */
  conflict?: boolean
}

/** 分类展示文案（键集合来自 API 元数据，此处仅纯展示映射） */
const CATEGORY_LABEL: Record<string, string> = {
  auth: "认证",
  maintenance: "维护与公告",
  email: "邮件",
  rate_limit: "速率限制",
  storage: "对象存储",
  database: "数据库",
  redis: "Redis",
  cors: "CORS",
  community: "社区",
  judge: "评测资源限制",
  review: "内容合规审核",
  other: "其他",
}

const { api } = useApi()
const { dialog } = useDialog()
const { toast } = useToast()

// ─── 邮件服务就绪状态（issue #426）────────────────────────

interface EmailConfigStatus {
  provider: string
  configured: boolean
  missing: string[]
}

const emailStatus = ref<EmailConfigStatus | null>(null)
const testEmailTo = ref('')
const sendingTestEmail = ref(false)

async function loadEmailStatus() {
  if (!isLoggedIn.value) return
  try {
    const res = await api.get<{ data: EmailConfigStatus }>(
      '/api/v1/admin/settings/email/status',
      { silent: true },
    )
    emailStatus.value = res.data
  } catch {
    emailStatus.value = null
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadEmailStatus()
}, { immediate: true })

async function sendTestEmail() {
  if (sendingTestEmail.value) return
  const to = testEmailTo.value.trim()
  if (!to) {
    toast.error('请先填写测试收件邮箱')
    return
  }
  sendingTestEmail.value = true
  try {
    const res = await api.post<{ data: { sent: boolean } }>(
      '/api/v1/admin/settings/email/test-send',
      { to },
      { silent: true },
    )
    if (res.data.sent) {
      toast.success(`测试邮件已发送到 ${to}，请查收确认`)
    } else {
      toast.error('邮件服务未实际发送（当前 Provider 返回未发送），请检查配置')
    }
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
  } finally {
    sendingTestEmail.value = false
  }
}

// ─── 数据加载 ────────────────────────────────────────────

const settings = ref<SystemSetting[]>([])
const tableLoading = ref(true)
const tableError = ref("")
let requestVersion = 0
/** 是否已展示进入页面时的配置冲突弹窗（每次进入页面只弹一次） */
let conflictDialogShown = false

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
    // 进入页面时提示 runtime 配置的 DB/env 共存冲突
    if (!conflictDialogShown) {
      conflictDialogShown = true
      const conflicts = res.data.filter((s) => s.conflict)
      if (conflicts.length > 0) {
        // 先结束加载态，避免弹窗期间表格一直显示 loading
        if (currentRequest === requestVersion) tableLoading.value = false
        await dialog.alert(
          `检测到 ${conflicts.length} 项运行时配置同时存在 DB 值与 env 兜底：\n\n` +
            conflicts.map((s) => `- ${s.key}（${s.env_key ?? "?"}）`).join("\n") +
            "\n\n当前 DB 值优先。如希望 DB 值持续生效，请从 .env 移除对应变量后重启 noj-core。",
          { title: "检测到配置来源冲突" },
        )
      }
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

/** runtime（DB-owned）项：运行时可改 */
const dbSettings = computed(() =>
  settings.value.filter((s) => s.scope === "runtime")
)

/** bootstrap（env-owned）项：只读，改 env 重启生效 */
const envOnlySettings = computed(() =>
  settings.value.filter((s) => s.scope === "bootstrap")
)

// 按 category 分组（用于 env-only 只读面板）
const envOnlyGrouped = computed(() => {
  const groups = new Map<string, SystemSetting[]>()
  for (const s of envOnlySettings.value) {
    const cat = s.category || "other"
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(s)
  }
  // 固定分组顺序（仅排序不在展示列表中的分类，缺省归末尾）
  const order = [
    "auth",
    "email",
    "storage",
    "database",
    "redis",
    "cors",
    "judge",
    "other",
  ]
  const sorted = [...groups.entries()].sort((a, b) => {
    const ia = order.indexOf(a[0])
    const ib = order.indexOf(b[0])
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return sorted.map(([category, items]) => ({ category, items }))
})

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

// ─── 清理 bootstrap 残留 DB 行 ────────────────────────────

async function cleanupBootstrapRow(s: SystemSetting) {
  if (resettingKeys.value.has(s.key)) return
  resettingKeys.value = new Set(resettingKeys.value).add(s.key)
  try {
    // 幂等：删除被忽略的 DB 残留行，值仍由 .env 决定
    await api.delete(`/api/v1/admin/settings/${s.key}`, { silent: true })
    // 刷新整表以更新 db_orphaned 标记
    const res = await api.get<{ data: SystemSetting[] }>("/api/v1/admin/settings", { silent: true })
    settings.value = res.data
    toast.success(`已清理 ${s.key} 的残留 DB 值（当前值由 .env 决定）`)
  } catch (err: unknown) {
    toast.error(extractApiError(err).message)
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
    <PageHeader title="系统设置" description="运行时配置写入数据库即时生效；环境配置由 .env 管理，修改需重启服务" />

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
        <strong>运行时配置：</strong>写入数据库，下次请求立即生效，可随时重置。
        <strong>环境配置：</strong>由 .env 环境变量管理（启动期定型），后台只读，
        修改需更新 .env 并重启 noj-core 服务。
      </div>
    </div>

    <!-- 邮件服务就绪状态（issue #426） -->
    <div
      v-if="emailStatus"
      class="flex flex-col gap-2 p-3 rounded-md text-13px"
      :class="emailStatus.configured
        ? 'bg-green-50 border border-green-200 text-green-800'
        : 'bg-amber-50 border border-amber-200 text-amber-800'"
    >
      <div class="flex items-start gap-2">
        <UIcon
          :name="emailStatus.configured ? 'i-lucide-mail-check' : 'i-lucide-mail-warning'"
          class="size-4 shrink-0 mt-0.5"
          :class="emailStatus.configured ? 'text-green-600' : 'text-amber-600'"
        />
        <div class="flex flex-col gap-1">
          <span>
            <template v-if="emailStatus.configured">
              邮件服务已就绪（provider=<code class="font-mono">{{ emailStatus.provider }}</code>），邮箱验证与密码找回可用。
            </template>
            <template v-else>
              邮件服务未就绪（provider=<code class="font-mono">{{ emailStatus.provider }}</code>）：
              邮箱验证与密码找回不可用，<strong>公开注册已被禁止</strong>（仅允许站点引导阶段的首次注册）。
              <span v-if="emailStatus.missing.length">缺失配置：{{ emailStatus.missing.join('、') }}。</span>
              开放注册前请补全 .env 配置并重启 noj-core，然后发送测试邮件确认可用。
            </template>
          </span>
          <div class="flex items-center gap-2">
            <input
              v-model="testEmailTo"
              type="email"
              placeholder="测试收件邮箱"
              class="px-2.5 py-1.5 w-64 text-13px font-mono border border-border rounded bg-white outline-none transition-colors focus:border-signal"
            />
            <UButton
              size="xs"
              color="primary"
              variant="outline"
              :loading="sendingTestEmail"
              @click="sendTestEmail"
            >发送测试邮件</UButton>
          </div>
        </div>
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
                <UTooltip
                  v-if="s.conflict"
                  text="该配置同时在 .env 中设置；当前 DB 值优先。如需 DB 生效，请移除 .env 对应变量后重启 noj-core。"
                >
                  <span class="inline-flex items-center gap-0.5 text-11px font-semibold text-warning-text">
                    <UIcon name="i-lucide-alert-triangle" class="size-3" />
                    env 兜底存在（当前 DB 值优先）
                  </span>
                </UTooltip>
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
            这些配置项由 .env 环境变量管理（启动期定型），修改需更新 .env 并重启
            noj-core 服务。当前展示的是
            <code class="px-1 py-0.5 bg-blue-100 rounded font-mono text-[12px]">snapshotEnv()</code>
            启动时快照的值；未设置的项显示「未配置」。若某项标注
            <span class="font-semibold text-warning-text">忽略 DB 旧值</span>，
            说明数据库中仍有切换前写入的旧值（已不生效），可一键清理。
          </div>
        </div>

        <div v-if="envOnlySettings.length === 0" class="p-6 text-center text-sm text-text-secondary">
          暂无环境配置项
        </div>

        <!-- 按分类分组的只读配置 -->
        <div v-else class="divide-y divide-border">
          <div
            v-for="group in envOnlyGrouped"
            :key="group.category"
            class="px-5 py-4"
          >
            <h3 class="text-13px font-semibold text-text mb-2">
              {{ CATEGORY_LABEL[group.category] ?? group.category }}
              <span class="ml-1 text-xs font-normal text-text-secondary">{{ group.items.length }} 项</span>
            </h3>
            <table class="w-full text-sm">
              <tbody>
                <tr
                  v-for="s in group.items"
                  :key="s.key"
                  class="border-t border-border first:border-t-0 hover:bg-primary-bg transition-colors"
                >
                  <!-- 键名 + 类型 -->
                  <td class="px-2 py-2.5 align-top w-[200px]">
                    <div class="flex flex-col gap-0.5">
                      <code class="font-mono text-13px font-semibold text-text">{{ s.key }}</code>
                      <span class="text-11px text-text-secondary">{{ s.type }}</span>
                    </div>
                  </td>
                  <!-- 当前值（只读） -->
                  <td class="px-2 py-2.5 align-top w-[220px]">
                    <UTooltip v-if="s.is_secret && s.effective_value !== null" :text="getSecretTooltip(s.key)" class="cursor-help">
                      <span class="inline-flex items-center gap-1">
                        <UIcon name="i-lucide-lock" class="size-3 shrink-0 text-amber-700" />
                        <code class="font-mono text-13px px-2 py-0.5 rounded underline decoration-dotted underline-offset-2 bg-amber-50 text-amber-800">
                          {{ String(s.effective_value) }}
                        </code>
                      </span>
                    </UTooltip>
                    <code
                      v-else-if="s.effective_value !== null"
                      class="font-mono text-13px px-2 py-0.5 rounded bg-bg-page text-text"
                    >
                      {{ String(s.effective_value) }}
                    </code>
                    <span v-else class="text-13px text-text-muted italic">未配置</span>
                  </td>
                  <!-- 描述 + 状态徽标 -->
                  <td class="px-2 py-2.5 align-top text-13px text-text-secondary">
                    <div class="flex flex-col gap-1">
                      <span>{{ s.description }}</span>
                      <div v-if="s.db_orphaned" class="flex items-center gap-2">
                        <span class="inline-flex items-center gap-0.5 text-11px font-semibold text-warning-text">
                          <UIcon name="i-lucide-alert-triangle" class="size-3" />
                          忽略 DB 旧值
                        </span>
                        <UButton
                          size="xs"
                          color="warning"
                          variant="outline"
                          :loading="resettingKeys.has(s.key)"
                          :disabled="resettingKeys.has(s.key)"
                          icon="i-lucide-trash-2"
                          @click="cleanupBootstrapRow(s)"
                        >
                          清理残留值
                        </UButton>
                      </div>
                    </div>
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
