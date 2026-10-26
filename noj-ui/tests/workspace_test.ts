/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  formatInvitationCode,
  getInvitationStatus,
  isInvitationCredential,
  normalizeInvitationCredential,
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
Deno.test('邀请链接与短码：支持 72 位长令牌与 12 位短码，支持格式化和大小写规范化', () => {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const link = new URL(workspaceInvitationLink('https://noj.example', token));
  assertEquals(link.pathname, '/join');
  assertEquals(link.search, '');
  assertEquals(workspaceInvitationToken(link.hash), token);
  assertEquals(new URL(workspaceInvitationLink('https://noj.example', token, true)).pathname, '/register');

  // 短码测试
  const shortCode = '2345-6789-ABCD';
  const shortLink = new URL(workspaceInvitationLink('https://noj.example', shortCode));
  assertEquals(workspaceInvitationToken(shortLink.hash), shortCode);
  assertEquals(workspaceInvitationToken('#token=2345-6789-abcd'), '2345-6789-abcd');
  assertEquals(workspaceInvitationToken('#invitation=2345-6789-ABCD'), '2345-6789-ABCD');
  assertEquals(workspaceInvitationToken('#2345-6789-ABCD'), '2345-6789-ABCD');

  // 格式化与规范化
  assertEquals(formatInvitationCode('23456789abcd'), '2345-6789-ABCD');
  assertEquals(formatInvitationCode('2345-6789-ABCD'), '2345-6789-ABCD');
  assertEquals(normalizeInvitationCredential('2345-6789-abcd'), '23456789ABCD');
  assertEquals(normalizeInvitationCredential(token), token);

  // 凭据格式检查（排除 0, 1, I, O 等易混淆字符）
  assertEquals(isInvitationCredential('23456789ABCD'), true);
  assertEquals(isInvitationCredential('2345-6789-ABCD'), true);
  assertEquals(isInvitationCredential(token), true);
  assertEquals(isInvitationCredential('invalid-code'), false);
  assertEquals(isInvitationCredential('23456789ABC0'), false); // 含 0
  assertEquals(isInvitationCredential('23456789ABCI'), false); // 含 I
  assertEquals(workspaceInvitationToken('#invitation=bad'), null);
});
Deno.test('邀请状态判定：used_at 是最后使用时间不代表通用邀请耗尽，状态由 revoked/expiry/max_uses 与 used_count 决定', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  // 有效的通用邀请（即使有 used_at 且 used_count > 0）
  assertEquals(
    getInvitationStatus({
      revoked_at: null,
      expires_at: future,
      max_uses: 10,
      used_count: 3,
    }),
    'active',
  );

  // 无限人数通用邀请
  assertEquals(
    getInvitationStatus({
      revoked_at: null,
      expires_at: future,
      max_uses: null,
      used_count: 50,
    }),
    'active',
  );

  // 已用尽
  assertEquals(
    getInvitationStatus({
      revoked_at: null,
      expires_at: future,
      max_uses: 5,
      used_count: 5,
    }),
    'used_up',
  );

  // 已过期（即使未用尽）
  assertEquals(
    getInvitationStatus({
      revoked_at: null,
      expires_at: past,
      max_uses: 10,
      used_count: 1,
    }),
    'expired',
  );

  // 已撤销（优先级高于过期和用尽）
  assertEquals(
    getInvitationStatus({
      revoked_at: new Date().toISOString(),
      expires_at: past,
      max_uses: 1,
      used_count: 1,
    }),
    'revoked',
  );
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
