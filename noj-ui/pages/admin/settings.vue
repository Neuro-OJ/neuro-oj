<script setup lang="ts">
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/apiError';
import SettingFieldInput, {
  type SystemSetting,
} from '~/components/admin/SettingFieldInput.vue';

definePageMeta({
  layout: 'admin',
  middleware: 'admin',

});

const { isLoggedIn } = useAuth();
useRequireLogin();

/** 分类展示文案（键集合来自 API 元数据，此处仅纯展示映射） */
const CATEGORY_LABEL: Record<string, string> = {
  auth: '认证',
  maintenance: '维护与公告',
  email: '邮件',
  rate_limit: '速率限制',
  storage: '对象存储',
  database: '数据库',
  redis: 'Redis',
  cors: 'CORS',
  community: '社区',
  judge: '评测资源限制',
  llm: 'LLM',
  review: '内容合规审核',
  other: '其他',
};

const { api } = useApi();
const { dialog } = useDialog();
const { toast } = useToast();

// ─── OI WASM 统一计量状态 ───────────────────────────

interface OiCostProfileStatus {
  active: boolean;
  profile: Record<string, unknown> | null;
  standard: {
    id: string;
    hash: string;
    fuel_per_ms: number;
    toolchain: string;
    toolchain_components_sha256?: string;
    runtime_version: string;
    operator_costs: {
      I32Load: number;
      I32Store: number;
      MemoryCopy: number;
      MemoryFill: number;
      MemoryInit: number;
      MemoryGrow: number;
      variable: {
        memory_copy_per_byte: number;
        memory_fill_per_byte: number;
        memory_init_per_byte: number;
        memory_grow_per_page: number;
      };
    };
  };
}

const oiProfileText = ref('');
const oiProfileStatus = ref<OiCostProfileStatus | null>(null);
const oiProfileLoading = ref(false);

const oiMemoryCosts = computed(() => {
  const costs = oiProfileStatus.value?.standard.operator_costs;
  if (!costs) return [];
  return [
    { operation: '普通读写（以 i32.load / i32.store 为例）', cost: `${costs.I32Load} / ${costs.I32Store} fuel / 条` },
    { operation: '批量复制 memory.copy', cost: `${costs.MemoryCopy} + 字节数 × ${costs.variable.memory_copy_per_byte} fuel` },
    { operation: '批量填充 memory.fill', cost: `${costs.MemoryFill} + 字节数 × ${costs.variable.memory_fill_per_byte} fuel` },
    { operation: '批量初始化 memory.init', cost: `${costs.MemoryInit} + 字节数 × ${costs.variable.memory_init_per_byte} fuel` },
    { operation: '内存增长 memory.grow', cost: `${costs.MemoryGrow} + 页数 × ${costs.variable.memory_grow_per_page} fuel（每页 64 KiB）` },
  ];
});

const oiMemoryCopyExample = computed(() => {
  const standard = oiProfileStatus.value?.standard;
  if (!standard) return '';
  const fuel = standard.operator_costs.MemoryCopy + 1048576 * standard.operator_costs.variable.memory_copy_per_byte;
  return `复制 1 MiB 的指令成本为 ${fuel.toLocaleString()} fuel，约 ${(fuel / standard.fuel_per_ms).toFixed(2)} NOJ 参考毫秒；地址计算、循环等指令另行计费。`;
});

async function loadOiCostProfile() {
  if (!isLoggedIn.value) return;
  oiProfileLoading.value = true;
  try {
    const res = await api.get<{ data: OiCostProfileStatus }>(
      '/api/v1/admin/system/oi-cost-profile',
      { silent: true },
    );
    oiProfileStatus.value = res.data;
    oiProfileText.value = res.data.profile ? JSON.stringify(res.data.standard, null, 2) : '';
  } catch {
    oiProfileStatus.value = null;
  } finally {
    oiProfileLoading.value = false;
  }
}

// ─── 邮件服务就绪状态 ────────────────────────────

interface EmailConfigStatus {
  provider: string;
  configured: boolean;
  missing: string[];
}

const emailStatus = ref<EmailConfigStatus | null>(null);
const testEmailTo = ref('');
const sendingTestEmail = ref(false);

async function loadEmailStatus() {
  if (!isLoggedIn.value) return;
  try {
    const res = await api.get<{ data: EmailConfigStatus }>(
      '/api/v1/admin/system/settings/email/status',
      { silent: true },
    );
    emailStatus.value = res.data;
  } catch {
    emailStatus.value = null;
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadEmailStatus();
}, { immediate: true });

async function sendTestEmail() {
  if (sendingTestEmail.value) return;
  const to = testEmailTo.value.trim();
  if (!to) {
    toast.error('请先填写测试收件邮箱');
    return;
  }
  sendingTestEmail.value = true;
  try {
    const res = await api.post<{ data: { sent: boolean } }>(
      '/api/v1/admin/system/settings/email/test-send',
      { to },
      { silent: true },
    );
    if (res.data.sent) {
      toast.success(`测试邮件已发送到 ${to}，请查收确认`);
    } else {
      toast.error('邮件服务未实际发送（当前 Provider 返回未发送），请检查配置');
    }
  } catch (err: unknown) {
    toast.error(extractApiError(err).message);
  } finally {
    sendingTestEmail.value = false;
  }
}

// ─── 数据加载与草稿保护 ────────────────────────────────

const settings = ref<SystemSetting[]>([]);
const drafts = ref<Record<string, unknown>>({});
const tableLoading = ref(true);
const tableError = ref('');
let requestVersion = 0;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function isDirty(key: string): boolean {
  const s = settings.value.find((x) => x.key === key);
  if (!s) return false;
  const draft = drafts.value[key];
  if (draft === null && s.is_secret) return false;
  return !deepEqual(draft, s.effective_value);
}

const dirtyCount = computed(() => settings.value.filter((s) => isDirty(s.key)).length);

// 复用 useUnsavedChanges 实现离开/刷新拦截保护
useUnsavedChanges(() => dirtyCount.value > 0);

async function loadSettings(force = false) {
  if (!isLoggedIn.value) return;
  const currentRequest = ++requestVersion;
  tableLoading.value = true;
  tableError.value = '';
  try {
    const res = await api.get<{ data: SystemSetting[] }>(
      '/api/v1/admin/system/settings',
      { silent: true },
    );
    if (currentRequest !== requestVersion) return;
    settings.value = res.data;

    // 初始化草稿：若已有编辑且非强制重置，保留用户当前编辑的字段，仅补全缺失字段
    const nextDrafts: Record<string, unknown> = {};
    for (const s of res.data) {
      if (!force && s.key in drafts.value && isDirty(s.key)) {
        nextDrafts[s.key] = drafts.value[s.key];
      } else {
        nextDrafts[s.key] = s.is_secret ? null : s.effective_value;
      }
    }
    drafts.value = nextDrafts;
  } catch (err: unknown) {
    if (currentRequest !== requestVersion) return;
    tableError.value = extractApiError(err).message;
    // 加载出错时不清除用户已有的草稿
  } finally {
    if (currentRequest === requestVersion) tableLoading.value = false;
  }
}

async function reloadSettings() {
  if (dirtyCount.value > 0) {
    const confirmed = await dialog.confirm(
      `当前有 ${dirtyCount.value} 项未保存的设置草稿，重新读取将放弃未保存的修改。确认重新读取？`,
      { title: '重新读取设置', danger: true },
    );
    if (!confirmed) return;
  }
  await loadSettings(true);
}

watch(isLoggedIn, (val) => {
  if (val) {
    loadSettings(true);
    loadOiCostProfile();
  }
}, { immediate: true });

// ─── 放弃单个草稿 ─────────────────────────────────────

function discardDraft(key: string) {
  const s = settings.value.find((x) => x.key === key);
  if (!s) return;
  drafts.value[key] = s.is_secret ? null : s.effective_value;
  const errors = { ...saveErrors.value };
  delete errors[key];
  saveErrors.value = errors;
}

// ─── 搜索与分类过滤 ───────────────────────────────────

const searchQuery = ref('');
const selectedCategory = ref('all');

const dbSettings = computed(() =>
  settings.value.filter((s) => s.scope === 'runtime' && s.key !== 'oi_cost_profile_active')
);

const envOnlySettings = computed(() =>
  settings.value.filter((s) => s.scope === 'bootstrap')
);

const availableCategories = computed(() => {
  const cats = new Set<string>();
  for (const s of settings.value) {
    if (s.category) cats.add(s.category);
  }
  return Array.from(cats);
});

const categoryOptions = computed(() => [
  { label: '全部分类', value: 'all' },
  ...availableCategories.value.map((cat) => ({
    label: CATEGORY_LABEL[cat] ?? cat,
    value: cat,
  })),
]);

const filteredDbSettings = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const cat = selectedCategory.value;
  return dbSettings.value.filter((s) => {
    if (cat !== 'all' && s.category !== cat) return false;
    if (!q) return true;
    const catLabel = (CATEGORY_LABEL[s.category] ?? '').toLowerCase();
    return (
      s.key.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      catLabel.includes(q)
    );
  });
});

const envOnlyGrouped = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const cat = selectedCategory.value;
  const filtered = envOnlySettings.value.filter((s) => {
    if (cat !== 'all' && s.category !== cat) return false;
    if (!q) return true;
    const catLabel = (CATEGORY_LABEL[s.category] ?? '').toLowerCase();
    return (
      s.key.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      catLabel.includes(q)
    );
  });

  const groups = new Map<string, SystemSetting[]>();
  for (const s of filtered) {
    const c = s.category || 'other';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(s);
  }
  const order = ['auth', 'email', 'storage', 'database', 'redis', 'cors', 'judge', 'other'];
  const sorted = [...groups.entries()].sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return sorted.map(([category, items]) => ({ category, items }));
});

function getSecretTooltip(key: string): string {
  if (key === 'DATABASE_URL') return '已脱敏：仅移除 user:password@，保留协议+主机+路径';
  if (key === 'REDIS_URL') return '已脱敏：仅移除 :password@，保留协议+主机+路径';
  if (key === 'JWT_SECRET') return '已脱敏：SHA-256 哈希（前16位），仅用于部署密钥比对';
  return '敏感值（已脱敏）';
}

// ─── 保存单个设置 ─────────────────────────────────────

const savingKeys = ref(new Set<string>());
const saveErrors = ref<Record<string, string>>({});

function applySetting(item: SystemSetting) {
  const index = settings.value.findIndex((setting) => setting.key === item.key);
  if (index >= 0) settings.value.splice(index, 1, item);
  else settings.value.push(item);
  drafts.value[item.key] = item.is_secret ? null : item.effective_value;
}

async function saveSetting(key: string) {
  if (drafts.value[key] === null) return;
  if (savingKeys.value.has(key)) return;
  savingKeys.value = new Set(savingKeys.value).add(key);
  const errors = { ...saveErrors.value };
  delete errors[key];
  saveErrors.value = errors;
  try {
    const setting = settings.value.find((x) => x.key === key);
    const res = await api.put<{ data: SystemSetting }>(`/api/v1/admin/system/settings/${key}`, {
      value: drafts.value[key],
    }, {
      silent: true,
      headers: setting?.updated_at ? { 'If-Match': `"${setting.updated_at}"` } : undefined,
    });
    applySetting(res.data);
    const s = settings.value.find((x) => x.key === key);
    if (s?.needsRestart) {
      toast.success('设置已保存，需重启 noj-core 服务才能生效');
    } else {
      toast.success('设置已保存');
    }
  } catch (err: unknown) {
    saveErrors.value = { ...saveErrors.value, [key]: extractApiError(err).message };
  } finally {
    const next = new Set(savingKeys.value);
    next.delete(key);
    savingKeys.value = next;
  }
}

// ─── 重置单个设置 ─────────────────────────────────────

const resettingKeys = ref(new Set<string>());

async function confirmReset(s: SystemSetting) {
  const targetFallback = s.env_present
    ? `环境变量 ${s.env_key || s.key}`
    : '系统默认值';
  const restartNote = s.needsRestart ? '此项更改需重启服务后生效。' : '';

  const ok = await dialog.confirm(
    `确认将「${s.description}」(${s.key}) 重置？数据库中保存的值将被删除，生效值将回退至 ${targetFallback}。${restartNote}`,
    {
      title: '确认重置设置',
      danger: true,
    },
  );
  if (!ok) return;

  if (resettingKeys.value.has(s.key)) return;
  resettingKeys.value = new Set(resettingKeys.value).add(s.key);
  const errors = { ...saveErrors.value };
  delete errors[s.key];
  saveErrors.value = errors;
  try {
    await api.delete(`/api/v1/admin/system/settings/${s.key}`, {
      silent: true,
      headers: s.updated_at ? { 'If-Match': `"${s.updated_at}"` } : undefined,
    });
    const res = await api.get<{ data: SystemSetting[] }>('/api/v1/admin/system/settings', { silent: true });
    const updated = res.data.find((item) => item.key === s.key);
    if (updated) applySetting(updated);
    toast.success(`已重置 ${s.key}`);
  } catch (err: unknown) {
    saveErrors.value = { ...saveErrors.value, [s.key]: extractApiError(err).message };
  } finally {
    const next = new Set(resettingKeys.value);
    next.delete(s.key);
    resettingKeys.value = next;
  }
}

// ─── 清理 bootstrap 残留 DB 行 ────────────────────────

async function cleanupBootstrapRow(s: SystemSetting) {
  if (resettingKeys.value.has(s.key)) return;
  resettingKeys.value = new Set(resettingKeys.value).add(s.key);
  try {
    await api.delete(`/api/v1/admin/system/settings/${s.key}`, {
      silent: true,
      headers: s.updated_at ? { 'If-Match': `"${s.updated_at}"` } : undefined,
    });
    const res = await api.get<{ data: SystemSetting[] }>('/api/v1/admin/system/settings', { silent: true });
    settings.value = res.data;
    toast.success(`已清理 ${s.key} 的残留 DB 值（当前值由 .env 决定）`);
  } catch (err: unknown) {
    toast.error(extractApiError(err).message);
  } finally {
    const next = new Set(resettingKeys.value);
    next.delete(s.key);
    resettingKeys.value = next;
  }
}

useSeoMeta({ title: '系统设置 - 平台管理' });
</script>

<template>
  <div class="flex flex-col gap-5 min-w-0 max-w-full">
    <AdminPageHeader title="系统设置" description="运行时配置逐项保存，需重启的设置会单独注明；环境配置只读，修改 .env 后需重启服务。">
      <template #actions>
        <UButton variant="outline" @click="reloadSettings">重新读取配置</UButton>
      </template>
    </AdminPageHeader>

    <!-- 未保存更改横幅 -->
    <div
      v-if="dirtyCount > 0"
      class="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 text-amber-600" />
      <span class="font-semibold">有未保存的更改（{{ dirtyCount }} 项）</span>
      <span class="text-amber-700">修改后请逐项点击「保存」按钮写入数据库，或点击「放弃」还原。</span>
    </div>

    <!-- 优先级与规则说明（DB 优先，重置回退 env 或默认） -->
    <div class="flex items-start gap-2.5 p-3.5 bg-bg-panel border border-border rounded text-xs text-text-secondary leading-relaxed shadow-xs">
      <UIcon name="i-lucide-info" class="size-4 text-primary shrink-0 mt-0.5" />
      <div>
        <strong class="text-text">读取优先级：</strong>数据库 (DB) 写入值优先生效。点击「重置」删除数据库覆盖，回退至 <code class="font-mono text-[11px] bg-bg-sunken px-1 py-0.5 rounded">.env</code> 环境变量（若有配置）或系统默认值。<strong class="text-text ml-2">环境配置：</strong>由环境变量启动期定型，后台只读，修改需更新 <code class="font-mono text-[11px] bg-bg-sunken px-1 py-0.5 rounded">.env</code> 并重启服务。
      </div>
    </div>

    <!-- 邮件服务就绪状态（支持移动端折行） -->
    <div
      v-if="emailStatus"
      class="flex flex-col gap-2 p-3.5 rounded border text-xs leading-relaxed"
      :class="emailStatus.configured
        ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
        : 'bg-amber-50 border-amber-200 text-amber-900'"
    >
      <div class="flex items-start gap-2">
        <UIcon
          :name="emailStatus.configured ? 'i-lucide-mail-check' : 'i-lucide-mail-warning'"
          class="size-4 shrink-0 mt-0.5"
          :class="emailStatus.configured ? 'text-emerald-600' : 'text-amber-600'"
        />
        <div class="flex flex-col gap-2 flex-1 min-w-0">
          <div>
            <template v-if="emailStatus.configured">
              邮件服务已就绪（provider=<code class="font-mono">{{ emailStatus.provider }}</code>），邮箱验证与密码找回可用。
            </template>
            <template v-else>
              邮件服务未就绪（provider=<code class="font-mono">{{ emailStatus.provider }}</code>）：
              邮箱验证与密码找回不可用，<strong>公开注册已被禁止</strong>（仅允许首次引导注册）。
              <span v-if="emailStatus.missing.length">
                缺失配置：{{ emailStatus.missing.join('、') }}。
              </span>
              请补全配置并重启服务。
            </template>
          </div>
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="test-email-to-input"
              v-model="testEmailTo"
              type="email"
              placeholder="测试收件邮箱"
              aria-label="测试收件邮箱"
              class="px-2.5 py-1.5 w-full sm:w-64 text-xs font-mono border border-border rounded bg-bg-panel outline-none transition-colors focus:border-primary"
            />
            <UButton
              size="xs"
              color="primary"
              variant="outline"
              :loading="sendingTestEmail"
              aria-label="发送测试邮件"
              @click="sendTestEmail"
            >
              发送测试邮件
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 搜索与分类过滤工具栏 -->
    <div class="flex flex-wrap items-center gap-2.5">
      <UInput
        v-model="searchQuery"
        placeholder="搜索设置项 key 或中文描述"
        icon="i-lucide-search"
        class="w-full sm:w-72"
        aria-label="搜索设置项"
      />
      <USelect
        v-model="selectedCategory"
        :items="categoryOptions"
        class="w-full sm:w-40"
        aria-label="设置项分类过滤"
      />
      <UButton
        v-if="searchQuery || selectedCategory !== 'all'"
        type="button"
        variant="ghost"
        size="sm"
        @click="searchQuery = ''; selectedCategory = 'all'"
      >
        重置过滤
      </UButton>
    </div>

    <!-- 错误横幅 -->
    <div
      v-if="tableError"
      role="alert"
      class="p-3 bg-red-50 border border-red-200 rounded text-xs text-error-text flex items-center justify-between gap-2"
    >
      <span>{{ tableError }}</span>
      <UButton size="xs" color="primary" variant="ghost" @click="loadSettings(false)">重试</UButton>
    </div>

    <!-- ─── 第一组：运行时配置（可编辑优先呈现） ──────────── -->
    <section class="bg-bg-panel border border-border rounded overflow-hidden shadow-xs">
      <div class="px-4 py-3 border-b border-border bg-bg-sunken/40 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-sliders" class="size-4 text-primary" />
          <h2 class="text-sm font-semibold text-text">
            运行时配置（可编辑）
            <span class="ml-1 text-xs font-normal text-text-secondary tabular-nums">
              {{ filteredDbSettings.length }} / {{ dbSettings.length }} 项
            </span>
          </h2>
        </div>
      </div>

      <AsyncContent
        :status="tableLoading ? 'loading' : filteredDbSettings.length === 0 ? 'empty' : 'data'"
        empty-text="暂无匹配的可编辑设置项"
      >
        <!-- 手机端响应式卡片流（避免 5 列超宽横滚，完整保留 key、输入、来源、帮助、保存/放弃） -->
        <div class="divide-y divide-border md:hidden">
          <div
            v-for="s in filteredDbSettings"
            :key="s.key"
            class="p-4 space-y-3 transition-colors"
            :class="isDirty(s.key) ? 'bg-amber-50/50' : ''"
          >
            <!-- 头部：中文描述、key 与来源徽章 -->
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm text-text leading-snug">{{ s.description }}</div>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <code class="font-mono text-xs text-primary font-semibold break-all">{{ s.key }}</code>
                  <span class="text-[11px] text-text-muted">({{ s.type }})</span>
                </div>
              </div>
              <span
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0"
                :class="{
                  'bg-sky-50 text-sky-700 border border-sky-200': s.source === 'db',
                  'bg-gray-100 text-text-secondary border border-gray-200': s.source !== 'db',
                }"
              >
                {{ s.source === 'db' ? 'DB' : s.source === 'env' ? 'env' : '默认' }}
              </span>
            </div>

            <!-- 输入控件区域（复用独立字段组件，保证 ID 唯一与无障碍关联） -->
            <div class="pt-1">
              <SettingFieldInput
                v-model="drafts[s.key]"
                :setting="s"
                :error="saveErrors[s.key]"
                :disabled="savingKeys.has(s.key) || resettingKeys.has(s.key)"
                template-id="mobile"
                @edit-secret="drafts[s.key] = ''"
              />
            </div>

            <!-- 帮助提示与来源说明 -->
            <div :id="`${s.key}-help-mobile`" class="text-xs text-text-muted space-y-1">
              <div v-if="s.needsRestart" class="inline-flex items-center gap-1 font-medium text-warning-text">
                <UIcon name="i-lucide-refresh-cw" class="size-3" />
                需重启服务生效
              </div>
              <div v-if="s.conflict || s.env_present" class="text-amber-700">
                {{ s.source === 'db' ? '当前使用数据库值，重置后回退至环境变量。' : '当前使用环境变量兜底，保存后使用数据库值。' }}
              </div>
            </div>

            <!-- 内联错误 -->
            <p v-if="saveErrors[s.key]" :id="`${s.key}-error-mobile`" class="text-xs text-error-text" role="alert">
              {{ saveErrors[s.key] }}
            </p>

            <!-- 操作按钮：保存、放弃、重置 -->
            <div class="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
              <UButton
                v-if="isDirty(s.key)"
                size="xs"
                color="neutral"
                variant="outline"
                :aria-label="`放弃 ${s.key} 的修改`"
                @click="discardDraft(s.key)"
              >
                放弃
              </UButton>
              <UButton
                size="xs"
                color="primary"
                :loading="savingKeys.has(s.key)"
                :disabled="!isDirty(s.key)"
                icon="i-lucide-save"
                :aria-label="`保存 ${s.key}`"
                @click="saveSetting(s.key)"
              >
                {{ savingKeys.has(s.key) ? '保存中...' : '保存' }}
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="resettingKeys.has(s.key)"
                icon="i-lucide-rotate-ccw"
                :aria-label="`重置 ${s.key}`"
                @click="confirmReset(s)"
              >
                重置
              </UButton>
            </div>
          </div>
        </div>

        <!-- 桌面端表格呈现 -->
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-bg-sunken/40 border-b border-border text-text-muted">
                <th class="px-3 py-2.5 text-left font-medium w-[220px]">设置项与描述</th>
                <th class="px-3 py-2.5 text-left font-medium min-w-[200px]">配置值</th>
                <th class="px-3 py-2.5 text-left font-medium w-[80px]">来源</th>
                <th class="px-3 py-2.5 text-left font-medium">状态说明</th>
                <th class="px-3 py-2.5 text-right font-medium w-[180px]">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in filteredDbSettings"
                :key="s.key"
                class="border-b border-border last:border-b-0 transition-colors"
                :class="isDirty(s.key) ? 'bg-amber-50/40' : 'hover:bg-primary-bg/20'"
              >
                <!-- 设置项与描述 -->
                <td class="px-3 py-3 align-top">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-medium text-text text-sm">{{ s.description }}</span>
                    <code class="font-mono text-xs text-primary font-semibold break-all">{{ s.key }}</code>
                    <span class="text-[11px] text-text-muted">类型: {{ s.type }}</span>
                  </div>
                </td>

                <!-- 当前值输入 -->
                <td class="px-3 py-3 align-top">
                  <SettingFieldInput
                    v-model="drafts[s.key]"
                    :setting="s"
                    :error="saveErrors[s.key]"
                    :disabled="savingKeys.has(s.key) || resettingKeys.has(s.key)"
                    template-id="desktop"
                    @edit-secret="drafts[s.key] = ''"
                  />
                  <p v-if="saveErrors[s.key]" :id="`${s.key}-error-desktop`" class="mt-1 text-xs text-error-text" role="alert">
                    {{ saveErrors[s.key] }}
                  </p>
                </td>

                <!-- 来源标签 -->
                <td class="px-3 py-3 align-top">
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold"
                    :class="{
                      'bg-sky-50 text-sky-700 border border-sky-200': s.source === 'db',
                      'bg-gray-100 text-text-secondary border border-gray-200': s.source !== 'db',
                    }"
                  >
                    {{ s.source === 'db' ? 'DB' : s.source === 'env' ? 'env' : '默认' }}
                  </span>
                </td>

                <!-- 描述与提示 -->
                <td class="px-3 py-3 align-top text-xs text-text-secondary">
                  <div :id="`${s.key}-help-desktop`" class="flex flex-col gap-1">
                    <span v-if="s.needsRestart" class="inline-flex items-center gap-0.5 font-medium text-warning-text">
                      <UIcon name="i-lucide-refresh-cw" class="size-3" /> 需重启生效
                    </span>
                    <span v-if="s.conflict || s.env_present" class="text-amber-700">
                      {{ s.source === 'db' ? '当前使用数据库值，环境变量保留为兜底。' : '当前使用环境变量兜底。' }}
                    </span>
                  </div>
                </td>

                <!-- 操作按钮 -->
                <td class="px-3 py-3 align-top">
                  <div class="flex items-center justify-end gap-1.5">
                    <UButton
                      v-if="isDirty(s.key)"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :aria-label="`放弃 ${s.key} 的修改`"
                      @click="discardDraft(s.key)"
                    >
                      放弃
                    </UButton>
                    <UButton
                      size="xs"
                      color="primary"
                      :loading="savingKeys.has(s.key)"
                      :disabled="!isDirty(s.key)"
                      icon="i-lucide-save"
                      :aria-label="`保存 ${s.key}`"
                      @click="saveSetting(s.key)"
                    >
                      {{ savingKeys.has(s.key) ? '保存中...' : '保存' }}
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :disabled="resettingKeys.has(s.key)"
                      icon="i-lucide-rotate-ccw"
                      :aria-label="`重置 ${s.key}`"
                      @click="confirmReset(s)"
                    >
                      重置
                    </UButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AsyncContent>
    </section>

    <!-- ─── 第二组：环境变量（只读折叠面板） ───────────────── -->
    <section class="bg-bg-panel border border-border rounded overflow-hidden shadow-xs">
      <details class="group">
        <summary class="flex items-center justify-between px-4 py-3 bg-bg-sunken/40 cursor-pointer select-none hover:bg-bg-sunken/70 transition-colors">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-chevron-right" class="size-4 text-text-secondary transition-transform group-open:rotate-90" />
            <h2 class="text-sm font-semibold text-text">
              环境配置（只读，启动期定型需重启）
            </h2>
            <span class="text-xs text-text-secondary tabular-nums">
              {{ envOnlySettings.length }} 项
            </span>
          </div>
        </summary>

        <div class="p-3 bg-blue-50/60 border-b border-border text-xs text-info-text leading-relaxed">
          这些配置项由 <code class="font-mono text-[11px] bg-blue-100/60 px-1 py-0.5 rounded">.env</code> 环境变量管理，后台只读，修改需更新 <code class="font-mono text-[11px] bg-blue-100/60 px-1 py-0.5 rounded">.env</code> 并重启服务。
          若某项标注 <span class="font-semibold text-warning-text">忽略 DB 旧值</span>，说明数据库中仍有切换前写入的旧行（不生效），可点击清理。
        </div>

        <div v-if="envOnlyGrouped.length === 0" class="p-6 text-center text-xs text-text-secondary">
          暂无匹配的环境配置项
        </div>

        <div v-else class="divide-y divide-border">
          <div
            v-for="grp in envOnlyGrouped"
            :key="grp.category"
            class="p-4"
          >
            <h3 class="text-xs font-semibold text-text mb-2">
              {{ CATEGORY_LABEL[grp.category] ?? grp.category }}
              <span class="ml-1 text-xs font-normal text-text-secondary tabular-nums">({{ grp.items.length }})</span>
            </h3>

            <!-- 手机端卡片 -->
            <div class="space-y-2 md:hidden">
              <div
                v-for="s in grp.items"
                :key="s.key"
                class="rounded border border-border/80 p-2.5 bg-bg-page/50 space-y-1.5"
              >
                <div class="flex items-start justify-between gap-2">
                  <span class="font-mono text-xs font-semibold text-text break-all">{{ s.key }}</span>
                  <span class="text-[11px] text-text-muted shrink-0">{{ s.type }}</span>
                </div>
                <div class="text-xs">
                  <span class="text-text-muted">当前值：</span>
                  <code class="font-mono text-xs bg-bg-sunken px-1.5 py-0.5 rounded break-all">
                    {{ s.effective_value !== null ? String(s.effective_value) : '未配置' }}
                  </code>
                </div>
                <p class="text-xs text-text-secondary">{{ s.description }}</p>
                <div v-if="s.db_orphaned" class="pt-1 flex items-center justify-between">
                  <span class="text-xs text-warning-text font-medium">存在残留 DB 值</span>
                  <UButton
                    size="xs"
                    color="warning"
                    variant="outline"
                    :loading="resettingKeys.has(s.key)"
                    @click="cleanupBootstrapRow(s)"
                  >
                    清理残留
                  </UButton>
                </div>
              </div>
            </div>

            <!-- 桌面端表格 -->
            <div class="hidden md:block overflow-x-auto">
              <table class="w-full text-xs">
                <tbody>
                  <tr
                    v-for="s in grp.items"
                    :key="s.key"
                    class="border-t border-border first:border-t-0 hover:bg-bg-page/60 transition-colors"
                  >
                    <td class="px-2 py-2 align-top w-[220px]">
                      <div class="flex flex-col gap-0.5">
                        <code class="font-mono text-xs font-semibold text-text break-all">{{ s.key }}</code>
                        <span class="text-[11px] text-text-muted">{{ s.type }}</span>
                      </div>
                    </td>
                    <td class="px-2 py-2 align-top w-[220px]">
                      <UTooltip v-if="s.is_secret && s.effective_value !== null" :text="getSecretTooltip(s.key)" class="cursor-help">
                        <span class="inline-flex items-center gap-1">
                          <UIcon name="i-lucide-lock" class="size-3 text-amber-700 shrink-0" />
                          <code class="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 break-all">
                            {{ String(s.effective_value) }}
                          </code>
                        </span>
                      </UTooltip>
                      <code
                        v-else-if="s.effective_value !== null"
                        class="font-mono text-xs px-1.5 py-0.5 rounded bg-bg-sunken text-text break-all"
                      >
                        {{ String(s.effective_value) }}
                      </code>
                      <span v-else class="text-xs text-text-muted italic">未配置</span>
                    </td>
                    <td class="px-2 py-2 align-top text-xs text-text-secondary">
                      <div class="flex flex-col gap-1">
                        <span>{{ s.description }}</span>
                        <div v-if="s.db_orphaned" class="flex items-center gap-2">
                          <span class="inline-flex items-center gap-0.5 text-[11px] font-semibold text-warning-text">
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
        </div>
      </details>
    </section>

    <!-- ─── 第三组：OI WASM 统一计量标准（次级可展开面板，保留全部事实） ─── -->
    <section class="rounded border border-border bg-bg-panel overflow-hidden shadow-xs">
      <details class="group">
        <summary class="flex items-center justify-between px-4 py-3 bg-bg-sunken/40 cursor-pointer select-none hover:bg-bg-sunken/70 transition-colors">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-chevron-right" class="size-4 text-text-secondary transition-transform group-open:rotate-90" />
            <h2 class="text-sm font-semibold text-text">OI WASM 统一计量标准（内置工作量基准）</h2>
          </div>
          <span class="text-xs text-text-muted">展开详情</span>
        </summary>

        <div class="p-4 space-y-3 border-t border-border">
          <p class="text-xs text-text-secondary leading-relaxed">
            所有实例使用 NOJ 内置标准；不再提供本机校准或自定义成本表。参考毫秒表示固定计算工作量，不保证等于实际 CPU 耗时。
          </p>
          <dl v-if="oiProfileStatus" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt class="font-medium text-text">标准版本</dt>
            <dd>{{ oiProfileStatus.standard.id }}</dd>
            <dt class="font-medium text-text">计量单位</dt>
            <dd class="tabular-nums">{{ oiProfileStatus.standard.fuel_per_ms.toLocaleString() }} fuel = 1 NOJ 参考毫秒</dd>
            <dt class="font-medium text-text">工具链修订</dt>
            <dd>{{ oiProfileStatus.standard.toolchain }} / {{ oiProfileStatus.standard.runtime_version }}</dd>
            <template v-if="oiProfileStatus.standard.toolchain_components_sha256">
              <dt class="font-medium text-text">工具链组件摘要</dt>
              <dd class="break-all font-mono text-[11px]">{{ oiProfileStatus.standard.toolchain_components_sha256 }}</dd>
            </template>
            <dt class="font-medium text-text">标准摘要</dt>
            <dd class="break-all font-mono text-[11px]">{{ oiProfileStatus.standard.hash }}</dd>
          </dl>

          <div v-if="oiMemoryCosts.length" class="space-y-2 pt-2 border-t border-border">
            <h3 class="text-xs font-semibold text-text">内存操作换算</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-border text-text-secondary">
                  <tr>
                    <th scope="col" class="py-1.5 pr-4 font-medium">操作</th>
                    <th scope="col" class="py-1.5 font-medium">成本</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in oiMemoryCosts" :key="row.operation" class="border-b border-border/60 last:border-b-0">
                    <td class="py-1.5 pr-4 text-text-secondary">{{ row.operation }}</td>
                    <td class="py-1.5 tabular-nums text-text">{{ row.cost }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="text-xs text-text-secondary">{{ oiMemoryCopyExample }}</p>
            <p class="text-xs text-text-muted">
              这是固定工作量成本，不模拟真实内存延迟、缓存或带宽。内存容量上限独立检查；内存增长按页计费，不按新增字节数计费。所有成本均读取内置标准清单。
            </p>
          </div>

          <p class="text-xs text-text-muted pt-2 border-t border-border">
            普通计算和内存操作按标准计费，批量操作按数据量计费；不计宿主 IO 等待。运行保护超时属于评测环境异常。仅相同标准、题目评测内容和源码的结果具有可比性。
          </p>

          <details class="pt-1">
            <summary class="cursor-pointer text-xs text-primary hover:underline">查看完整标准清单 (JSON)</summary>
            <pre class="mt-2 max-h-72 overflow-auto text-[11px] font-mono p-3 bg-bg-sunken rounded border border-border">{{ oiProfileText }}</pre>
          </details>
        </div>
      </details>
    </section>
  </div>
</template>
