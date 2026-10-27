/**
 * 比赛时间窗口与报名状态的纯逻辑（可在 `deno task test` 下直接断言）。
 *
 * 背景：域比赛详情页需要把「未登录 / 未报名 / 已报名 / 未开始 / 进行中 / 已结束」
 * 与「邀请赛 / 需要密码」这些条件收敛成**唯一一处**判定，避免模板里散落多层
 * `v-if` 造成状态遗漏（例如已结束仍显示报名按钮）。
 *
 * 本模块只做展示决策，**不承担任何权限判断**：能否报名、能否读取赛题、能否提交，
 * 一律以后端（`loadDomainContest` / `getDomainContestProblems`）为准。
 */

export type ContestPhase = 'pending' | 'running' | 'ended';
/** 比赛类型（公开/邀请）；命名避开 `useContests` 的同名导出，避免自动导入歧义。 */
export type ContestEntryKind = 'public' | 'invite';

/** 报名区应展示的状态。 */
export type RegistrationState =
  /** 未登录：引导登录后报名。 */
  | { kind: 'login' }
  /** 已结束：不再接受报名，仅可查看。 */
  | { kind: 'ended' }
  /** 已报名：展示参赛身份与进入赛题入口。 */
  | { kind: 'registered'; canEnter: boolean }
  /** 未报名：可自助报名；`needsCredential` 表示邀请赛/设密码，需要输入邀请码/密码。 */
  | { kind: 'register'; needsCredential: boolean; credentialLabel: string };

export interface RegistrationInput {
  isLoggedIn: boolean;
  isRegistered: boolean;
  status: ContestPhase;
  kind: ContestEntryKind;
  hasPassword: boolean;
  canManage: boolean;
}

/**
 * 报名区状态机。
 *
 * 组织者（`can_manage`）即使未报名也能进入赛题，但**仍不自动显示「已报名」**：
 * 报名是参赛行为，组织者是否参赛由自己的报名记录决定，页面不得替用户编造。
 */
export function contestRegistrationState(input: RegistrationInput): RegistrationState {
  if (input.status === 'ended') return { kind: 'ended' };
  if (!input.isLoggedIn) return { kind: 'login' };
  if (input.isRegistered) {
    // 已报名即可进入赛题页；未开赛时后端会拒绝读取，页面据 `problemsState` 说明原因。
    return { kind: 'registered', canEnter: true };
  }
  const needsCredential = input.kind === 'invite' || input.hasPassword;
  return {
    kind: 'register',
    needsCredential,
    credentialLabel: input.kind === 'invite' ? '邀请码' : '报名密码',
  };
}

/**
 * 赛题列表应展示的状态。
 *
 * 门控（与后端 `getDomainContestProblems` 一致）：
 * - 赛前（pending）：仅组织者可读，其他人显示"开赛后开放"；
 * - 赛中（running）：仅已报名参赛者（与组织者）可读；
 * - 赛后（ended）：**对本场比赛可见的所有人开放**，可复盘与补题。
 *
 * 是否可**提交**是另一套判定（受理窗口 + 报名），由答题面板的 `writable` 控制。
 */
export type ProblemsState = 'visible' | 'not-started' | 'not-registered';

export function contestProblemsState(input: {
  status: ContestPhase;
  isRegistered: boolean;
  canManage: boolean;
}): ProblemsState {
  if (input.canManage) return 'visible';
  if (input.status === 'pending') return 'not-started';
  if (input.status === 'ended') return 'visible';
  return input.isRegistered ? 'visible' : 'not-registered';
}

/** 毫秒差 → 倒计时文案；已过期返回全零文本并把 `expired` 置真。 */
export function contestCountdown(target: string | null | undefined, now: number): {
  text: string;
  expired: boolean;
} {
  if (!target) return { text: '--:--:--', expired: true };
  const end = Date.parse(target);
  if (!Number.isFinite(end)) return { text: '--:--:--', expired: true };
  const diff = Math.max(0, end - now);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  return { text: days > 0 ? `${days} 天 ${clock}` : clock, expired: diff === 0 };
}

/** 比赛时长文案（用于"共 X 天 Y 小时"的赛程说明）。 */
export function contestDurationText(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start || !end) return null;
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const minutes = Math.floor((to - from) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  return `${Math.max(1, rest)} 分钟`;
}

/** 榜单可见性的人话说明（与后端 `ranking_visibility` 语义一一对应）。 */
export function rankingVisibilityText(visibility: 'public' | 'participants' | 'hidden'): string {
  switch (visibility) {
    case 'hidden':
      return '赛时与赛后都不公开榜单，仅组织者可见';
    case 'participants':
      return '仅参赛者（及组织者）可查看榜单';
    default:
      return '榜单对所有人公开';
  }
}

/** 赛制判分口径说明（与 `DOMAIN_CONTEST_TYPES.description` 互补，聚焦"成绩怎么看"）。 */
export function scoreboardScopeText(type: string, scope?: 'self' | 'full'): string {
  if (type === 'kaggle') {
    return scope === 'full' ? '实时显示全体选手分数' : '实时只显示本人成绩，赛后查看完整榜单';
  }
  if (type === 'oi') return '赛时隐藏成绩与判定，赛后统一公布';
  if (type === 'acm') return '实时榜单，封榜期间不显示封榜后的判定';
  return '实时显示判定的公开部分';
}
