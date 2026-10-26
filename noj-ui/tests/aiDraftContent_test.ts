/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { readAiDraftPassthrough } from '../utils/aiDraftContent.ts';

Deno.test('aiDraftContent: 界面题草稿读回提交模式与脚本模板', () => {
  const template = 'def get_config() -> dict:\n    return {"prompt": PARAMS.get("prompt", "")}\n';
  assertEquals(
    readAiDraftPassthrough({
      kind: 'ai',
      submission_mode: 'ui',
      template_content: template,
    }),
    { submission_mode: 'ui', template_content: template },
  );
});

Deno.test('aiDraftContent: 全部提交模式均可读回', () => {
  for (const mode of ['code', 'artifact', 'prediction', 'ui'] as const) {
    assertEquals(
      readAiDraftPassthrough({ submission_mode: mode }).submission_mode,
      mode,
    );
  }
});

Deno.test('aiDraftContent: 空模板保留为空串，缺失或非法字段返回 undefined', () => {
  assertEquals(readAiDraftPassthrough({ template_content: '' }), {
    template_content: '',
  });
  assertEquals(readAiDraftPassthrough({}), {});
  assertEquals(
    readAiDraftPassthrough({ submission_mode: 'bogus', template_content: 1 }),
    {},
  );
});
