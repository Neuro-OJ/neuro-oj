/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import { bundleImportErrorMessage, bundleImportSuccessMessage, validateZipFileName } from '../utils/bundleImport.ts';

Deno.test('validateZipFileName: 仅接受 .zip（大小写不敏感）', () => {
  assertEquals(validateZipFileName('a.zip'), null);
  assertEquals(validateZipFileName('A.ZIP'), null);
  assertEquals(validateZipFileName('a.tar.gz'), '仅支持 .zip 格式文件');
  assertEquals(validateZipFileName('zip'), '仅支持 .zip 格式文件');
});

Deno.test('bundleImportSuccessMessage: 区分草稿 / 新发布 / 内容未变化', () => {
  assertEquals(
    bundleImportSuccessMessage({ problem_id: 'x', number: 1001, draft_revision: 1, published: null }),
    '已导入 1001（草稿：核对后发布即可作答）',
  );
  assertEquals(
    bundleImportSuccessMessage({ problem_id: 'x', number: 1001, draft_revision: 1, published: { version: 2 } }),
    '已导入 1001 并发布 V2',
  );
  assertStringIncludes(
    bundleImportSuccessMessage({
      problem_id: 'x',
      number: 1001,
      draft_revision: 1,
      published: { version: 1, unchanged: true },
    }),
    '内容未变化',
  );
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
