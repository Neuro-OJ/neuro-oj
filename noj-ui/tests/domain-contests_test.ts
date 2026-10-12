// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { contestPenaltyText, domainContestAllows, domainContestDefaults } from '../utils/domain-contests.ts';
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
