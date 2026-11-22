/** utils/contestHidden.ts 单元测试（VULN-07：公开赛收编题目的斜纹标识契约）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { CONTEST_HIDDEN_STRIPES_CLASS, CONTEST_HIDDEN_TIP, contestHiddenRowClass } from '../utils/contestHidden.ts';

Deno.test('contestHiddenRowClass: 仅显式 true 才加斜纹底', () => {
  assertEquals(contestHiddenRowClass(true), CONTEST_HIDDEN_STRIPES_CLASS);
  // 后端未下发（undefined）或普通用户视图：不得凭空加标识
  assertEquals(contestHiddenRowClass(undefined), '');
  assertEquals(contestHiddenRowClass(null), '');
  assertEquals(contestHiddenRowClass(false), '');
});

Deno.test('contestHidden: 样式类名与提示文案是单一事实来源', () => {
  // 类名必须与 assets/css/main.css 的 @utility 定义一致（样式在 CSS，类名在此）
  assertEquals(CONTEST_HIDDEN_STRIPES_CLASS, 'contest-hidden-stripes');
  assertEquals(CONTEST_HIDDEN_TIP, '该题目已被公开赛收编，当前对普通用户处于隐藏保密状态');
});
