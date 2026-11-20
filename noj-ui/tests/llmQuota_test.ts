/** utils/llmQuota.ts 单元测试（issue #579）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  buildQuotaPayload,
  editableQuotaLimit,
  findDuplicateQuota,
  formatQuotaLimit,
  isPlaceholderQuota,
  type LlmQuotaRow,
  type QuotaForm,
  validateQuotaForm,
} from '../utils/llmQuota.ts';

const form = (patch: Partial<QuotaForm> = {}): QuotaForm => ({
  scope_type: 'user',
  scope_id: 'u1',
  window_type: 'day',
  max_calls: 10,
  max_tokens: 1000,
  max_cost: 5,
  ...patch,
});

const row = (patch: Partial<LlmQuotaRow>): LlmQuotaRow => ({
  id: 'q1',
  revision: 1,
  scope_type: 'user',
  scope_id: 'u1',
  window_type: 'day',
  max_calls: 1,
  max_tokens: 1,
  max_cost: 1,
  created_at: '',
  updated_at: '',
  ...patch,
});

Deno.test('formatQuotaLimit: 负数不限、0 禁止、正数千分位', () => {
  assertEquals(formatQuotaLimit(null), '不限');
  assertEquals(formatQuotaLimit(-1), '不限');
  assertEquals(formatQuotaLimit(0), '禁止调用');
  assertEquals(formatQuotaLimit(1_000_000), '1,000,000');
});

Deno.test('validateQuotaForm: 非全局作用域必须填写 ID，全局忽略 ID', () => {
  assertEquals(validateQuotaForm(form({ scope_id: '  ' })), '请填写作用域 ID');
  assertEquals(validateQuotaForm(form({ scope_type: 'global', scope_id: '' })), null);
});

Deno.test('validateQuotaForm: user_problem 必须为 a:b 格式，user/problem 不得含冒号', () => {
  assertEquals(validateQuotaForm(form({ scope_type: 'user_problem', scope_id: 'u1:p1' })), null);
  assertEquals(
    validateQuotaForm(form({ scope_type: 'user_problem', scope_id: 'u1' })),
    '用户 × 题目的作用域 ID 格式应为 <用户 UUID>:<题目 UUID>',
  );
  assertEquals(
    validateQuotaForm(form({ scope_type: 'problem', scope_id: 'u1:p1' })),
    '用户 / 题目作用域 ID 不应包含冒号',
  );
});

Deno.test('validateQuotaForm: null不限、非负PG整数与数字清空区分，负数不能写入', () => {
  assertEquals(validateQuotaForm(form({ max_calls: -1, max_tokens: 0 }))?.startsWith('调用次数上限须为'), true);
  assertEquals(validateQuotaForm(form({ max_calls: -2 }))?.startsWith('调用次数上限须为'), true);
  assertEquals(validateQuotaForm(form({ max_cost: 1.5 }))?.startsWith('成本上限须为'), true);
  assertEquals(validateQuotaForm(form({ max_calls: 2147483647, max_tokens: 0, max_cost: null })), null);
  assertEquals(validateQuotaForm(form({ max_calls: 2147483648 }))?.startsWith('调用次数上限须为'), true);
  assertEquals(validateQuotaForm(form({ max_tokens: '' })), '请填写Token 数上限或选择不额外限制');
});

Deno.test('findDuplicateQuota: 按 scope/scope_id/window 精确匹配，编辑时排除自身', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', window_type: 'month' })];
  assertEquals(findDuplicateQuota(rows, 'user', ' u1 ', 'day')?.id, 'a');
  assertEquals(findDuplicateQuota(rows, 'user', 'u1', 'day', 'a'), undefined);
  assertEquals(findDuplicateQuota(rows, 'user', 'u2', 'day'), undefined);
  // 未填 ID 时不得命中 seed 占位行
  assertEquals(findDuplicateQuota([row({ id: 'p', scope_id: '' })], 'user', '  ', 'day'), undefined);
  // global 的 scope_id 归一化为空串
  const globals = [row({ id: 'g', scope_type: 'global', scope_id: '' })];
  assertEquals(findDuplicateQuota(globals, 'global', 'ignored', 'day')?.id, 'g');
});

Deno.test('buildQuotaPayload: 明确null额度、global清空ID、编辑携带id', () => {
  assertEquals(buildQuotaPayload(form({ max_calls: null }), 'q9').max_calls, null);
  assertEquals(validateQuotaForm(form({ max_calls: null })), null);
  assertEquals(buildQuotaPayload(form({ max_tokens: null, scope_id: ' u1 ' })), {
    scope_type: 'user',
    scope_id: 'u1',
    window_type: 'day',
    max_calls: 10,
    max_tokens: null,
    max_cost: 5,
  });
  assertEquals(buildQuotaPayload(form({ scope_type: 'global', scope_id: 'x' }), 'q9'), {
    id: 'q9',
    scope_type: 'global',
    scope_id: '',
    window_type: 'day',
    max_calls: 10,
    max_tokens: 1000,
    max_cost: 5,
  });
});
Deno.test('旧负额度打开编辑转null，保存不向Gateway回传-1', () => {
  const draft = form({
    max_calls: editableQuotaLimit(-1),
    max_tokens: editableQuotaLimit(-100),
    max_cost: editableQuotaLimit(0),
  });
  assertEquals(validateQuotaForm(draft), null);
  assertEquals(buildQuotaPayload(draft, 'legacy').max_calls, null);
  assertEquals(buildQuotaPayload(draft, 'legacy').max_tokens, null);
  assertEquals(buildQuotaPayload(draft, 'legacy').max_cost, 0);
});

Deno.test('isPlaceholderQuota: 非 global 且 scope_id 为空的 seed 行不生效', () => {
  assertEquals(isPlaceholderQuota({ scope_type: 'user', scope_id: '' }), true);
  assertEquals(isPlaceholderQuota({ scope_type: 'problem', scope_id: '' }), true);
  assertEquals(isPlaceholderQuota({ scope_type: 'global', scope_id: '' }), false);
  assertEquals(isPlaceholderQuota({ scope_type: 'user', scope_id: 'u1' }), false);
});
