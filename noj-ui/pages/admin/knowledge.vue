<script setup lang="ts">
/**
 * 管理后台 · 知识图谱：AI 打标用量、回填、审核队列。
 *
 * - 功能关闭（404 `KNOWLEDGE_DISABLED`）时整页显示关闭提示，不发起其他请求；
 * - 回填必须先用「预估」拿到 `expected_count`，确认后带 `confirm: true` 投递；
 *   409 表示预估漂移，提示重新预估；
 * - 审核队列可「通过」「驳回」「修改」（修改复用 `KnowledgePicker`）；
 * - 低峰时段：后端默认只在低峰时段（北京时间）调用模型，用量卡显示开关、
 *   时段与下次开始时刻，回填确认框注明「任务将在低峰时段执行」。
 */
import type { AdminColumn } from '~/components/admin/AdminTable.vue';
import { extractApiError } from '~/utils/apiError';
import {
  formatCost,
  formatOffpeakStart,
  formatOffpeakWindow,
  formatTokens,
  normalizeSelection,
  selectionFromView,
  type KnowledgeSelection,
  type PendingReviewItem,
  type ProblemKnowledgeView,
  type TagEstimate,
  type TagUsage,
} from '~/utils/knowledge';

definePageMeta({
  layout: 'admin',
  middleware: 'admin',
});

const knowledge = useKnowledge();
const { dialog } = useDialog();

// ─── 用量 ────────────────────────────────────────────
const usage = ref<TagUsage | null>(null);
const usageLoading = ref(true);
const usageError = ref('');

async function loadUsage() {
  usageLoading.value = true;
  usageError.value = '';
  try {
    usage.value = await knowledge.loadUsage();
  } catch (error) {
    usageError.value = extractApiError(error).message;
  } finally {
    usageLoading.value = false;
  }
}

// ─── 回填 ────────────────────────────────────────────
const estimate = ref<TagEstimate | null>(null);
const estimateLoading = ref(false);
const estimateError = ref('');
const backfilling = ref(false);
const backfillNotice = ref('');
const backfillError = ref('');

async function loadEstimate() {
  if (estimateLoading.value || backfilling.value) return;
  estimateLoading.value = true;
  estimateError.value = '';
  backfillNotice.value = '';
  backfillError.value = '';
  try {
    estimate.value = await knowledge.estimateBackfill();
  } catch (error) {
    estimateError.value = extractApiError(error).message;
    estimate.value = null;
  } finally {
    estimateLoading.value = false;
  }
}

async function runBackfill() {
  const current = estimate.value;
  if (!current || backfilling.value) return;
  if (current.expected_count === 0) {
    backfillNotice.value = '没有待打标的题目，无需回填。';
    return;
  }
  const offpeakNote = current.offpeak.enabled
    ? `任务将在低峰时段执行（${formatOffpeakWindow(current.offpeak.window)}）` +
      (current.offpeak.next_start
        ? `，下次开始 ${formatOffpeakStart(current.offpeak.next_start)}`
        : '') +
      '。'
    : '当前未限制低峰时段，任务将尽快执行。';
  const confirmed = await dialog.confirm(
    `将向 ${current.expected_count} 道待打标题目投递 AI 打标任务，预计消耗约 ` +
      `${formatTokens(current.estimated_total_tokens)} token（费用：${formatCost(current.estimated_cost)}）。` +
      `${offpeakNote}确认回填？`,
    { title: '确认回填 AI 打标' },
  );
  if (!confirmed) return;
  backfilling.value = true;
  backfillError.value = '';
  backfillNotice.value = '';
  try {
    const { data, drifted } = await knowledge.backfill(current.expected_count);
    if (drifted) {
      estimate.value = null;
      backfillError.value = '待打标题目数与预估不一致（偏差超过 10%），请重新预估后再回填。';
      return;
    }
    if (!data) return;
    backfillNotice.value = `已投递 ${data.enqueued} 道题目（实际待打标 ${data.actual_count} 道）。`;
    estimate.value = null;
    await loadUsage();
  } catch (error) {
    backfillError.value = extractApiError(error).message;
  } finally {
    backfilling.value = false;
  }
}

// ─── 审核队列 ────────────────────────────────────────
const columns: AdminColumn[] = [
  { key: 'title', label: '题目' },
  { key: 'primary', label: 'AI 建议主知识点' },
  { key: 'secondary', label: 'AI 建议次要知识点' },
  { key: 'confidence', label: '置信度' },
  { key: 'reason', label: '理由' },
  { key: 'actions', label: '操作' },
];

const reviews = ref<PendingReviewItem[]>([]);
const total = ref(0);
const page = ref(1);
const perPage = 20;
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage)));
const reviewsLoading = ref(true);
const reviewsError = ref('');
const acting = ref('');

async function loadReviews() {
  reviewsLoading.value = true;
  reviewsError.value = '';
  try {
    const result = await knowledge.loadReviews(page.value, perPage);
    if (!result) return;
    reviews.value = result.items;
    total.value = result.total;
  } catch (error) {
    reviewsError.value = extractApiError(error).message;
  } finally {
    reviewsLoading.value = false;
  }
}

function onPageChange(next: number) {
  if (next < 1 || next > totalPages.value || next === page.value) return;
  page.value = next;
  void loadReviews();
}

async function decide(item: PendingReviewItem, decision: 'accept' | 'reject') {
  if (acting.value) return;
  const label = decision === 'accept' ? '通过' : '驳回';
  if (!await dialog.confirm(`确认${label}「${item.title}」的 AI 知识点建议？`, { title: `审核${label}` })) return;
  acting.value = item.problem_id;
  try {
    await knowledge.decideReview(item.problem_id, decision);
    await loadReviews();
    if (!reviews.value.length && page.value > 1) onPageChange(page.value - 1);
  } catch (error) {
    reviewsError.value = extractApiError(error).message;
  } finally {
    acting.value = '';
  }
}

// 修改：复用选择器组件
const editing = ref<PendingReviewItem | null>(null);
const editValue = ref<KnowledgeSelection>({ primary: '', secondary: [] });
const editSaving = ref(false);
const editError = ref('');
const editOpen = computed({
  get: () => editing.value !== null,
  set: (value: boolean) => {
    if (!value) editing.value = null;
  },
});

async function openEdit(item: PendingReviewItem) {
  editError.value = '';
  const view = viewOf(item);
  editValue.value = selectionFromView(view);
  editing.value = item;
  try {
    await knowledge.loadGraph();
  } catch (error) {
    editError.value = extractApiError(error).message;
  }
}

async function saveEdit() {
  const item = editing.value;
  if (!item || editSaving.value) return;
  const payload = normalizeSelection(editValue.value);
  if (!payload.primary) {
    editError.value = '请选择主知识点。';
    return;
  }
  editSaving.value = true;
  editError.value = '';
  try {
    await knowledge.decideReview(item.problem_id, payload);
    editing.value = null;
    await loadReviews();
  } catch (error) {
    editError.value = extractApiError(error).message;
  } finally {
    editSaving.value = false;
  }
}

function viewOf(item: PendingReviewItem): ProblemKnowledgeView {
  return {
    problem_id: item.problem_id,
    state: item.primary ? 'classified' : 'unclassified',
    primary: item.primary,
    secondary: item.secondary,
    pending: true,
  };
}

function confidenceLabel(item: PendingReviewItem): string {
  const value = item.primary?.confidence ?? item.secondary[0]?.confidence ?? null;
  return value === null ? '—' : `${value}%`;
}

/** 理由：后端未单独存模型理由，待审条目只能由 AI 置信度低于自动生效阈值推断。 */
function reasonOf(item: PendingReviewItem): string {
  const value = item.primary?.confidence ?? null;
  if (value === null) return '无置信度';
  return `AI 置信度 ${value}%，未达自动生效阈值`;
}

// 初始化：先试用量；一旦功能关闭就整页隐藏，不再请求其他接口。
onMounted(async () => {
  await loadUsage();
  if (knowledge.disabled.value) {
    usageLoading.value = false;
    reviewsLoading.value = false;
    return;
  }
  await Promise.all([loadReviews()]);
});
</script>

<template>
  <div class="space-y-5">
    <AdminPageHeader title="知识图谱" icon="i-lucide-network"
      description="竞赛知识图谱的 AI 打标用量、批量回填与待确认建议审核。" />

    <UAlert v-if="knowledge.disabled.value" color="warning" title="知识图谱功能已关闭"
      description="总开关关闭时相关接口不可用。可在 系统设置 → 知识图谱 中开启。" />

    <template v-else>
      <!-- AI 打标用量 -->
      <section class="rounded-lg border border-border bg-bg-panel p-4 space-y-3" data-testid="kg-usage">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="flex items-center gap-2 text-base font-semibold">
            <UIcon name="i-lucide-coins" class="size-4 text-primary" />AI 打标用量（本月）
          </h2>
          <div class="flex items-center gap-2">
            <UBadge v-if="usage" :color="usage.ai_tagging_enabled ? 'success' : 'neutral'" variant="subtle">
              开关：{{ usage.ai_tagging_enabled ? '已开启' : '已关闭' }}
            </UBadge>
            <UButton size="xs" variant="outline" :loading="usageLoading" @click="loadUsage">刷新</UButton>
          </div>
        </div>
        <UAlert v-if="usageError" color="error" :title="usageError" />
        <p v-if="usageLoading && !usage" class="text-sm text-text-muted">正在读取用量…</p>
        <template v-else-if="usage">
          <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-xs text-text-muted">已用 token</dt>
              <dd class="font-semibold tabular-nums">{{ formatTokens(usage.total_tokens) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">本月预算</dt>
              <dd class="font-semibold tabular-nums">{{ usage.budget === 0 ? '0（暂停调用）' : formatTokens(usage.budget) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">剩余</dt>
              <dd class="font-semibold tabular-nums">{{ formatTokens(usage.remaining) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">调用次数 / 估算费用</dt>
              <dd class="font-semibold tabular-nums">{{ usage.requests }} / {{ formatCost(usage.cost) }}</dd>
            </div>
          </dl>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <UBadge :color="usage.alias_configured === true ? 'success' : usage.alias_configured === null ? 'warning' : 'error'"
              variant="subtle">
              模型别名 {{ usage.model_alias }}：{{ usage.alias_configured === null ? '无法确认（网关不可达）' : usage.alias_configured ? '已配置' : '未配置' }}
            </UBadge>
            <span v-if="usage.gateway_error" class="text-warning-text">网关错误：{{ usage.gateway_error }}</span>
          </div>
          <p class="text-xs text-text-muted" data-testid="kg-offpeak">
            仅低峰时段打标：{{ usage.offpeak.enabled ? '开' : '关' }}，时段
            {{ formatOffpeakWindow(usage.offpeak.window) }}<template v-if="usage.offpeak.enabled && usage.offpeak.next_start">，下次开始
              {{ formatOffpeakStart(usage.offpeak.next_start) }}</template>
          </p>
        </template>
        <p class="text-xs text-text-muted">
          开关与预算在
          <NuxtLink to="/admin/settings?category=knowledge" class="text-primary">系统设置 → 知识图谱</NuxtLink>
          中修改。
        </p>
      </section>

      <!-- 回填 -->
      <section class="rounded-lg border border-border bg-bg-panel p-4 space-y-3" data-testid="kg-backfill">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <UIcon name="i-lucide-refresh-cw" class="size-4 text-primary" />历史题目回填
        </h2>
        <p class="text-xs text-text-muted">
          为「已发布、无人工挂载、最新内容尚未成功打标」的题目投递 AI 打标任务。必须先预估再回填，预估漂移超过 10% 需重新预估。
        </p>
        <UAlert v-if="estimateError" color="error" :title="estimateError" />
        <UAlert v-if="backfillError" color="warning" :title="backfillError" />
        <UAlert v-if="backfillNotice" color="success" :title="backfillNotice" />
        <template v-if="estimate">
          <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt class="text-xs text-text-muted">待打标题数</dt>
              <dd class="font-semibold tabular-nums">{{ estimate.expected_count }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">预计 token</dt>
              <dd class="font-semibold tabular-nums">{{ formatTokens(estimate.estimated_total_tokens) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">预计费用</dt>
              <dd class="font-semibold tabular-nums">{{ formatCost(estimate.estimated_cost) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-text-muted">本月预算</dt>
              <dd class="font-semibold tabular-nums">{{ formatTokens(estimate.monthly_budget) }}</dd>
            </div>
          </dl>
          <p class="text-xs text-text-muted">{{ estimate.cost_note }}</p>
        </template>
        <div class="flex flex-wrap items-center gap-2">
          <UButton size="sm" variant="outline" :loading="estimateLoading" :disabled="backfilling" @click="loadEstimate">
            预估
          </UButton>
          <UButton size="sm" :loading="backfilling" :disabled="!estimate || estimateLoading"
            :title="!estimate ? '请先预估' : undefined" @click="runBackfill">确认回填</UButton>
        </div>
      </section>

      <!-- 审核队列 -->
      <section class="space-y-3" data-testid="kg-reviews">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="flex items-center gap-2 text-base font-semibold">
            <UIcon name="i-lucide-list-checks" class="size-4 text-primary" />AI 建议待审核
            <UBadge v-if="total" color="warning" variant="subtle">{{ total }}</UBadge>
          </h2>
          <UButton size="xs" variant="outline" :loading="reviewsLoading" @click="loadReviews">刷新</UButton>
        </div>
        <AdminTable :columns="columns" :items="reviews as unknown as Record<string, unknown>[]"
          :loading="reviewsLoading" :error="reviewsError" :total-pages="totalPages" :current-page="page"
          @update:page="onPageChange">
          <template #empty>没有待审核的 AI 建议</template>
          <template #cell="{ row, column }">
            <template v-if="column.key === 'title'">
              <span class="font-medium">{{ row.title }}</span>
              <span v-if="row.domain_id" class="ml-1 text-xs text-text-muted">（{{ row.domain_id }}）</span>
            </template>
            <template v-else-if="column.key === 'primary'">
              <UBadge v-if="(row as unknown as PendingReviewItem).primary" color="primary" variant="subtle" size="sm">
                {{ (row as unknown as PendingReviewItem).primary!.name }}
              </UBadge>
              <span v-else class="text-text-muted">—</span>
            </template>
            <template v-else-if="column.key === 'secondary'">
              <div class="flex flex-wrap gap-1">
                <UBadge v-for="entry in (row as unknown as PendingReviewItem).secondary" :key="entry.node_id" color="neutral"
                  variant="subtle" size="sm">{{ entry.name }}</UBadge>
                <span v-if="!(row as unknown as PendingReviewItem).secondary.length" class="text-text-muted">—</span>
              </div>
            </template>
            <template v-else-if="column.key === 'confidence'">
              <span class="tabular-nums">{{ confidenceLabel(row as unknown as PendingReviewItem) }}</span>
            </template>
            <template v-else-if="column.key === 'reason'">
              <span class="text-xs text-text-muted">{{ reasonOf(row as unknown as PendingReviewItem) }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <div class="flex flex-wrap gap-1.5">
                <UButton size="xs" color="success" variant="subtle"
                  :loading="acting === (row as unknown as PendingReviewItem).problem_id"
                  :disabled="!!acting" @click="decide(row as unknown as PendingReviewItem, 'accept')">通过</UButton>
                <UButton size="xs" color="error" variant="subtle" :disabled="!!acting"
                  @click="decide(row as unknown as PendingReviewItem, 'reject')">驳回</UButton>
                <UButton size="xs" variant="outline" :disabled="!!acting"
                  @click="openEdit(row as unknown as PendingReviewItem)">修改</UButton>
              </div>
            </template>
          </template>
        </AdminTable>
      </section>
    </template>

    <UModal v-model:open="editOpen" title="修改知识点" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-text-muted">题目：{{ editing?.title }}</p>
          <UAlert v-if="editError" color="error" :title="editError" />
          <KnowledgePicker v-model="editValue" :graph="knowledge.graph.value" :disabled="editSaving" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="outline" :disabled="editSaving" @click="editing = null">取消</UButton>
          <UButton :loading="editSaving" :disabled="!editValue.primary" @click="saveEdit">保存</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
