/**
 * 知识图谱前端纯工具（无 Nuxt 依赖，可独立单测）。
 *
 * 后端契约见 `noj-core/src/features/knowledge/README.md`：
 * - 总开关关闭时所有知识接口返回 404 `KNOWLEDGE_DISABLED`，界面须整块隐藏；
 * - 回填预估与实际待打标题数偏差超过 10% 时 backfill 返回 409，要求重新预估。
 */

/** 功能关闭错误码（404 `KNOWLEDGE_DISABLED`）。 */
export const KNOWLEDGE_DISABLED_CODE = 'KNOWLEDGE_DISABLED';

/** 挂载条目（主/次要知识点）。 */
export interface KnowledgeMappingEntry {
  node_id: string;
  name: string;
  role: 'primary' | 'secondary';
  source: 'ai' | 'human';
  /** 0–100；人工挂载为 null。 */
  confidence: number | null;
  review_status: 'auto' | 'pending' | 'confirmed' | 'rejected';
  version_id: string | null;
  updated_at: string;
}

/** 题目归类视图（`GET /knowledge/problems/:problemId`）。 */
export interface ProblemKnowledgeView {
  problem_id: string;
  state: 'classified' | 'unclassified';
  primary: KnowledgeMappingEntry | null;
  secondary: KnowledgeMappingEntry[];
  pending: boolean;
}

/** 图谱节点（`GET /knowledge/graph` 的 `data.nodes`）。 */
export interface KnowledgeNode {
  id: string;
  area: string;
  name: string;
  summary: string | null;
  requires: string[];
}

/** 图谱领域（`GET /knowledge/graph` 的 `data.areas`）。 */
export interface KnowledgeArea {
  id: string;
  name: string;
  sort: number;
}

export interface KnowledgeGraph {
  pack: { id: string; version: string } | null;
  areas: KnowledgeArea[];
  nodes: KnowledgeNode[];
}

/** 审核队列条目。 */
export interface PendingReviewItem {
  problem_id: string;
  title: string;
  domain_id: string | null;
  primary: KnowledgeMappingEntry | null;
  secondary: KnowledgeMappingEntry[];
  updated_at: string;
}

/** 审核队列分页响应。 */
export interface PendingReviewPage {
  items: PendingReviewItem[];
  total: number;
  page: number;
  limit: number;
}

/** AI 打标低峰时段策略（北京时间；关闭时 next_start 为 null）。 */
export interface TagOffpeak {
  enabled: boolean;
  window: string;
  next_start: string | null;
}

/** AI 打标本月用量。 */
export interface TagUsage {
  month_start: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
  cost: number;
  budget: number;
  remaining: number;
  ai_tagging_enabled: boolean;
  model_alias: string;
  alias_configured: boolean | null;
  gateway_error: string | null;
  offpeak: TagOffpeak;
}

/** 回填预估。 */
export interface TagEstimate {
  expected_count: number;
  avg_user_chars: number;
  prefix_chars: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
  monthly_budget: number;
  estimated_cost: number | null;
  cost_note: string;
  offpeak: TagOffpeak;
}

/** 回填投递结果。 */
export interface BackfillResult {
  enqueued: number;
  expected_count: number;
  actual_count: number;
}

/** 知识点选择值：主知识点必选，次要知识点至多 3 个。 */
export interface KnowledgeSelection {
  primary: string;
  secondary: string[];
}

/** 次要知识点上限（后端同样校验）。 */
export const MAX_SECONDARY = 3;

/** 从任意异常中判断是否为功能关闭（404 `KNOWLEDGE_DISABLED`）。 */
export function isKnowledgeDisabled(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === KNOWLEDGE_DISABLED_CODE;
}

/** 从任意异常中判断是否为回填预估漂移（409，要求重新预估）。 */
export function isBackfillDrift(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return status === 409;
}

/** 归类状态的展示文案与颜色。 */
export function mappingStateLabel(
  view: ProblemKnowledgeView | null,
): { label: string; color: 'neutral' | 'warning' | 'success' | 'info' } | null {
  if (!view || view.state !== 'classified' || !view.primary) return null;
  if (view.pending) return { label: 'AI 待确认', color: 'warning' };
  const all = [view.primary, ...view.secondary];
  const source = all.every((entry) => entry.source === 'human') ? '人工' : 'AI';
  return { label: `已确认 · 来源${source}`, color: 'success' };
}

/** 导出选择值：忽略空白项、去重、截断到上限，并保证次要项不含主项。 */
export function normalizeSelection(value: KnowledgeSelection): KnowledgeSelection {
  const primary = value.primary.trim();
  const secondary: string[] = [];
  for (const item of value.secondary) {
    const id = item.trim();
    if (!id || id === primary || secondary.includes(id)) continue;
    secondary.push(id);
    if (secondary.length >= MAX_SECONDARY) break;
  }
  return { primary, secondary };
}

/** 当前归类视图转为选择值（用于编辑/审核时预填）。 */
export function selectionFromView(view: ProblemKnowledgeView | null): KnowledgeSelection {
  if (!view) return { primary: '', secondary: [] };
  return {
    primary: view.primary?.node_id ?? '',
    secondary: view.secondary.map((entry) => entry.node_id).slice(0, MAX_SECONDARY),
  };
}

/** 按领域分组节点，组内按图谱原始顺序（后端已按领域 sort、节点排序）。 */
export function groupNodesByArea(
  graph: KnowledgeGraph | null,
): Array<{ area: KnowledgeArea; nodes: KnowledgeNode[] }> {
  if (!graph) return [];
  const byArea = new Map<string, KnowledgeNode[]>();
  for (const node of graph.nodes) {
    const list = byArea.get(node.area) ?? [];
    list.push(node);
    byArea.set(node.area, list);
  }
  return graph.areas
    .map((area) => ({ area, nodes: byArea.get(area.id) ?? [] }))
    .filter((group) => group.nodes.length > 0);
}

/** 节点名称查询（缺失时回退到节点 id）。 */
export function nodeName(graph: KnowledgeGraph | null, id: string): string {
  return graph?.nodes.find((node) => node.id === id)?.name ?? id;
}

/** 金额/费用格式化；null → 「未知」。 */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return `¥${value.toFixed(2)}`;
}

/** token 数量千分位格式化。 */
export function formatTokens(value: number): string {
  return value.toLocaleString('zh-CN');
}

/**
 * 低峰时段说明：`00:30–08:30（北京时间）`（用 en dash 便于阅读）。
 *
 * `HH:MM-HH:MM` 直接可读，不换算时区文案，后端已约定为北京时间。
 */
export function formatOffpeakWindow(window: string): string {
  return `${window.replace('-', '–')}（北京时间）`;
}

/** 下次低峰开始时刻的本地展示；无（关闭或未知）→ 空串。 */
export function formatOffpeakStart(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
