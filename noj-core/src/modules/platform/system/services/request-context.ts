/**
 * HTTP 请求观测上下文（issue #101）。
 *
 * access 业务用例必须显式接收 UserActor；此 ALS 只为旧审计/日志适配器
 * 保留 request scope 和客户端 IP。新代码不得从这里猜测授权身份。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { getClientIp } from "./rate-limit-env.ts";
import {
  type Actor,
  guestActor,
  isUserActor,
  type UserActor,
  userActorFromAuthenticatedId,
} from "../../../access/contracts/actor.ts";

export interface RequestContext {
  /** 已完成认证的用户身份；匿名观测上下文可为 GuestActor。 */
  actor?: Actor;
  /** 请求客户端 IP（X-Forwarded-For 优先） */
  actorIp: string;
  /** 请求 ID 仅用于日志关联，不参与授权。 */
  requestId?: string;
  /**
   * 旧审计适配字段。仅保留到审计调用方迁移完成，禁止作为权限输入。
   * 新业务代码应显式接收 UserActor。
   */
  actorId: string;
  /** @deprecated 仅旧日志兼容，禁止业务授权读取。 */
  actorRole?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 在指定 context 内运行 fn（adminMiddleware 内使用） */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 从 Hono Context 提取 actor 信息并注入 RequestContext 后运行 fn。
 */
export function withActorContext<T>(
  c: Context,
  fn: () => T,
): T {
  const actor = c.get("actor") as UserActor | undefined;
  const authenticatedActor = actor && isUserActor(actor)
    ? actor
    : userActorFromAuthenticatedId(c.get("userId"));
  return runWithContext(
    {
      actor: authenticatedActor,
      actorIp: getClientIp(c),
      actorId: authenticatedActor.userId,
      // 旧日志字段仅观测；授权不读取它。
      actorRole: c.get("userRole"),
    },
    fn,
  );
}

/** 取当前请求的 context；缺失抛错（程序 bug 保护） */
export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "RequestContext 未注入 — logAudit 仅允许在 admin 路由内调用",
    );
  }
  return ctx;
}

/**
 * 仅测试中使用：注入固定 context，service 层无需 Hono 中间件即可调用 logAudit。
 *
 * 注意：使用 enterWith() 而非 run() 以便无需回调即可持续作用（简化测试编写）。
 * 但上下文会跨异步边界持续，务必在测试 cleanup 中调用 leaveTestContext() 清理。
 */
export function enterTestContext(ctx: RequestContext): void {
  // 兼容尚未迁移的旧审计测试，但没有 actorId 时保持匿名观测上下文。
  const actor = ctx.actor ??
    (ctx.actorId ? userActorFromAuthenticatedId(ctx.actorId) : guestActor());
  storage.enterWith({ ...ctx, actor });
}

/** 清理测试中注入的 ALS 上下文（防止 enterWith 跨测试泄漏） */
export function leaveTestContext(): void {
  storage.enterWith(undefined as unknown as RequestContext);
}
