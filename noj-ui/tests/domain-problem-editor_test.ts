/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  domainEditorPayload,
  newDomainEditorContent,
  normalizeDomainEditorContent,
} from '../utils/domain-problem-editor.ts';
import type { DomainOiRuntime } from '../utils/domain-problem-editor.ts';
Deno.test('域草稿：OI 编辑保留既有文件扩展、测试点 ID 和专属限制', () => {
  const input = newDomainEditorContent('oi');
  const runtime = input.runtime_config as DomainOiRuntime;
  runtime.compile_extra_files = ['include.hpp'];
  runtime.subtasks[0]!.cases[0]!.id = 'stable-case';
  const normalized = normalizeDomainEditorContent(input);
  assertEquals((normalized.runtime_config as DomainOiRuntime).compile_extra_files, ['include.hpp']);
  assertEquals((normalized.runtime_config as DomainOiRuntime).subtasks[0]!.cases[0]!.id, 'stable-case');
});
Deno.test('域草稿：预算留空省略字段，不改变当前表单或强制Provider模型', () => {
  const input = newDomainEditorContent('ai');
  input.llm_config = Object.assign({ max_calls: '' as unknown as number, max_tokens: 5000 }, {
    provider_id: 'old-provider',
    model: 'old-model',
  });
  const payload = domainEditorPayload(input);
  assertEquals(payload.llm_config, { max_tokens: 5000 });
  assertEquals(input.llm_config.max_calls, '' as unknown as number);
  assertEquals('provider_id' in payload.llm_config!, false);
  assertEquals('model' in payload.llm_config!, false);
  assertEquals('model' in input.llm_config, true);
});
