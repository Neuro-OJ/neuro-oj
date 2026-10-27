/** utils/contestWindow.ts 的纯逻辑单元测试。 */
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  contestCountdown,
  contestDurationText,
  contestProblemsState,
  contestRegistrationState,
  rankingVisibilityText,
  scoreboardScopeText,
} from '../utils/contestWindow.ts';

const base = {
  isLoggedIn: true,
  isRegistered: false,
  status: 'running' as const,
  kind: 'public' as const,
  hasPassword: false,
  canManage: false,
};

Deno.test('contestWindow: 已结束优先于登录与报名状态', () => {
  assertEquals(contestRegistrationState({ ...base, status: 'ended' }), { kind: 'ended' });
  assertEquals(contestRegistrationState({ ...base, status: 'ended', isLoggedIn: false }), { kind: 'ended' });
});

Deno.test('contestWindow: 未登录只引导登录，不进入报名', () => {
  assertEquals(contestRegistrationState({ ...base, isLoggedIn: false }), { kind: 'login' });
});

Deno.test('contestWindow: 已报名进入参赛者态，未报名进入报名态', () => {
  assertEquals(contestRegistrationState({ ...base, isRegistered: true }), { kind: 'registered', canEnter: true });
  assertEquals(contestRegistrationState(base), {
    kind: 'register',
    needsCredential: false,
    credentialLabel: '报名密码',
  });
});

Deno.test('contestWindow: 邀请赛要求邀请码，设密码公开赛要求报名密码', () => {
  assertEquals(contestRegistrationState({ ...base, kind: 'invite' }), {
    kind: 'register',
    needsCredential: true,
    credentialLabel: '邀请码',
  });
  assertEquals(contestRegistrationState({ ...base, hasPassword: true }), {
    kind: 'register',
    needsCredential: true,
    credentialLabel: '报名密码',
  });
});

Deno.test('contestWindow: 赛题可见性由开赛与报名决定，组织者始终可见', () => {
  assertEquals(contestProblemsState({ status: 'pending', isRegistered: true, canManage: false }), 'not-started');
  assertEquals(contestProblemsState({ status: 'running', isRegistered: false, canManage: false }), 'not-registered');
  assertEquals(contestProblemsState({ status: 'running', isRegistered: true, canManage: false }), 'visible');
  // 赛后对所有人开放赛题（复盘/补题），提交仍受受理窗口限制。
  assertEquals(contestProblemsState({ status: 'ended', isRegistered: true, canManage: false }), 'visible');
  assertEquals(contestProblemsState({ status: 'ended', isRegistered: false, canManage: false }), 'visible');
  assertEquals(contestProblemsState({ status: 'pending', isRegistered: false, canManage: true }), 'visible');
});

Deno.test('contestWindow: 倒计时按天/时分秒降级，过期归零', () => {
  const now = Date.parse('2026-10-27T00:00:00.000Z');
  assertEquals(contestCountdown('2026-10-27T00:00:05.000Z', now), { text: '00:00:05', expired: false });
  assertEquals(contestCountdown('2026-10-28T03:04:05.000Z', now), { text: '1 天 03:04:05', expired: false });
  assertEquals(contestCountdown('2026-10-26T00:00:00.000Z', now), { text: '00:00:00', expired: true });
  assertEquals(contestCountdown(null, now), { text: '--:--:--', expired: true });
  assertEquals(contestCountdown('not-a-date', now), { text: '--:--:--', expired: true });
});

Deno.test('contestWindow: 比赛时长文案覆盖天/小时/分钟', () => {
  assertEquals(
    contestDurationText('2026-10-27T00:00:00.000Z', '2026-11-03T05:14:16.098Z'),
    '7 天 5 小时',
  );
  assertEquals(contestDurationText('2026-10-27T00:00:00.000Z', '2026-10-27T01:30:00.000Z'), '1 小时 30 分钟');
  assertEquals(contestDurationText('2026-10-27T00:00:00.000Z', '2026-10-27T00:01:30.000Z'), '1 分钟');
  assertEquals(contestDurationText('2026-10-27T00:00:00.000Z', '2026-10-26T00:00:00.000Z'), null);
  assertEquals(contestDurationText(null, '2026-10-27T00:00:00.000Z'), null);
});

Deno.test('contestWindow: 榜单可见性与赛制口径文案与后端取值一一对应', () => {
  assertEquals(rankingVisibilityText('hidden'), '赛时与赛后都不公开榜单，仅组织者可见');
  assertEquals(rankingVisibilityText('participants'), '仅参赛者（及组织者）可查看榜单');
  assertEquals(rankingVisibilityText('public'), '榜单对所有人公开');
  assertEquals(scoreboardScopeText('kaggle', 'self'), '实时只显示本人成绩，赛后查看完整榜单');
  assertEquals(scoreboardScopeText('kaggle', 'full'), '实时显示全体选手分数');
  assertEquals(scoreboardScopeText('oi'), '赛时隐藏成绩与判定，赛后统一公布');
  assertEquals(scoreboardScopeText('acm'), '实时榜单，封榜期间不显示封榜后的判定');
  assertEquals(scoreboardScopeText('ioi'), '实时显示判定的公开部分');
});
