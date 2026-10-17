/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  bundleImportErrorMessage,
  bundleImportSuccessMessage,
  effectiveVisibility,
  validateZipFileName,
} from '../utils/bundleImport.ts';

Deno.test('validateZipFileName: 仅接受 .zip（大小写不敏感）', () => {
  assertEquals(validateZipFileName('a.zip'), null);
  assertEquals(validateZipFileName('A.ZIP'), null);
  assertEquals(validateZipFileName('a.tar.gz'), '仅支持 .zip 格式文件');
  assertEquals(validateZipFileName('zip'), '仅支持 .zip 格式文件');
});

Deno.test('effectiveVisibility: P 型一律公开，U 型保留选择', () => {
  // 回归：P 型下可见性选择被隐藏，默认「私有」残留导致建题被拒（P 型题目必须公开）
  assertEquals(effectiveVisibility('P', 'private'), 'public');
  assertEquals(effectiveVisibility('P', 'public'), 'public');
  assertEquals(effectiveVisibility('U', 'private'), 'private');
  assertEquals(effectiveVisibility('U', 'public'), 'public');
});

Deno.test('bundleImportSuccessMessage: 区分草稿 / 新发布 / 内容未变化', () => {
  assertEquals(
    bundleImportSuccessMessage({ id: 'x', display_id: 'P13', published: null }),
    '已导入 P13（草稿：核对后发布即可作答）',
  );
  assertEquals(
    bundleImportSuccessMessage({ id: 'x', display_id: 'P13', published: { version: 2 } }),
    '已导入 P13 并发布 V2',
  );
  assertStringIncludes(
    bundleImportSuccessMessage({
      id: 'x',
      display_id: 'P13',
      published: { version: 1, unchanged: true },
    }),
    '内容未变化',
  );
  // 缺少 display_id 时回退到标题
  assertStringIncludes(bundleImportSuccessMessage({ id: 'x', title: '回文串判定' }), '回文串判定');
});

Deno.test('bundleImportErrorMessage: 428（题号撞到已有题目）改写为可操作提示', () => {
  const msg = bundleImportErrorMessage({
    message: '保存草稿必须携带 If-Match: <revision>（缺少预期 revision）',
    code: 'DRAFT_REVISION_REQUIRED',
    status: 428,
  });
  assertStringIncludes(msg, 'number');
  assertStringIncludes(msg, '编辑页');
  // 其他错误原样透传
  assertEquals(
    bundleImportErrorMessage({ message: '根级缺 evaluate.py', status: 400 }),
    '根级缺 evaluate.py',
  );
});
