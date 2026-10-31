import { computed, type Ref } from 'vue';
import { useEventSource } from './useEventSource';

/**
 * 域比赛实时事件。
 *
 * ## 为什么要有这一层
 *
 * 后端早已提供 `/api/v1/domains/:slug/contests/:id/events`（带榜单快照、提交定位
 * 事件、`Last-Event-ID` 重放与撤权停推），但域页面此前**只**用轮询：榜单页同时跑
 * 2 秒 detail 与 5 秒 ranking 两条定时器，赛时 N 个观众就是 N 份周期性全量榜单查询。
 *
 * 这里把连接参数收敛到一处，三个页面（详情 / 榜单 / 赛题）共用：
 * - 首屏仍走 REST（SSR 可用），连接建立后由 `contest:ranking:snapshot` /
 *   `contest:ranking:updated` 替代周期性榜单请求；
 * - SSE 不可用时降级为轮询（`fallbackIntervalMs`），恢复后停止轮询；
 * - 离开页面、切换账号 / 域 / 比赛、切换班级筛选时关闭旧连接。
 *
 * ## 边界（不要扩大语义）
 *
 * 事件载荷是**按连接**即时计算的，服务端不共享榜单缓存；因此接线减少的是"没有变化
 * 时的重复查询"，不是把榜单计算变成全员共享。验收报告要分别记录静默期与高频变更期
 * 的查询量，不能宣称消除了按连接计算。
 */

/** 榜单事件载荷（与 REST `/ranking` 的字段面保持一致）。 */
export interface DomainContestRankingEvent {
  type: 'contest:ranking:snapshot' | 'contest:ranking:updated';
  contest_id: string;
  /** 全量榜单行（域入口即 REST 的 `data`） */
  data: DomainContestRankingRow[];
  view: 'live' | 'frozen' | 'official';
  ranking_visibility?: string;
  freeze_start_time?: string | null;
  freeze_end_time?: string | null;
  settlement_pending?: boolean;
  admin_live?: boolean;
  /** 关联班级；仅域入口下发 */
  classrooms?: { id: string; name: string }[];
  /** 关联班级学生（已按筛选重排名次） */
  classroom_rows?: DomainContestRankingRow[];
  /** 非关联班级的选手 */
  other_rows?: DomainContestRankingRow[];
  /** 建连时的班级筛选；null 表示未筛选 */
  classroom_id?: string | null;
}

/** 榜单行（只声明页面真正消费的字段，避免与 composable 类型耦合）。 */
export interface DomainContestRankingRow {
  user_id: string;
  username: string;
  rank: number;
  total_score: number;
  solved?: number;
  penalty_ms?: number;
  pending?: boolean;
  problem_scores: {
    label: string;
    best_score?: number | null;
    accepted?: boolean;
    attempts?: number;
    penalty_ms?: number;
    pending?: boolean;
  }[];
}

/** 提交定位事件：只有问题/时间/序号是公开的，身份字段仅组织者可见。 */
export interface DomainContestSubmissionEvent {
  type: 'contest:submission:created';
  contest_id: string;
  problem_id: string;
  created_at?: string;
  seq?: number;
  user_id?: string;
  submission_id?: string;
}

export interface UseDomainContestStreamOptions {
  slug: Ref<string | null | undefined>;
  contestId: Ref<string | null | undefined>;
  /** 当前账号 ID：切换账号必须重建连接 */
  viewerId: Ref<string | null | undefined>;
  /** 班级筛选；变化时重建连接（筛选在服务端建连时固定） */
  classroomId?: Ref<string | null | undefined>;
  /** 是否启用；默认 true。正式成绩视图应关闭实时事件。 */
  enabled?: Ref<boolean>;
  onRanking?: (payload: DomainContestRankingEvent) => void;
  onSubmission?: (payload: DomainContestSubmissionEvent) => void;
  /** SSE 不可用时的兜底刷新（应实现为**静默**刷新，不要置 loading） */
  fetchFn?: () => Promise<void>;
  /** 兜底轮询间隔；默认 5000（与后端 5 秒节流对齐） */
  fallbackIntervalMs?: number;
}

/**
 * 建立（或按需关闭）域比赛 SSE 连接。
 *
 * @returns `state` 连接状态、`connected` 便捷布尔
 */
export function useDomainContestStream(options: UseDomainContestStreamOptions) {
  const enabled = options.enabled ?? computed(() => true);
  const classroomId = options.classroomId ?? computed(() => null);

  /**
   * 连接 URL。
   *
   * 空串会让 `useEventSource` 停在 disabled 状态（它按 `enabled` + URL 决定是否
   * 连接），因此"尚未拿到 slug/比赛 ID"时不会去请求半截路径。
   */
  const url = computed(() => {
    const slug = options.slug.value, id = options.contestId.value;
    if (!slug || !id) return '';
    const query = classroomId.value ? `?classroom_id=${encodeURIComponent(classroomId.value)}` : '';
    return `/api/v1/domains/${encodeURIComponent(slug)}/contests/${encodeURIComponent(id)}/events${query}`;
  });

  /**
   * 作用域键：账号 + 域 + 比赛 + 班级。
   *
   * `useEventSource` 在该键变化时关闭旧连接再重连，等价于"切换身份/比赛/筛选立即
   * 断开旧的授权上下文"，不会让上一个账号的连接继续吃推送。
   */
  const scopeKey = computed(() =>
    [
      options.viewerId.value ?? 'anonymous',
      options.slug.value ?? '',
      options.contestId.value ?? '',
      classroomId.value ?? '',
    ].join(':')
  );

  const stream = useEventSource({
    url,
    enabled: computed(() => enabled.value && url.value !== '') as Ref<boolean>,
    scopeKey,
    onEvent: {
      'contest:ranking:snapshot': (payload) => options.onRanking?.(payload as DomainContestRankingEvent),
      'contest:ranking:updated': (payload) => options.onRanking?.(payload as DomainContestRankingEvent),
      'contest:submission:created': (payload) => options.onSubmission?.(payload as DomainContestSubmissionEvent),
    },
    fetchFn: options.fetchFn,
    fallbackIntervalMs: options.fallbackIntervalMs ?? 5000,
  });

  return {
    /** 连接状态：connecting / connected / fallback / disabled */
    state: stream.state,
    /** SSE 是否已建立（此时页面不应再有周期性榜单请求） */
    connected: computed(() => stream.state.value === 'connected'),
    /** 是否处于降级轮询（此时只有一套轮询在跑） */
    fallback: computed(() => stream.state.value === 'fallback'),
  };
}
