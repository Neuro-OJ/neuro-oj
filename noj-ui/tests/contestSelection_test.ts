/** utils/contestSelection.ts 单元测试（VULN-04 / VULN-05：邀请赛公开题风险提示）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  INVITE_PUBLIC_PROBLEM_WARNING,
  invitePublicProblemIds,
  needsInvitePublicWarning,
} from '../utils/contestSelection.ts';

const OPTIONS = [
  { id: 'p-public', visibility: 'public' as const },
  { id: 'p-private', visibility: 'private' as const },
  { id: 'p-unknown' },
];

Deno.test('invitePublicProblemIds: 只挑出后端确实标记为 public 的已选题目', () => {
  assertEquals(
    invitePublicProblemIds('invite', ['p-private', 'p-public'], OPTIONS),
    ['p-public'],
  );
  // 可见性未知（后端未返回该字段 / 候选项未加载到该题）时不猜测、不提示
  assertEquals(invitePublicProblemIds('invite', ['p-unknown'], OPTIONS), []);
  assertEquals(invitePublicProblemIds('invite', [], OPTIONS), []);
});

Deno.test('invitePublicProblemIds: 公开赛不存在该风险（其题目本就全站保密）', () => {
  assertEquals(invitePublicProblemIds('public', ['p-public'], OPTIONS), []);
  assertEquals(invitePublicProblemIds(undefined, ['p-public'], OPTIONS), []);
});

Deno.test('needsInvitePublicWarning: 仅邀请赛 + 选中公开题时为 true', () => {
  assertEquals(needsInvitePublicWarning('invite', ['p-public'], OPTIONS), true);
  assertEquals(needsInvitePublicWarning('invite', ['p-private'], OPTIONS), false);
  assertEquals(needsInvitePublicWarning('public', ['p-public'], OPTIONS), false);
});

Deno.test('风险提示文案与需求原文一致（违反"公开题无法全站隐藏"的认知风险必须明说）', () => {
  assertEquals(
    INVITE_PUBLIC_PROBLEM_WARNING,
    '若希望比赛题目对外完全保密，请务必使用您名下的私有题目（Private）。公开题目无法在全站隐藏，仍允许公共练习。',
  );
});
