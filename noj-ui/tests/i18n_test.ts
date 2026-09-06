// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { extractApiError } from '../utils/apiError.ts';
import { normalizeLocale, translate } from '../utils/i18n.ts';

Deno.test('i18n defaults to Chinese and interpolates messages', () => {
  assertEquals(normalizeLocale(undefined), 'zh-CN');
  assertEquals(normalizeLocale('en'), 'en-US');
  assertEquals(translate('en-US', 'contest.count', { count: 3 }), '3 contests');
  assertEquals(translate('zh-CN', 'contest.count', { count: 3 }), '共 3 场竞赛');
});

Deno.test('API error codes are localized before backend error text', () => {
  const error = { data: { error: '后端中文错误', code: 'PASSWORD_INVALID', request_id: 'req-1' }, status: 401 };
  assertEquals(extractApiError(error, 'en-US'), {
    message: 'Incorrect password',
    code: 'PASSWORD_INVALID',
    status: 401,
    requestId: 'req-1',
  });
  assertEquals(extractApiError(error).message, '后端中文错误');
});

Deno.test('unknown API error codes keep the backend detail as a safe fallback', () => {
  assertEquals(extractApiError({ data: { error: '具体原因', code: 'CUSTOM_ERROR' } }, 'en-US').message, '具体原因');
});
