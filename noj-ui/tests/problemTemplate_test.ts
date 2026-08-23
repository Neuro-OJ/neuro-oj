/** utils/problemTemplate.ts 单元测试。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { getProblemTemplateUrl } from '../utils/problemTemplate.ts';

Deno.test('getProblemTemplateUrl: 普通题目和竞赛题目均指向题目模板端点', () => {
  assertEquals(getProblemTemplateUrl('problem-uuid'), '/api/v1/problems/problem-uuid/template');
  assertEquals(getProblemTemplateUrl('contest-problem-uuid'), '/api/v1/problems/contest-problem-uuid/template');
});
