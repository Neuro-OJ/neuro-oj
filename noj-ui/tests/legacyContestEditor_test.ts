/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { legacyContestEditorDestination } from '../utils/legacyContestEditor.ts';

Deno.test('旧竞赛编辑器深链接：带 contest/label 时转到域作答页', () => {
  assertEquals(
    legacyContestEditorDestination('/editor/abc', { contest: 'ct-1', label: 'A' }),
    '/d/main/contests/ct-1/solve/A',
  );
  // 题号与比赛 ID 都要编码：旧链接可能带空格或中文题号。
  assertEquals(
    legacyContestEditorDestination('/editor/abc', { contest: 'ct 1', label: 'A/1' }),
    '/d/main/contests/ct%201/solve/A%2F1',
  );
});

Deno.test('旧竞赛编辑器深链接：不是该路径或参数不全时不动', () => {
  assertEquals(legacyContestEditorDestination('/d/main/problems/1', { contest: 'x', label: 'A' }), null);
  assertEquals(legacyContestEditorDestination('/editor/abc', {}), null);
  assertEquals(legacyContestEditorDestination('/editor/abc', { contest: 'ct-1' }), null);
  assertEquals(legacyContestEditorDestination('/editor/abc', { label: 'A' }), null);
  // 缺 label 不猜题号；空串同理，交由页面呈现既有报错。
  assertEquals(legacyContestEditorDestination('/editor/abc', { contest: '', label: 'A' }), null);
  assertEquals(legacyContestEditorDestination('/editor/abc', { contest: ['a', 'b'], label: 'A' }), null);
});
