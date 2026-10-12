/**
 * 题目访问判定的**取数 + 判定**入口：题目读路径与写路径共用的唯一调用点。
 *
 * 为什么要有这一层：`problem-access.ts` 的纯函数判定需要"公开赛保密事实"
 * （`secrecy`）才能生效，而该事实要查库。若让每个 handler/service 各自取数，
 * 迟早有调用点忘记取，规则就会出现"某条路径漏判"的破口。因此统一在此取数后判定，
 * 调用方只关心 `result.allowed`。
 *
 * 取数口径（contest 域 `loadPublicContestSecrecy`）：题目被关联到至少一场
 * `kind = 'public'` 且 `now < end_time` 的竞赛 ⇒ 对非 owner/管理员不可见，
 * 除非请求携带了**有效竞赛上下文**（`contestAccess.allowed`，即该用户是这场竞赛的
 * 参赛者、这道题属于这场竞赛、窗口为 running/ended）。竞赛结束后保密自动失效。
 *
 * **查询次数**：每次判定固定多一次 `contest_problems ⋈ contests` 的索引 join
 * （不为 owner/admin 走捷径，换取"调用点无法漏判"）。结果不做缓存，因此不引入
 * 进程内可变状态，符合多副本约束。
 */
import {
  type ProblemAccessContext,
  type ProblemAccessInput,
  type ProblemAccessResult,
  resolveProblemAccess,
} from "./problem-access.ts";
import {
  loadPublicContestSecrecy,
  type PublicContestSecrecyRef,
  verifyContestAccess,
} from "./../../contest/index.ts";

/** 判定结果 + 触发保密的公开赛列表（owner/管理员据此渲染保密提示）。 */
export type ProblemAccessEvaluation = {
  result: ProblemAccessResult;
  /** 关联的、尚未结束的公开赛；无关联为空数组 */
  secrecy: PublicContestSecrecyRef[];
};

/**
 * 判定查看者可否访问某题目（含公开赛保密）。
 *
 * @param problem 题目最小字段集（id / visibility / owner_id）。
 * @param ctx 查看者上下文；`secrecy` 由本函数自行取数，调用方不要传。
 * @returns 判定结果与触发保密的竞赛列表。
 */
export async function evaluateProblemAccess(
  problem: ProblemAccessInput,
  ctx: Omit<ProblemAccessContext, "secrecy">,
): Promise<ProblemAccessEvaluation> {
  const secrecy = await loadPublicContestSecrecy(problem.id);
  return {
    result: resolveProblemAccess(problem, {
      ...ctx,
      secrecy: { contestIds: secrecy.map((ref) => ref.contestId) },
    }),
    secrecy,
  };
}

/**
 * 便捷入口：可选携带请求里的 `?contest_id=` 竞赛上下文。
 *
 * 竞赛上下文校验收敛在本模块（catalog 服务层），路由层无需感知 contest 域——
 * 与 `GET /:id/questions` 委托 objective 域校验同一取向。
 *
 * @param problem 题目最小字段集。
 * @param ctx `contestId` 缺省/非法时按"无上下文"处理（保守：不因此放行）。
 * @returns 判定结果与触发保密的竞赛列表。
 */
export async function evaluateProblemAccessWithContestId(
  problem: ProblemAccessInput,
  ctx: {
    viewerId: string | null;
    isAdmin: boolean;
    contestId?: string | null;
  },
): Promise<ProblemAccessEvaluation> {
  const contestAccess = ctx.contestId
    ? await verifyContestAccess(ctx.viewerId, ctx.contestId, problem.id)
    : null;
  return await evaluateProblemAccess(problem, {
    viewerId: ctx.viewerId,
    isAdmin: ctx.isAdmin,
    contestAccess,
  });
}
