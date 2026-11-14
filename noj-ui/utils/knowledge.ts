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
  /** 校准难度（P1 响应可能缺省）。 */
  difficulty?: ProblemDifficultyView | null;
}

/** 图谱节点（`GET /knowledge/graph` 的 `data.nodes`）。 */
export interface KnowledgeNode {
  id: string;
  area: string;
  name: string;
  summary: string | null;
  requires: string[];
  /** 本域内以该节点为主知识点的可做题目数（P2 附加，旧响应可能缺省）。 */
  problem_count?: number;
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

/** 知识点详情（`GET /knowledge/nodes/:id` 的 `data`）。 */
export interface KnowledgeNodeView {
  id: string;
  area: string;
  name: string;
  summary: string;
  /** 考纲标签。 */
  syllabus: string[];
  /** 讲解 markdown 原文；内容包未提供时为 null。 */
  doc: string | null;
  /** 直接前置知识点 ID（仅 active）。 */
  requires: string[];
  /** 直接后续知识点 ID（仅 active）。 */
  dependents: string[];
}

/** 难度档位（与后端 `tier = <34 easy / <67 medium / 其余 hard` 一致）。 */
export type DifficultyTier = 'easy' | 'medium' | 'hard';

/** 题目校准难度（`GET/PUT /knowledge/problems/:problemId` 的 `difficulty`）。 */
export interface ProblemDifficultyView {
  /** 校准分 0–100（无校准行时为先验分）。 */
  score: number;
  tier: DifficultyTier;
  sample_size: number;
  /** 出题人覆盖的及格线（百分比 0–100）；null 表示用空间默认。 */
  pass_ratio_override: number | null;
}

/** 阶梯中的一道题（`GET /knowledge/nodes/:id/ladder` 的 `items[]`）。 */
export interface KnowledgeLadderItem {
  problem_id: string;
  number: number | null;
  title: string;
  /** 所属域 slug（跨域题目按 `/d/<域>/problems/…` 链接）。 */
  domain: string;
  /** 校准难度 0–100（按此升序排列）。 */
  difficulty: number;
  tier: DifficultyTier;
  sample_size: number;
  /** 当前用户是否达标；未登录为 null。 */
  passed: boolean | null;
}

/** 节点题目阶梯（`GET /knowledge/nodes/:id/ladder` 的 `data`）。 */
export interface KnowledgeLadder {
  node_id: string;
  domain: string;
  items: KnowledgeLadderItem[];
  /** 推荐的下一题；全部达标或空阶梯为 null。 */
  next: KnowledgeLadderItem | null;
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

/** 难度档位展示文案与颜色（配色走 Nuxt UI 语义色，映射到设计 token）。 */
export function difficultyTierLabel(tier: DifficultyTier): string {
  return tier === 'easy' ? '简单' : tier === 'medium' ? '中等' : '困难';
}

/** 难度档位对应的语义色（与 `DifficultyBadge` 同一口径）。 */
export function difficultyTierColor(tier: DifficultyTier): 'success' | 'warning' | 'error' {
  return tier === 'easy' ? 'success' : tier === 'medium' ? 'warning' : 'error';
}

/**
 * 「去做第一题」目标：优先用户视角的 `next`，未登录时取阶梯第一题。
 *
 * 链接固定走题目详情页（`/d/<域>/problems/<题号>`），与阶梯项同口径；
 * 无可用题目返回 null，调用方据此隐藏按钮。
 */
export function ladderEntryItem(ladder: KnowledgeLadder | null): KnowledgeLadderItem | null {
  if (!ladder) return null;
  return ladder.next ?? ladder.items[0] ?? null;
}

/** 阶梯题目的相对路径；题号缺失（仅 ID）时返回 null。 */
export function ladderItemPath(item: KnowledgeLadderItem): string | null {
  if (item.number === null || item.number === undefined) return null;
  return `/d/${encodeURIComponent(item.domain)}/problems/${item.number}`;
}

/**
 * 及格线覆盖值解析：空串 → null（清除覆盖，用空间默认）；越界或非整数 → `{ error }`。
 *
 * 后端只接受 0–100 整数或 null，前端提前拦截避免无谓的 400。
 */
export function parsePassRatioOverride(raw: string): { value: number | null; error?: string } {
  const text = raw.trim();
  if (!text) return { value: null };
  if (!/^\d{1,3}$/.test(text)) return { value: null, error: '请填写 0–100 的整数百分比' };
  const value = Number(text);
  if (value > 100) return { value: null, error: '请填写 0–100 的整数百分比' };
  return { value };
}
