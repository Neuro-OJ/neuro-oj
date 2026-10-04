/**
 * LLM 配额管理页（issue #579）的纯逻辑：校验、去重、展示格式化。
 *
 * 与 noj-llm-gateway 语义对齐：
 * - 计数键为 `(scope_type, scope_id, window_type)` 精确匹配，无通配回退；
 *   `global` 的 scope_id 恒为 `""`，`user_problem` 为 `<userId>:<problemId>`。
 * - 限额取值：`-1`（任意负数）= 不限，`0` = 禁止调用，正数 = 上限。
 * - gateway 的 POST 按 id upsert；不带 id 一律新增。若同键已有行仍新增，
 *   会产生重复行且 gateway `LIMIT 1` 命中不确定，因此保存前必须先查重。
 */

/** 配额作用域类型 */
export type QuotaScopeType = 'global' | 'user' | 'problem' | 'user_problem';
/** 配额窗口类型 */
export type QuotaWindowType = 'day' | 'month';

/** gateway `llm_quotas` 行 */
export interface LlmQuotaRow {
  id: string;
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls: number;
  max_tokens: number;
  max_cost: number;
  created_at: string;
  updated_at: string;
}

/** 编辑表单状态；限额为空字符串表示"使用 gateway 环境变量默认值"（仅新增时允许） */
export interface QuotaForm {
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls: number | '';
  max_tokens: number | '';
  max_cost: number | '';
}

/** 提交给 `POST /api/v1/admin/gateway/llm/quotas` 的请求体 */
export interface QuotaPayload {
  id?: string;
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls?: number;
  max_tokens?: number;
  max_cost?: number;
}

/** 作用域选项（含 scope_id 填写说明） */
export const QUOTA_SCOPE_OPTIONS: { value: QuotaScopeType; label: string; hint: string }[] = [
  { value: 'global', label: '全局', hint: '全站所有 LLM 调用合计，无需填写作用域 ID' },
  { value: 'user', label: '用户', hint: '填写用户 UUID（用户管理页可复制）' },
  { value: 'problem', label: '题目', hint: '填写题目 UUID（题目管理页可复制）' },
  { value: 'user_problem', label: '用户 × 题目', hint: '格式为 <用户 UUID>:<题目 UUID>' },
];

/** 窗口选项（按 UTC 自然日 / 自然月重置） */
export const QUOTA_WINDOW_OPTIONS: { value: QuotaWindowType; label: string }[] = [
  { value: 'day', label: '每日（UTC）' },
  { value: 'month', label: '每月（UTC）' },
];

const LIMIT_FIELDS = [
  ['max_calls', '调用次数'],
  ['max_tokens', 'Token 数'],
  ['max_cost', '成本'],
] as const;

/** 作用域类型的中文名 */
export function scopeLabel(scope: string): string {
  return QUOTA_SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
}

/** 窗口类型的中文名 */
export function windowLabel(window: string): string {
  return QUOTA_WINDOW_OPTIONS.find((o) => o.value === window)?.label ?? window;
}

/** 限额展示：负数 = 不限，0 = 禁止调用，正数按千分位。 */
export function formatQuotaLimit(value: number): string {
  if (value < 0) return '不限';
  if (value === 0) return '禁止调用';
  return value.toLocaleString('zh-CN');
}

/**
 * 是否为 gateway seed 写入的占位行：非 global 作用域但 scope_id 为空。
 * 计数键按具体 user/problem id 精确匹配，这类行永远不会命中，修改它不会影响任何调用；
 * 要改默认值应修改网关 env `NOJ_LLM_DEFAULT_*`。
 */
export function isPlaceholderQuota(row: Pick<LlmQuotaRow, 'scope_type' | 'scope_id'>): boolean {
  return row.scope_type !== 'global' && row.scope_id === '';
}

/** 规范化 scope_id：去首尾空白，global 恒为空串。 */
export function normalizeScopeId(scope: QuotaScopeType, scopeId: string): string {
  return scope === 'global' ? '' : scopeId.trim();
}

/**
 * 校验表单；返回首个错误文案，通过时返回 null。
 * @param allowEmptyLimits 新增时允许限额留空（交由 gateway 用 env 默认值填充）
 */
export function validateQuotaForm(form: QuotaForm, allowEmptyLimits: boolean): string | null {
  const scopeId = normalizeScopeId(form.scope_type, form.scope_id);
  if (form.scope_type !== 'global' && !scopeId) {
    return '请填写作用域 ID';
  }
  if (form.scope_type === 'user_problem' && !/^[^:\s]+:[^:\s]+$/.test(scopeId)) {
    return '用户 × 题目的作用域 ID 格式应为 <用户 UUID>:<题目 UUID>';
  }
  if ((form.scope_type === 'user' || form.scope_type === 'problem') && scopeId.includes(':')) {
    return '用户 / 题目作用域 ID 不应包含冒号';
  }
  for (const [key, label] of LIMIT_FIELDS) {
    const value = form[key];
    if (value === '') {
      if (!allowEmptyLimits) return `请填写${label}上限`;
      continue;
    }
    // gateway 列为 integer，小数会被数据库拒绝
    if (!Number.isInteger(value) || value < -1) {
      return `${label}上限须为 ≥ -1 的整数（-1 不限，0 禁止调用）`;
    }
  }
  return null;
}

/**
 * 查找与表单同键 `(scope_type, scope_id, window_type)` 的已有配额。
 * @param excludeId 编辑时排除自身
 */
export function findDuplicateQuota(
  rows: LlmQuotaRow[],
  scope: QuotaScopeType,
  scopeId: string,
  window: QuotaWindowType,
  excludeId?: string,
): LlmQuotaRow | undefined {
  const normalized = normalizeScopeId(scope, scopeId);
  // 未填作用域 ID 时不查重，避免误匹配 seed 占位行（见 isPlaceholderQuota）
  if (scope !== 'global' && !normalized) return undefined;
  return rows.find((r) =>
    r.id !== excludeId &&
    r.scope_type === scope &&
    r.scope_id === normalized &&
    r.window_type === window
  );
}

/** 构造请求体；留空的限额字段省略，由 gateway 回退到 env 默认值。 */
export function buildQuotaPayload(form: QuotaForm, id?: string): QuotaPayload {
  const payload: QuotaPayload = {
    scope_type: form.scope_type,
    scope_id: normalizeScopeId(form.scope_type, form.scope_id),
    window_type: form.window_type,
  };
  if (id) payload.id = id;
  for (const [key] of LIMIT_FIELDS) {
    const value = form[key];
    if (value !== '') payload[key] = value;
  }
  return payload;
}
