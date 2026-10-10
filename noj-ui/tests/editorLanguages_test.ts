/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- 版本由锁文件固定
import { assertEquals } from 'jsr:@std/assert@^1';
import { getEditorLanguages, getMonacoLanguage } from '../utils/editorLanguages.ts';

Deno.test('编辑器：OI 展示 C++/C，cc 使用 C++ 高亮', () => {
  const options = getEditorLanguages({ judge_type: 'oi', supported_languages: ['c', 'cc'] });
  assertEquals(options.map((option) => option.value), ['cc', 'c']);
  assertEquals(getMonacoLanguage(options[0].value), 'cpp');
});

Deno.test('编辑器：仅允许 C 的题目不展示 C++，OI 缺配置不回退到 Python', () => {
  assertEquals(getEditorLanguages({ judge_type: 'oi', supported_languages: ['c'] }).map((o) => o.value), ['c']);
  assertEquals(getEditorLanguages({ judge_type: 'oi' }), []);
  assertEquals(getEditorLanguages({ judge_type: 'oi', supported_languages: [] }), []);
});

Deno.test('编辑器：已有 Python 题保持可提交，未知语言使用纯文本', () => {
  assertEquals(getEditorLanguages({}).map((option) => option.value), ['python3']);
  assertEquals(getMonacoLanguage('python3'), 'python');
  assertEquals(getMonacoLanguage('unknown'), 'plaintext');
});
