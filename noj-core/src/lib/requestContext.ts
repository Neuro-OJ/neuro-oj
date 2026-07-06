/**
 * AsyncLocalStorage 上下文（issue #101）。
 *
 * adminMiddleware 在请求作用域注入 RequestContext，
 * service 层通过 getRequestContext() 取用，避免污染函数签名。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** 当前用户 ID */
  actorId: string;
  /** 请求客户端 IP（X-Forwarded-For 优先） */
  actorIp: string;
  /** 当前用户角色 */
  actorRole: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 在指定 context 内运行 fn（adminMiddleware 内使用） */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
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
  storage.enterWith(ctx);
}

/** 清理测试中注入的 ALS 上下文（防止 enterWith 跨测试泄漏） */
export function leaveTestContext(): void {
  storage.enterWith(undefined as unknown as RequestContext);
}
