// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { canPublishSolution, needsAcceptedCheck, type SolutionConfig } from '../utils/solutionEligibility.ts';

function config(overrides: Partial<SolutionConfig> = {}): SolutionConfig {
  return {
    solutions_enabled: true,
    read_only: false,
    solution_requires_accepted: true,
    contest_silence: false,
    ...overrides,
    permissions: { solution: true, moderate: false, ...overrides.permissions },
  };
}

Deno.test('solutionEligibility: 通过门槛开启时，未通过不可发布、通过后可发布', () => {
  assertEquals(needsAcceptedCheck(config()), true);
  assertEquals(canPublishSolution(config(), false), false);
  assertEquals(canPublishSolution(config(), true), true);
});

Deno.test('solutionEligibility: 尚未查询到通过状态时不显示入口，避免先显示后消失', () => {
  assertEquals(canPublishSolution(config(), null), false);
  assertEquals(canPublishSolution(null, true), false);
});

Deno.test('solutionEligibility: 门槛关闭时无需查询通过状态', () => {
  const open = config({ solution_requires_accepted: false });
  assertEquals(needsAcceptedCheck(open), false);
  assertEquals(canPublishSolution(open, null), true);
});

Deno.test('solutionEligibility: 审核员不受通过门槛与只读限制', () => {
  const moderator = config({ read_only: true, permissions: { solution: false, moderate: true } });
  assertEquals(needsAcceptedCheck(moderator), false);
  assertEquals(canPublishSolution(moderator, null), true);
});

Deno.test('solutionEligibility: 模块关闭、赛时静默、只读、无发帖权限均不可发布', () => {
  assertEquals(canPublishSolution(config({ solutions_enabled: false }), true), false);
  assertEquals(canPublishSolution(config({ contest_silence: true }), true), false);
  assertEquals(canPublishSolution(config({ read_only: true }), true), false);
  assertEquals(canPublishSolution(config({ permissions: { solution: false } }), true), false);
});
