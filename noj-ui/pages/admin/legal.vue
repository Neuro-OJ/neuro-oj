<script setup lang="ts">
// 法律与合规管理页（PIPL，2026-09-23）。
//
// 交互参考 admin/community.vue：各表单本地草稿 + 顶部「有未保存的更改」标识 +
// 保存/放弃；政策发布是独立动作（生成不可变版本，可标记重大变更）。不做 preset。

import { useToast } from "~/composables/useToast";
import { useDialog } from "~/composables/useDialog";
import { extractApiError } from "~/utils/apiError";
import type { LegalKind, LegalVersionSummary } from "~/composables/useLegal";

definePageMeta({ layout: "admin", middleware: "admin", ssr: false });

const { toast } = useToast();
const { dialog } = useDialog();
const { api } = useApi();
const { loadDocuments, loadVersions, publishVersion } = useLegal();

type TabKey =
  | "privacy"
  | "terms"
  | "identity"
  | "third_parties"
  | "review"
  | "retention"
  | "requests"
  | "tsa";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "privacy", label: "隐私政策" },
  { key: "terms", label: "服务条款" },
  { key: "identity", label: "备案与主体" },
  { key: "third_parties", label: "第三方服务" },
  { key: "review", label: "内容审查" },
  { key: "retention", label: "留存期限" },
  { key: "requests", label: "删除/更正请求" },
  { key: "tsa", label: "时间戳 TSA" },
];
const activeTab = ref<TabKey>("privacy");

// ─── 政策编辑 ────────────────────────────────────────────────
const policyContent = reactive<Record<LegalKind, string>>({ privacy: "", terms: "" });
const policyVersions = reactive<Record<LegalKind, LegalVersionSummary[]>>({ privacy: [], terms: [] });
const policyCurrent = reactive<Record<LegalKind, number>>({ privacy: 0, terms: 0 });
const changeSummary = reactive<Record<LegalKind, string>>({ privacy: "", terms: "" });
const isMaterial = reactive<Record<LegalKind, boolean>>({ privacy: true, terms: true });
const publishing = reactive<Record<LegalKind, boolean>>({ privacy: false, terms: false });
const loadingPolicy = ref(true);

async function loadPolicy(kind: LegalKind) {
  const docs = await loadDocuments(true);
  const cur = docs[kind];
  policyContent[kind] = cur?.content ?? "";
  policyCurrent[kind] = cur?.version ?? 0;
  policyVersions[kind] = await loadVersions(kind);
}

async function loadAllPolicy() {
  loadingPolicy.value = true;
  try {
    await Promise.all([loadPolicy("privacy"), loadPolicy("terms")]);
  } finally {
    loadingPolicy.value = false;
  }
}

async function doPublish(kind: LegalKind) {
  if (publishing[kind]) return;
  const content = policyContent[kind]?.trim() ?? "";
  if (!content) {
    toast.error("政策正文不能为空");
    return;
  }
  publishing[kind] = true;
  try {
    const version = await publishVersion(
      kind,
      policyContent[kind],
      changeSummary[kind] || null,
      isMaterial[kind],
    );
    toast.success(`已发布 v${version}${isMaterial[kind] ? "（重大变更，将提示用户重新同意）" : ""}`);
    changeSummary[kind] = "";
    await loadPolicy(kind);
  } catch (err) {
    toast.error(extractApiError(err).message);
  } finally {
    publishing[kind] = false;
  }
}

// ─── 配置草稿（legal_* / tsa_*）────────────────────────────────
const SETTING_KEYS = [
  "legal_operator_name",
  "legal_contact",
  "legal_deployment_notes",
  "legal_icp_number",
  "legal_icp_url",
  "legal_police_number",
  "legal_police_url",
  "legal_third_parties",
  "tsa_provider",
  "tsa_url",
  "tsa_root_cert",
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const savedValues = reactive<Record<string, string>>({});
const drafts = reactive<Record<string, string>>({});
const versions = ref<Record<string, string | null>>({});
const saving = ref(false);
const loadingSettings = ref(true);

function isDirty(key: SettingKey): boolean {
  const draft = drafts[key];
  if (draft === undefined) return false;
  return draft !== (savedValues[key] ?? "");
}

const dirtyCount = computed(() => SETTING_KEYS.filter((k) => isDirty(k)).length);

async function loadSettings(silent = false) {
  // 后端返回 `effective_value`（已脱敏）；secret 项不回填草稿，避免把掩码当真实值。
  const res = await api.get<{
    data: Array<{
      key: string;
      effective_value: string | null;
      is_secret: boolean;
      updated_at: string | null;
    }>;
  }>("/api/v1/admin/system/settings", { silent });
  const relevant = res.data.filter((s) => (SETTING_KEYS as readonly string[]).includes(s.key));
  for (const item of relevant) {
    // secret 项后端只回脱敏值，不填入草稿（避免把掩码当真实值）
    savedValues[item.key] = item.is_secret ? "" : String(item.effective_value ?? "");
    versions.value[item.key] = item.updated_at;
  }
  resetDraftsToSaved();
  return relevant;
}

/** 把草稿重置为已保存值（secret 项留空）；加载后与「放弃」都用它。 */
function resetDraftsToSaved() {
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const key of SETTING_KEYS) {
    drafts[key] = savedValues[key] ?? "";
  }
}

async function loadAll() {
  loadingSettings.value = true;
  try {
    await Promise.all([loadSettings(true), loadAllPolicy()]);
  } finally {
    loadingSettings.value = false;
  }
}

async function saveAll() {
  if (saving.value || dirtyCount.value === 0) return;
  saving.value = true;
  try {
    const dirty = SETTING_KEYS.filter((k) => isDirty(k));
    for (const key of dirty) {
      const version = versions.value[key];
      await api.put(
        `/api/v1/admin/system/settings/${key}`,
        { value: drafts[key] },
        {
          silent: true,
          headers: version ? { "If-Match": `"${version}"` } : undefined,
        },
      );
    }
    await loadSettings(true);
    toast.success(`已保存 ${dirty.length} 项更改`);
  } catch (err) {
    toast.error(extractApiError(err).message);
  } finally {
    saving.value = false;
  }
}

function discardAll() {
  if (saving.value) return;
  resetDraftsToSaved();
  toast.info("已放弃未保存的更改");
}

// ─── 删除/更正请求处置（P1 D7）─────────────────────────────────
interface AdminDataRequest {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_id: string | null;
  detail: string;
  status: string;
  resolution: string | null;
  created_at: string;
}

const adminRequests = ref<AdminDataRequest[]>([]);
const requestsStatusFilter = ref("all");
const requestsLoading = ref(false);
const updatingRequestId = ref("");

const REQUEST_STATUS_ITEMS = [
  { label: "全部", value: "all" },
  { label: "待处理", value: "pending" },
  { label: "处理中", value: "processing" },
  { label: "已处理", value: "resolved" },
  { label: "已驳回", value: "rejected" },
];

function adminStatusLabel(s: string): string {
  return { pending: "待处理", processing: "处理中", resolved: "已处理", rejected: "已驳回" }[s] ?? s;
}

async function loadAdminRequests() {
  requestsLoading.value = true;
  try {
    const query = requestsStatusFilter.value === "all"
      ? ""
      : `?status=${encodeURIComponent(requestsStatusFilter.value)}`;
    const res = await api.get<{ data: AdminDataRequest[] }>(
      `/api/v1/admin/legal/data-requests${query}`,
      { silent: true },
    );
    adminRequests.value = res.data;
  } catch (err) {
    toast.error(extractApiError(err).message);
  } finally {
    requestsLoading.value = false;
  }
}

async function updateRequestStatus(id: string, status: string) {
  // 办结/驳回需录入处理说明（驳回必填），供用户查看处置结果。
  let resolution: string | null = null;
  if (status === "resolved" || status === "rejected") {
    const input = await dialog.prompt("请填写处理说明（将展示给用户）", {
      title: status === "resolved" ? "办结请求" : "驳回请求",
      confirmText: "确认",
    });
    if (input === null) return; // 取消
    if (status === "rejected" && !input.trim()) {
      toast.error("驳回必须填写处理说明");
      return;
    }
    resolution = input.trim() || null;
  }

  updatingRequestId.value = id;
  try {
    await api.patch(
      `/api/v1/admin/legal/data-requests/${id}`,
      { status, resolution },
      { silent: true },
    );
    toast.success(`已更新为「${adminStatusLabel(status)}」`);
    await loadAdminRequests();
  } catch (err) {
    toast.error(extractApiError(err).message);
  } finally {
    updatingRequestId.value = "";
  }
}

watch(requestsStatusFilter, () => {
  if (activeTab.value === "requests") loadAdminRequests();
});
watch(activeTab, (tab) => {
  if (tab === "requests" && adminRequests.value.length === 0) loadAdminRequests();
});

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}

const loadingContent = computed(() =>
  activeTab.value === "privacy" || activeTab.value === "terms"
    ? loadingPolicy.value
    : loadingSettings.value
);
const contentStatus = computed<"loading" | "data">(() =>
  loadingContent.value ? "loading" : "data"
);

onMounted(loadAll);
</script>

<template>
  <div class="p-4 sm:p-6">
    <AdminPageHeader title="法律与合规" description="隐私政策、服务条款、备案信息与合规配置（PIPL）" />

    <div class="mt-4 flex flex-wrap gap-1 border-b border-border">
      <button
        v-for="t in TABS"
        :key="t.key"
        type="button"
        class="px-3 py-2 text-sm rounded-t transition-colors"
        :class="activeTab === t.key
          ? 'text-primary font-semibold border-b-2 border-primary'
          : 'text-text-secondary hover:text-text'"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 未保存更改标识（配置草稿） -->
    <div
      v-if="dirtyCount > 0"
      class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg"
    >
      <UIcon name="i-lucide-alert-triangle" class="size-4 text-amber-600" />
      <span class="text-sm font-medium text-amber-800">有未保存的更改（{{ dirtyCount }} 项）</span>
      <div class="ml-auto flex gap-2">
        <UButton size="sm" :loading="saving" @click="saveAll">保存更改</UButton>
        <UButton size="sm" color="neutral" variant="outline" :disabled="saving" @click="discardAll">放弃</UButton>
      </div>
    </div>

    <AsyncContent :status="contentStatus">
      <!-- 隐私政策 / 服务条款 -->
      <div v-if="activeTab === 'privacy' || activeTab === 'terms'" class="mt-4 space-y-4">
        <div class="flex items-center gap-2 text-sm text-text-secondary">
          <span>当前版本：<b class="tabular-nums">{{ policyCurrent[activeTab] || "未发布" }}</b></span>
        </div>
        <UTextarea
          v-model="policyContent[activeTab]"
          :rows="16"
          class="font-mono"
          placeholder="在此填写政策 Markdown 正文…"
        />
        <div class="flex flex-wrap items-center gap-3">
          <UInput v-model="changeSummary[activeTab]" placeholder="变更摘要（可选，变更弹窗展示）" class="max-w-md" />
          <UCheckbox v-model="isMaterial[activeTab]" label="标记为重大变更（要求用户重新同意）" />
          <UButton :loading="publishing[activeTab]" @click="doPublish(activeTab)">发布新版本</UButton>
        </div>

        <div class="rounded-lg border border-border overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-bg-sunken text-text-secondary">
              <tr>
                <th class="text-left px-3 py-2">版本</th>
                <th class="text-left px-3 py-2">发布时间</th>
                <th class="text-left px-3 py-2">重大</th>
                <th class="text-left px-3 py-2">摘要</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in policyVersions[activeTab]" :key="v.version" class="border-t border-border">
                <td class="px-3 py-2 tabular-nums">v{{ v.version }}</td>
                <td class="px-3 py-2 tabular-nums">{{ fmtTime(v.published_at) }}</td>
                <td class="px-3 py-2">{{ v.is_material ? "是" : "否" }}</td>
                <td class="px-3 py-2 text-text-secondary">{{ v.change_summary || "—" }}</td>
              </tr>
              <tr v-if="policyVersions[activeTab].length === 0">
                <td colspan="4" class="px-3 py-4 text-center text-text-muted">尚未发布任何版本</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 备案与主体 -->
      <div v-else-if="activeTab === 'identity'" class="mt-4 grid gap-4 max-w-2xl">
        <AdminFormField label="个人信息处理者名称" hint="运营主体，公开展示">
          <UInput v-model="drafts.legal_operator_name" placeholder="如：XX 学生社团" />
        </AdminFormField>
        <AdminFormField label="联系方式" hint="法律与隐私事务联系邮箱或说明">
          <UInput v-model="drafts.legal_contact" placeholder="如：privacy@example.com" />
        </AdminFormField>
        <AdminFormField
          label="部署补充说明"
          hint="存储区域、保留期限、备份、第三方服务及额外用途；在「数据使用与注销说明」页公开展示"
        >
          <UTextarea v-model="drafts.legal_deployment_notes" :rows="6" />
        </AdminFormField>
        <AdminFormField label="ICP 备案号" hint="未备案留空，页脚不显示">
          <UInput v-model="drafts.legal_icp_number" placeholder="如：京ICP备00000000号" />
        </AdminFormField>
        <AdminFormField label="ICP 备案链接">
          <UInput v-model="drafts.legal_icp_url" placeholder="https://beian.miit.gov.cn/" />
        </AdminFormField>
        <AdminFormField label="公安联网备案号" hint="未备案留空">
          <UInput v-model="drafts.legal_police_number" />
        </AdminFormField>
        <AdminFormField label="公安联网备案链接">
          <UInput v-model="drafts.legal_police_url" />
        </AdminFormField>
      </div>

      <!-- 第三方服务 -->
      <div v-else-if="activeTab === 'third_parties'" class="mt-4 max-w-3xl">
        <AdminFormField label="第三方服务清单（JSON）" hint='格式：[{"name":"LLM Provider","purpose":"评测","data":"prompt"}]'>
          <UTextarea v-model="drafts.legal_third_parties" :rows="8" class="font-mono" />
        </AdminFormField>
      </div>

      <!-- 内容审查（聚合既有配置，跳转系统设置） -->
      <div v-else-if="activeTab === 'review'" class="mt-4 max-w-2xl space-y-3 text-sm text-text-secondary">
        <p>内容审核（腾讯云 TMS / 阿里云内容安全等）的 Provider 与阈值配置位于「系统设置 → 内容合规审核」。</p>
        <UButton to="/admin/settings" color="neutral" variant="outline" icon="i-lucide-external-link">
          前往系统设置
        </UButton>
      </div>

      <!-- 留存期限（聚合既有配置） -->
      <div v-else-if="activeTab === 'retention'" class="mt-4 max-w-2xl space-y-3 text-sm text-text-secondary">
        <p>留存期限配置（审计日志、反作弊 IP、SSE 事件）位于「系统设置」的对应分类。</p>
        <UButton to="/admin/settings" color="neutral" variant="outline" icon="i-lucide-external-link">
          前往系统设置
        </UButton>
      </div>

      <!-- 删除/更正请求处置 -->
      <div v-else-if="activeTab === 'requests'" class="mt-4 space-y-4">
        <div class="flex items-center gap-3">
          <USelect v-model="requestsStatusFilter" :items="REQUEST_STATUS_ITEMS" class="w-32" />
          <UButton color="neutral" variant="outline" :loading="requestsLoading" @click="loadAdminRequests">
            刷新
          </UButton>
        </div>

        <div class="rounded-lg border border-border overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-bg-sunken text-text-secondary">
              <tr>
                <th class="text-left px-3 py-2">时间</th>
                <th class="text-left px-3 py-2">提交人</th>
                <th class="text-left px-3 py-2">类型</th>
                <th class="text-left px-3 py-2">对象</th>
                <th class="text-left px-3 py-2">说明</th>
                <th class="text-left px-3 py-2">状态</th>
                <th class="text-left px-3 py-2">处理说明</th>
                <th class="text-left px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in adminRequests" :key="r.id" class="border-t border-border align-top">
                <td class="px-3 py-2 tabular-nums text-text-muted">{{ r.created_at.slice(0, 16).replace("T", " ") }}</td>
                <td class="px-3 py-2 font-mono text-xs" :title="r.user_id">{{ r.user_id.slice(0, 8) }}</td>
                <td class="px-3 py-2">{{ r.kind === "delete" ? "删除" : "更正" }}</td>
                <td class="px-3 py-2">
                  {{ r.target_type }}<span v-if="r.target_id" class="text-text-muted font-mono text-xs"> #{{ r.target_id }}</span>
                </td>
                <td class="px-3 py-2 max-w-xs">{{ r.detail }}</td>
                <td class="px-3 py-2">{{ adminStatusLabel(r.status) }}</td>
                <td class="px-3 py-2 max-w-xs text-text-muted">{{ r.resolution || "—" }}</td>
                <td class="px-3 py-2">
                  <div class="flex gap-1">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :disabled="r.status === 'processing' || r.status === 'resolved' || r.status === 'rejected'"
                      :loading="updatingRequestId === r.id"
                      @click="updateRequestStatus(r.id, 'processing')"
                    >受理</UButton>
                    <UButton
                      size="xs"
                      color="primary"
                      variant="outline"
                      :disabled="r.status === 'resolved' || r.status === 'rejected'"
                      :loading="updatingRequestId === r.id"
                      @click="updateRequestStatus(r.id, 'resolved')"
                    >办结</UButton>
                    <UButton
                      size="xs"
                      color="error"
                      variant="outline"
                      :disabled="r.status === 'resolved' || r.status === 'rejected'"
                      :loading="updatingRequestId === r.id"
                      @click="updateRequestStatus(r.id, 'rejected')"
                    >驳回</UButton>
                  </div>
                </td>
              </tr>
              <tr v-if="adminRequests.length === 0">
                <td colspan="8" class="px-3 py-4 text-center text-text-muted">暂无请求</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 时间戳 TSA -->
      <div v-else-if="activeTab === 'tsa'" class="mt-4 grid gap-4 max-w-2xl">
        <AdminFormField label="TSA Provider" hint="默认 disabled；freetsa/digicert 仅技术验证，中国法律场景建议 custom 并接国内 TSA">
          <USelect
            v-model="drafts.tsa_provider"
            :items="[
              { label: 'disabled（关闭）', value: 'disabled' },
              { label: 'freetsa（免费，仅技术验证）', value: 'freetsa' },
              { label: 'digicert（免费）', value: 'digicert' },
              { label: 'custom（自填端点）', value: 'custom' },
            ]"
          />
        </AdminFormField>
        <AdminFormField label="自定义 TSA 端点" hint="provider=custom 时填写">
          <UInput v-model="drafts.tsa_url" placeholder="https://..." />
        </AdminFormField>
        <AdminFormField label="TSA 根证书（PEM）" hint="供后续验证/审计，敏感字段">
          <UTextarea v-model="drafts.tsa_root_cert" :rows="6" class="font-mono" />
        </AdminFormField>
      </div>
    </AsyncContent>
  </div>
</template>
