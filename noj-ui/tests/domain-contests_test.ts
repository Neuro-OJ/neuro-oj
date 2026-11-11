// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  contestPenaltyText,
  domainContestAllows,
  domainContestConfig,
  domainContestDefaults,
} from '../utils/domain-contests.ts';
Deno.test('五赛制题型限制和默认榜单对应确认规则', () => {
  assertEquals(domainContestAllows('kaggle', 'oi'), false);
  assertEquals(domainContestAllows('kaggle', 'objective'), true);
  assertEquals(domainContestAllows('oi', 'objective'), true);
  for (const type of ['ioi', 'ioi_strict', 'acm'] as const) {
    assertEquals(domainContestAllows(type, 'oi'), true);
    assertEquals(domainContestAllows(type, 'objective'), false);
  }
  assertEquals(domainContestDefaults('oi').ranking_visibility, 'hidden');
  assertEquals(domainContestDefaults('ioi').ranking_visibility, 'participants');
  assertEquals(domainContestDefaults('kaggle').config.scoreboard_scope, 'self');
  assertEquals(domainContestDefaults('acm').config.penalty_minutes, 20);
  assertEquals(domainContestDefaults('acm').freeze_duration_seconds, 3600);
  assertEquals(contestPenaltyText(1230000), '20 分钟');
});
Deno.test('域内编辑竞赛保留管理后台设置的提交次数限制', () => {
  const fields = { penalty_minutes: 30, scoreboard_scope: 'full' as const };
  const existing = { scoreboard_scope: 'self' as const, submission_limits: { p1: 5 } };
  assertEquals(domainContestConfig('kaggle', fields, existing), {
    scoreboard_scope: 'full',
    submission_limits: { p1: 5 },
  });
  assertEquals(domainContestConfig('acm', fields, { submission_limits: { p2: 3 } }), {
    penalty_minutes: 30,
    submission_limits: { p2: 3 },
  });
  assertEquals(domainContestConfig('oi', fields), {});
  assertEquals(domainContestConfig('kaggle', fields, { scoreboard_scope: 'self' }), { scoreboard_scope: 'full' });
});
