/**
 * access 模块唯一的业务身份合同。
 *
 * Actor 不是角色。角色和成员能力必须在当前请求/事务中通过 access policy
 * 解析；它们不能由调用方传入字符串绕过授权。HTTP 适配层只能把已经验签的
 * 用户转换成 `UserActor`，不能从 body、query 或 header 选择 system purpose。
 */

/** 经过认证且非空的用户标识。 */
export type UserId = string & { readonly __nojUserId: unique symbol };

/** 匿名读取身份。 */
export type GuestActor = Readonly<{
  kind: "guest";
}>;

/** 普通用户写入身份；用户写用例必须接收此类型。 */
export type UserActor = Readonly<{
  kind: "user";
  userId: UserId;
}>;

/** 系统身份用途；构造器只在 runtime/application composition 中提供。 */
export type SystemPurpose =
  | "bootstrap"
  | "migration"
  | "background_task";

/** 明确声明用途的系统身份。 */
export type SystemActor = Readonly<{
  kind: "system";
  purpose: SystemPurpose;
}>;

export type Actor = GuestActor | UserActor | SystemActor;

const USER_ID_PATTERN = /[^\s]/;

/**
 * 把认证适配器已经确认的 ID 转换为 UserActor。
 *
 * 该函数不接受任意 actor object，也不从 HTTP 输入读取 kind/purpose；无效
 * ID 立即失败，避免空字符串或 root sentinel 伪装成当前用户。
 */
export function userActorFromAuthenticatedId(id: string): UserActor {
  if (typeof id !== "string" || !USER_ID_PATTERN.test(id)) {
    throw new TypeError("认证用户 ID 不能为空");
  }
  return {
    kind: "user",
    userId: id.trim() as UserId,
  };
}

/** 创建匿名读取身份。 */
export function guestActor(): GuestActor {
  return { kind: "guest" };
}

/** 类型守卫：普通用户身份。 */
export function isUserActor(actor: Actor | undefined): actor is UserActor {
  return actor?.kind === "user" && typeof actor.userId === "string" &&
    USER_ID_PATTERN.test(actor.userId);
}

/** 类型守卫：系统身份。 */
export function isSystemActor(
  actor: Actor | undefined,
): actor is SystemActor {
  return actor?.kind === "system";
}

/**
 * 读取需要用户身份的 ID；Guest/System 不会被静默转换成用户或 root。
 */
export function requireUserActor(actor: Actor): UserActor {
  if (!isUserActor(actor)) {
    throw new TypeError("此用例要求 UserActor");
  }
  return actor;
}
