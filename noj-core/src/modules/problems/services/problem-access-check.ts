/**
 * 默认域题目读取与作答统一检查 Domain、发布状态和当前比赛保护事实。
 * 同域受保护正文返回带比赛入口的 403；编辑者允许预览，普通作答仍受保护。
 * 不使用缓存，合法比赛上下文由服务端验证，比赛结束按当前时刻自动解除保护。
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { domainProblemBindings, problems } from "../../../shared/db/schema.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../../shared/workspace/types.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import {
  guestActor,
  userActorFromAuthenticatedId,
} from "../../access/contracts/actor.ts";
import {
  type ProblemAccessContext,
  type ProblemAccessInput,
  type ProblemAccessResult,
  resolveProblemAccess,
} from "./problem-access.ts";
import {
  loadPublicContestSecrecy,
  type PublicContestSecrecyRef,
} from "../../contests/contracts/read.ts";
import { verifyContestAccess } from "../../access/contest-policy.ts";
import { ForbiddenError } from "../../../shared/base/errors.ts";

/** 判定结果 + 触发保密的保密比赛列表（owner/管理员据此渲染保密提示）。 */
export type ProblemAccessEvaluation = {
  result: ProblemAccessResult;
  /** 关联的、尚未结束的保密比赛；无关联为空数组 */
  secrecy: PublicContestSecrecyRef[];
};

/**
 * 判定查看者可否访问某题目（含保密比赛保密）。
 *
 * @param problem 题目最小字段集（id / visibility / owner_id）。
 * @param ctx 查看者上下文；`secrecy` 由本函数自行取数，调用方不要传。
 * @returns 判定结果与触发保密的竞赛列表。
 */
export async function evaluateProblemAccess(
  problem: ProblemAccessInput,
  ctx: Omit<ProblemAccessContext, "secrecy"> & { purpose?: "read" | "write" },
  executor: Executor = getDb(),
): Promise<ProblemAccessEvaluation> {
  const db = executor;
  const [source] = await db.select({
    domain_id: problems.domain_id,
    owner_id: problems.owner_id,
    latest_version_id: problems.latest_version_id,
  }).from(problems).where(eq(problems.id, problem.id)).limit(1);
  if (
    !source ||
    source.domain_id !== null && source.domain_id !== DEFAULT_DOMAIN_ID
  ) return { result: { allowed: false, mode: "denied" }, secrecy: [] };
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, ctx.viewerId, {
    executor,
  });
  const [binding] = await db.select().from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.domain_id, DEFAULT_DOMAIN_ID),
      eq(domainProblemBindings.problem_id, problem.id),
    ),
  ).limit(1);
  if (binding?.disabled_at) {
    return { result: { allowed: false, mode: "denied" }, secrecy: [] };
  }
  const canReadOwn =
    workspace.context.domainPermissions.has("problem:write_own") &&
    source.owner_id === ctx.viewerId;
  const privileged = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any");
  if (!source.latest_version_id && !privileged && !canReadOwn) {
    return { result: { allowed: false, mode: "denied" }, secrecy: [] };
  }
  const visible = true;
  const secrecy = await loadPublicContestSecrecy(
    problem.id,
    executor,
    DEFAULT_DOMAIN_ID,
  );
  if (
    secrecy.length && !ctx.contestAccess?.allowed &&
    (ctx.purpose === "write" || !privileged && !canReadOwn)
  ) {
    throw new ForbiddenError(
      "此题受比赛保护，请从比赛入口作答",
      "CONTEST_PROBLEM_RESTRICTED",
      { contests: secrecy },
    );
  }
  return {
    result: resolveProblemAccess({
      ...problem,
      visibility: visible ? "public" : "private",
    }, {
      ...ctx,
      isAdmin: privileged,
      canReadOwn,
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
    ? await verifyContestAccess(
      ctx.viewerId ? userActorFromAuthenticatedId(ctx.viewerId) : guestActor(),
      ctx.contestId,
      problem.id,
    )
    : null;
  return await evaluateProblemAccess(problem, {
    viewerId: ctx.viewerId,
    isAdmin: ctx.isAdmin,
    contestAccess,
  });
}
