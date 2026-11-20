// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { extractApiError } from '../utils/apiError.ts';
import { messages, translate, translateErrorCode } from '../utils/i18n.ts';

Deno.test('文案表：按键取中文并替换占位符，未知键原样返回', () => {
  assertEquals(translate('contest.count', { count: 3 }), '共 3 场竞赛');
  assertEquals(translate('not.a.key'), 'not.a.key');
});

Deno.test('文案表：只保留中文，不再有按语言分组的结构', () => {
  assertEquals(typeof messages['contest.count'], 'string');
  assertEquals('zh-CN' in messages, false);
  assertEquals('en-US' in messages, false);
});

Deno.test('API 错误：后端给出具体原因时优先展示原因', () => {
  const error = { data: { error: '后端中文错误', code: 'PASSWORD_INVALID', request_id: 'req-1' }, status: 401 };
  assertEquals(extractApiError(error), {
    message: '后端中文错误',
    code: 'PASSWORD_INVALID',
    status: 401,
    requestId: 'req-1',
  });
});

Deno.test('API 错误：缺少具体原因时按机器码映射中文文案', () => {
  const localized = translateErrorCode('PASSWORD_INVALID');
  assertEquals(typeof localized, 'string');
  assertEquals(extractApiError({ data: { code: 'PASSWORD_INVALID' }, status: 401 }).message, localized);
  assertEquals(translateErrorCode(undefined), undefined);
});

Deno.test('API 错误：未知机器码保留后端具体原因', () => {
  assertEquals(extractApiError({ data: { error: '具体原因', code: 'CUSTOM_ERROR' } }).message, '具体原因');
});
