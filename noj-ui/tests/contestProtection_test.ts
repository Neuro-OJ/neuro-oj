// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { contestProtectionFromError } from '../utils/contestProtection.ts';

Deno.test('赛题保护：普通错误保持原错误处理，缺失比赛列表仍识别保护状态', () => {
  assertEquals(contestProtectionFromError(null), null);
  assertEquals(contestProtectionFromError({ data: { code: 'NOT_FOUND' } }), null);
  assertEquals(contestProtectionFromError({ data: { code: 'CONTEST_PROBLEM_RESTRICTED' } }), []);
});

Deno.test('赛题保护：只接受本站比赛标识，拒绝外部地址及畸形引用', () => {
  const ref = { contestId: 'contest-uuid', publicId: 'ct-abc123', title: '域比赛' };
  assertEquals(
    contestProtectionFromError({
      data: {
        code: 'CONTEST_PROBLEM_RESTRICTED',
        contests: [ref, null, { ...ref, publicId: 'https://example.com' }, { ...ref, publicId: '../admin' }, {
          publicId: 'ct-ok',
        }],
      },
    }),
    [ref],
  );
});
