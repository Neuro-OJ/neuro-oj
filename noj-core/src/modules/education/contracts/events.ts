/**
 * education 对外暴露的教学事实登记窄事务合同。
 *
 * 教学失效与重算依据（`education_outbox` + 教学事实 revision）归 education 所有。
 * problems、evaluations 等业务模块只能在**自己的业务事务**里调用本文件的函数
 * 登记事实，不能直接写 `education_outbox`，也不能自行决定教学投影的刷新节奏。
 *
 * 三个函数都：
 * - 第一个参数是真实 `DbTx`，不自开根事务、不读默认连接；
 * - 只登记"哪个域/学生/题目发生了变化"，不携带成绩（消费者从数据库读最新事实）；
 * - 携带必要的定位字段与 projection revision，供异步重算判断陈旧。
 *
 * 实现暂由 `shared/education-events.ts` 承载（P3.5 迁入本模块），这里只提供
 * 稳定的、必填事务的窄门面，避免调用方继续使用可选 executor 的旧入口。
 */
import type { DbTx } from "../../../shared/db/executor.ts";
import {
  type EducationEvent,
  recordEducationEvent,
} from "../../../shared/education-events.ts";

/** 题目内容或可见性变化：让引用该题的教学单元陈旧。 */
export interface ProblemChangeEvent {
  readonly domainId: string;
  readonly problemId: string;
  /** 可选的受影响学生；缺省表示整题（域内全员）。 */
  readonly userId?: string;
}

/** 公开发布新版本后，受影响绑定集合的教学事实登记结果。 */
export interface PublishedBindingChangesInput {
  readonly problemId: string;
  readonly versionId: string;
  readonly actorId: string | null;
  readonly now: string;
}

/**
 * 登记一条题目变化事实。
 *
 * 必须在业务事务内调用：题目写入与教学失效依据共同提交或回滚。
 */
export async function recordProblemChangeTx(
  tx: DbTx,
  event: ProblemChangeEvent,
): Promise<void> {
  await recordEducationEvent(tx, {
    domain_id: event.domainId,
    problem_id: event.problemId,
    ...(event.userId ? { user_id: event.userId } : {}),
    event_type: "problem.changed",
  });
}

/**
 * 登记一条提交/评测结果变化事实。
 *
 * 消费者按当前有效成绩与版本策略重算，因此事件只带定位，不带分数。
 */
export async function recordEvaluationChangeTx(
  tx: DbTx,
  event: {
    readonly domainId: string;
    readonly userId: string;
    readonly problemId: string;
    /** 竞赛提交可以延后到比赛结束再生效。 */
    readonly contestId?: string | null;
    readonly availableAt?: string;
  },
): Promise<void> {
  await recordEducationEvent(
    tx,
    {
      domain_id: event.domainId,
      user_id: event.userId,
      problem_id: event.problemId,
      event_type: "submission.changed",
      ...(event.contestId ? { payload: { contest_id: event.contestId } } : {}),
    },
    event.availableAt ? { availableAt: event.availableAt } : {},
  );
}

/**
 * 登记模块级变化（域进入/退出教学政策等）。
 *
 * 与题目变化分开，避免把"整个域"的失效写成一堆逐题事件。
 */
export async function recordModuleChangeTx(
  tx: DbTx,
  event: {
    readonly domainId: string;
    readonly detail?: Record<string, unknown>;
  },
): Promise<void> {
  await recordEducationEvent(tx, {
    domain_id: event.domainId,
    event_type: "module.changed",
    ...(event.detail ? { payload: event.detail } : {}),
  });
}

/** 通用事实登记入口；保留给尚未细分事件类型的迁移期调用方。 */
export async function recordEducationEventTx(
  tx: DbTx,
  event: EducationEvent,
  options: { availableAt?: string } = {},
): Promise<void> {
  await recordEducationEvent(tx, event, options);
}
