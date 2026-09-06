// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
type ContestAntiCheatGroup = {
  ip: string;
  account_count: number;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
  accounts: Array<{
    user_id: string;
    username: string;
    submission_count: number;
    first_submission_at: string;
    last_submission_at: string;
  }>;
};

Deno.test('竞赛风控 DTO 仅包含人工复核所需的最小字段', () => {
  const group: ContestAntiCheatGroup = {
    ip: '203.0.113.10',
    account_count: 2,
    submission_count: 3,
    first_submission_at: '2026-01-01T00:00:00.000Z',
    last_submission_at: '2026-01-01T00:03:00.000Z',
    accounts: [{
      user_id: 'u1',
      username: 'alice',
      submission_count: 2,
      first_submission_at: '2026-01-01T00:00:00.000Z',
      last_submission_at: '2026-01-01T00:02:00.000Z',
    }],
  };
  assertEquals(group.account_count, 2);
  assertStringIncludes(group.ip, '203.0.113.');
  assertEquals('email' in group.accounts[0]!, false);
});
