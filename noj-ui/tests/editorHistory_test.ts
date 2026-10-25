/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { getEditorHistoryUrl } from '../utils/editorHistory.ts';

Deno.test('公开题号解析后，历史使用内部 ID 和接口支持的分页参数', () => {
  const problem = { id: '26305994-955e-44be-88a0-19f7567a67d5', display_id: 'P17' };
  assertEquals(
    getEditorHistoryUrl(problem),
    '/api/v1/submissions?problem_id=26305994-955e-44be-88a0-19f7567a67d5&per_page=30',
  );
  assertEquals(getEditorHistoryUrl(null), '');
});

Deno.test('竞赛历史保持专用接口，不混入普通题库记录', () => {
  assertEquals(
    getEditorHistoryUrl({ id: 'problem-id' }, 'contest-id'),
    '/api/v1/contests/contest-id/my-submissions?per_page=100',
  );
});
