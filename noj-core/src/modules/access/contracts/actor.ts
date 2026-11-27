/**
 * access 模块身份合同兼容入口（权威实现已迁入 `shared/access/actor.ts`）。
 */
export {
  guestActor,
  isSystemActor,
  isUserActor,
  requireUserActor,
  userActorFromAuthenticatedId,
} from "../../../shared/access/actor.ts";
export type {
  Actor,
  GuestActor,
  SystemActor,
  SystemPurpose,
  UserActor,
  UserId,
} from "../../../shared/access/actor.ts";
