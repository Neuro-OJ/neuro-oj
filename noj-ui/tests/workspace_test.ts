/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  workspaceCacheKey,
  workspaceInvitationLink,
  workspaceInvitationToken,
  workspacePath,
  workspaceProblemPath,
  workspaceSlugFromPath,
} from '../utils/workspace.ts';
import { safeAuthRedirect } from '../utils/authRedirect.ts';

Deno.test('域路径：引用题保留使用域，旧 P/U 不作为新域题号', () => {
  assertEquals(workspaceProblemPath('school', 'main:1001'), '/d/school/problems/main:1001');
  assertEquals(workspaceProblemPath('main', '1001'), '/d/main/problems/1001');
  for (const invalid of ['P1001', 'U1001', 'main:0', '../1001', '2147483648']) {
    assertThrows(() => workspaceProblemPath('school', invalid));
  }
  assertThrows(() => workspacePath('../main'));
  assertThrows(() => workspacePath('school', '../settings'));
  assertEquals(workspaceSlugFromPath('/d/school/settings'), 'school');
  assertEquals(workspaceSlugFromPath('/problems/P1001'), null);
});
Deno.test('域缓存：同题同版本的域、用户和资源互不复用数据键', () => {
  const keys = [
    workspaceCacheKey('school-one', 'u1', 'problem', 'p1', 'v1'),
    workspaceCacheKey('school-two', 'u1', 'problem', 'p1', 'v1'),
    workspaceCacheKey('school-one', 'u2', 'problem', 'p1', 'v1'),
    workspaceCacheKey('school-one', 'u1', 'problem', 'p1', 'v2'),
  ];
  assertEquals(new Set(keys).size, 4);
});
Deno.test('邀请链接：令牌只进入 fragment，不能进入查询字符串或服务端路径', () => {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const link = new URL(workspaceInvitationLink('https://noj.example', token));
  assertEquals(link.pathname, '/join');
  assertEquals(link.search, '');
  assertEquals(workspaceInvitationToken(link.hash), token);
  assertEquals(new URL(workspaceInvitationLink('https://noj.example', token, true)).pathname, '/register');
  assertEquals(workspaceInvitationToken('#invitation=bad'), null);
});
Deno.test('认证回跳：只接受本站路径，拒绝外站、控制字符和编码反斜线', () => {
  assertEquals(safeAuthRedirect('/d/school/settings?tab=members'), '/d/school/settings?tab=members');
  for (
    const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/%5cevil.example',
      '/%2f%2fevil.example',
      '/x\n',
      '/%00x',
      ['a'],
    ]
  ) assertEquals(safeAuthRedirect(bad), '/');
});
