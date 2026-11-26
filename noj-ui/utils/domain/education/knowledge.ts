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
  syllabus?: string[];
  doc?: string | null;
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

// ─── P3：掌握状态、推荐、根因诊断、覆盖度 ───────────────

/** 掌握状态（与后端 `MasteryState` 一致）。 */
export type MasteryState = 'none' | 'learning' | 'mastered';

/** 掌握状态展示文案。 */
export function masteryStateLabel(state: MasteryState): string {
  return state === 'mastered' ? '已掌握' : state === 'learning' ? '学习中' : '未开始';
}

/** 掌握状态徽标配色（已掌握=成功绿、学习中=品牌天青蓝、未开始=中性灰）。 */
export function masteryStateColor(state: MasteryState): 'success' | 'primary' | 'neutral' {
  return state === 'mastered' ? 'success' : state === 'learning' ? 'primary' : 'neutral';
}

/** 掌握度条目（`GET /knowledge/me/mastery` 的 `items[]`）。 */
export interface MasteryItem {
  node_id: string;
  name: string;
  area: string;
  state: MasteryState;
  solved_count: number;
  attempted_count: number;
  failed_attempts: number;
  max_passed_difficulty: number | null;
  /** 该域中该节点为主动知识点的可访问题目数。 */
  problem_count: number;
}

/** 我的掌握度（`GET /knowledge/me/mastery` 的 `data`）。 */
export interface MyMasteryView {
  domain: { id: string; slug: string };
  mastered: number;
  learning: number;
  total: number;
  /** 通过摸底诊断/自评解锁的知识点 ID。 */
  placed_nodes?: string[];
  items: MasteryItem[];
}

export interface DiagnosticAreaSummary {
  area_id: string;
  name: string;
  total_nodes: number;
  foundation_node_ids: string[];
  mastered_count: number;
  placed_count: number;
}

export interface DiagnosticCheckpoint {
  node_id: string;
  name: string;
  area: string;
  area_name: string;
  summary: string;
  has_doc: boolean;
  unlocks_count: number;
  problem_count: number;
  sample_problem: KnowledgeLadderItem | null;
  state: MasteryState;
  placed: boolean;
}

export interface DiagnosticPlanView {
  domain: { id: string; slug: string } | null;
  placed_nodes: string[];
  areas: DiagnosticAreaSummary[];
  checkpoints: DiagnosticCheckpoint[];
}

export interface SelfAssessResult {
  placed_nodes: string[];
  added_count: number;
  total_placed: number;
}

export type RemediationReason =
  | 'problem_primary'
  | 'problem_secondary'
  | 'missing_prerequisite'
  | 'feedback_signal';

export interface RemediationNodeItem {
  node_id: string;
  name: string;
  area: string;
  summary: string;
  has_doc: boolean;
  reason: RemediationReason;
  matched_signals: string[];
  state: MasteryState;
  placed: boolean;
}

export interface ProblemRemediationView {
  problem_id: string;
  items: RemediationNodeItem[];
}

/** 推荐理由（前端按 `code` 拼中文；params 字段以后端为准）。 */
export type RecommendationReasonCode =
  | 'continue_learning'
  | 'prerequisites_mastered'
  | 'entry_point'
  | 'review_prerequisite';

/** 推荐理由结构化数据（`params` 只填当前 code 使用的字段）。 */
export interface RecommendationReasonParams {
  node_id?: string;
  node_name?: string;
  /** `continue_learning`：还差几道达标题。 */
  remaining?: number;
  /** `review_prerequisite`：用户多次未达标的节点与次数。 */
  failed_attempts?: number;
  prerequisite_id?: string;
  prerequisite_name?: string;
  /** `prerequisites_mastered`：已掌握的前置列表。 */
  prerequisites?: Array<{ id: string; name: string }>;
}

export interface RecommendationReason {
  /** 已知 code 有联合类型；后端新增 code 时按字符串处理并走通用文案。 */
  code: string;
  params: RecommendationReasonParams & Record<string, unknown>;
}

/** 一条推荐（`GET /knowledge/me/recommendations` 的 `items[]`）。 */
export interface KnowledgeRecommendation {
  node: {
    id: string;
    name: string;
    area: string;
    state: MasteryState;
    problem_count: number;
  };
  reason: RecommendationReason;
  /** 推荐题（复用阶梯「下一题」）；无推荐题时为 null。 */
  next: KnowledgeLadderItem | null;
}

/** 推荐视图（`GET /knowledge/me/recommendations` 的 `data`）。 */
export interface MyRecommendationsView {
  domain: { id: string; slug: string };
  items: KnowledgeRecommendation[];
}

/** 根因诊断中的一个未掌握前置。 */
export interface DiagnosisItem {
  node_id: string;
  name: string;
  /** 与目标节点的最短层级：直接前置为 1。 */
  depth: number;
  state: MasteryState;
  failed_attempts: number;
}

/** 根因诊断（`GET /knowledge/nodes/:id/diagnosis` 的 `data`）。 */
export interface NodeDiagnosisView {
  node_id: string;
  state: MasteryState;
  missing_prerequisites: DiagnosisItem[];
  chain: DiagnosisItem[];
}

/** 覆盖度单节点（`GET /admin/knowledge/coverage` 的 `nodes[]`）。 */
export interface CoverageNodeItem {
  node_id: string;
  name: string;
  area: string;
  difficulty_distribution: { easy: number; medium: number; hard: number };
  problem_count: number;
  insufficient_problems: boolean;
  difficulty_gap: boolean;
}

/** 覆盖度视图。 */
export interface CoverageView {
  domain: { id: string; slug: string } | null;
  min_solved: number;
  totals: {
    nodes: number;
    nodes_with_problems: number;
    insufficient_problems: number;
    difficulty_gap: number;
    problems: number;
  };
  nodes: CoverageNodeItem[];
  unclassified_problems: number;
  pending_mappings: number;
  deprecated_mappings: number;
  protected_problems: number;
}

/** 推荐理由中文文案；未知 code 回退通用文案。 */
export function recommendationReasonText(reason: RecommendationReason | null | undefined): string {
  const params = (reason?.params ?? {}) as RecommendationReasonParams;
  switch (reason?.code) {
    case 'continue_learning':
      return `已在学习中，再完成 ${Number(params.remaining ?? 0)} 道达标题即可掌握`;
    case 'prerequisites_mastered': {
      const names = (params.prerequisites ?? []).map((item) => item.name).filter(Boolean);
      return names.length ? `前置知识点 ${names.join('、')} 已掌握，可以开始` : '前置知识点已掌握，可以开始';
    }
    case 'entry_point':
      return '入门知识点，适合作为起点';
    case 'review_prerequisite': {
      const nodeName = params.node_name ?? params.node_id ?? '该知识点';
      const prerequisite = params.prerequisite_name ?? params.prerequisite_id ?? '前置知识点';
      return `你在 ${nodeName} 上多次未达标，建议先巩固 ${prerequisite}`;
    }
    default:
      return '根据你的学习进度推荐';
  }
}

/** 覆盖度筛选：「只看有问题的节点」= 题量不足或难度断层。 */
export function coverageNodeHasProblem(item: CoverageNodeItem): boolean {
  return item.insufficient_problems || item.difficulty_gap;
}

/** 掌握率（0–100 整数）；总数为 0 时为 0。 */
export function masteryPercent(mastered: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((mastered / total) * 100));
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

// ─── P4：班级教练视角（掌握矩阵 / 按知识点挑题） ───────────

/** 班级掌握矩阵中的学生（`students[]`）。 */
export interface ClassroomMasteryStudent {
  user_id: string;
  username: string;
  display_name: string | null;
}

/** 单节点在班级内的掌握计数（三项之和 = 学生数）。 */
export interface ClassroomMasteryCounts {
  mastered: number;
  learning: number;
  none: number;
}

/** 掌握矩阵节点（`areas[].nodes[]`）。 */
export interface ClassroomMasteryNode {
  id: string;
  name: string;
  problem_count: number;
  counts: ClassroomMasteryCounts;
}

/** 掌握矩阵领域（`areas[]`）。 */
export interface ClassroomMasteryArea {
  id: string;
  name: string;
  nodes: ClassroomMasteryNode[];
}

/** 班级掌握矩阵（`GET /domains/:slug/classrooms/:id/knowledge-mastery` 的 `data`）。 */
export interface ClassroomMasteryView {
  classroom_id: string;
  students: ClassroomMasteryStudent[];
  areas: ClassroomMasteryArea[];
  /** 稀疏：`{ <user_id>: { <node_id>: 'learning' | 'mastered' } }`，`none` 省略。 */
  cells: Record<string, Record<string, Exclude<MasteryState, 'none'>>>;
}

/** 按知识点挑题的一道候选题（`items[]`）。 */
export interface KnowledgePickItem {
  problem_id: string;
  number: number | null;
  /** 作业编辑器引用：本域题为题号，跨域共享题为「来源域:题号」；无题号为 null。 */
  display_ref: string | null;
  title: string;
  /** 校准难度 0–100。 */
  difficulty: number;
  tier: DifficultyTier;
}

/** 按知识点挑题结果（`GET /domains/:slug/classrooms/:id/knowledge-pick` 的 `data`）。 */
export interface KnowledgePickView {
  node_id: string;
  node_name: string;
  items: KnowledgePickItem[];
}

/** 学生显示名：优先 `display_name`，回退 `username`。 */
export function masteryStudentLabel(student: Pick<ClassroomMasteryStudent, 'username' | 'display_name'>): string {
  const name = student.display_name?.trim();
  return name ? name : student.username;
}

/** 单元格掌握状态（稀疏 `cells` 缺省视为 `none`）。 */
export function masteryCellState(
  view: ClassroomMasteryView | null,
  userId: string,
  nodeId: string,
): MasteryState {
  return view?.cells?.[userId]?.[nodeId] ?? 'none';
}

/** 单元格提示文案：`已掌握` / `学习中` / `未开始`。 */
export function masteryCellTitle(studentLabel: string, nodeName: string, state: MasteryState): string {
  return `${studentLabel} · ${nodeName}：${masteryStateLabel(state)}`;
}

/** 节点是否有学生在学（已掌握 + 学习中 > 0）。 */
export function nodeHasLearners(node: Pick<ClassroomMasteryNode, 'counts'>): boolean {
  return node.counts.mastered + node.counts.learning > 0;
}

/**
 * 矩阵显示用领域列表：可选「只看有学生在学的知识点」，过滤后空领域不出现。
 */
export function filterMasteryAreas(
  areas: ClassroomMasteryArea[],
  onlyLearning: boolean,
): ClassroomMasteryArea[] {
  if (!onlyLearning) return areas;
  return areas
    .map((area) => ({ ...area, nodes: area.nodes.filter(nodeHasLearners) }))
    .filter((area) => area.nodes.length > 0);
}

/** 矩阵列统计文案：`已掌握 3 / 学习中 2`。 */
export function masteryCountsText(counts: ClassroomMasteryCounts): string {
  return `已掌握 ${counts.mastered} / 学习中 ${counts.learning}`;
}

/** 知识点详情页路径（`/d/<slug>/knowledge/<nodeId>`）。 */
export function knowledgeNodePath(slug: string, nodeId: string): string {
  return `/d/${encodeURIComponent(slug)}/knowledge/${encodeURIComponent(nodeId)}`;
}

/** 挑题数量允许范围。 */
export const KNOWLEDGE_PICK_MIN = 1;
export const KNOWLEDGE_PICK_MAX = 20;
export const KNOWLEDGE_PICK_DEFAULT = 5;

/** 题数输入解析：非整数或越界 → `{ error }`，界面据此禁用预览。 */
export function parsePickCount(raw: string | number): { value: number | null; error?: string } {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return { value: null, error: `题目数量需为 ${KNOWLEDGE_PICK_MIN}–${KNOWLEDGE_PICK_MAX} 的整数` };
  }
  const value = Number(text);
  if (value < KNOWLEDGE_PICK_MIN || value > KNOWLEDGE_PICK_MAX) {
    return { value: null, error: `题目数量需为 ${KNOWLEDGE_PICK_MIN}–${KNOWLEDGE_PICK_MAX} 的整数` };
  }
  return { value };
}
