/**
 * LLM 配额管理页（issue #579）的纯逻辑：校验、去重、展示格式化。
 *
 * 与 noj-llm-gateway 语义对齐：
 * - 计数键为 `(scope_type, scope_id, window_type)` 精确匹配，无通配回退；
 *   `global` 的 scope_id 恒为 `""`，`user_problem` 为 `<userId>:<problemId>`。
 * - 新写限额：null 不限，0 禁止调用，非负 PostgreSQL integer 为上限。
 *   历史负数只在读取时兼容，打开编辑先转为 null。
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
  revision: number;
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls: number | null;
  max_tokens: number | null;
  max_cost: number | null;
  created_at: string;
  updated_at: string;
}

/** 编辑表单状态；清空数字输入的空字符串必须在保存前补齐或选择不限。 */
export interface QuotaForm {
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls: number | null | '';
  max_tokens: number | null | '';
  max_cost: number | null | '';
}

/** 提交给 `POST /api/v1/admin/gateway/llm/quotas` 的请求体 */
export interface QuotaPayload {
  id?: string;
  scope_type: QuotaScopeType;
  scope_id: string;
  window_type: QuotaWindowType;
  max_calls?: number | null;
  max_tokens?: number | null;
  max_cost?: number | null;
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
export function formatQuotaLimit(value: number | null): string {
  if (value === null || value < 0) return '不限';
  if (value === 0) return '禁止调用';
  return value.toLocaleString('zh-CN');
}
/** 旧记录负数表示不限，编辑时使用当前 null 协议。 */
export function editableQuotaLimit(value: number | null): number | null {
  return value !== null && value < 0 ? null : value;
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
 */
export function validateQuotaForm(form: QuotaForm): string | null {
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
    if (value === null) continue;
    if (value === '') return `请填写${label}上限或选择不额外限制`;
    // gateway 列为 integer，小数会被数据库拒绝
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      return `${label}上限须为 0–2147483647 的整数；不限请使用不额外限制选项`;
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

/** 从已经通过 validateQuotaForm 的表单构造完整额度请求。 */
export function buildQuotaPayload(form: QuotaForm, id?: string): QuotaPayload {
  const payload: QuotaPayload = {
    scope_type: form.scope_type,
    scope_id: normalizeScopeId(form.scope_type, form.scope_id),
    window_type: form.window_type,
  };
  if (id) payload.id = id;
  for (const [key] of LIMIT_FIELDS) {
    payload[key] = form[key] as number | null;
  }
  return payload;
}
