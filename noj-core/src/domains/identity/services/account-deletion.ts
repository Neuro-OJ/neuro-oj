/**
 * 身份域的账户注销适配器。
 *
 * 账户本地事实和事务边界由 modules/access/account.ts 持有；这里仅组装
 * 教育成员清理、头像/搜索提交后副作用和认证审计，供旧 identity 导出与
 * HTTP 路由逐步迁移。调用者必须传入已认证的 UserActor。
 */
import { getDb } from "../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "../../../shared/search-events.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { logAuthEvent } from "../../system/services/audit-log.ts";
import { deleteAvatarIfUnreferenced } from "./users/users-avatar.ts";
import {
  adminDeleteAccountCommand,
  deleteOwnAccountCommand,
} from "../../../modules/application/access.ts";
import { accessMemberRemovalBoundary } from "../../../modules/application/access-capabilities.ts";
import type { UserActor } from "../../../modules/access/contracts/actor.ts";
import type { AccountLifecycleBoundary } from "../../../modules/access/account.ts";

/**
 * application 统一使用的真实跨模块副作用边界。
 * 教育成员事实在同一 DbTx 内更新；对象存储、搜索通知在账户提交后执行。
 */
function accountLifecycleBoundary(): AccountLifecycleBoundary {
  return {
    ...accessMemberRemovalBoundary,
    afterCommit: async ({ userId, previousAvatarUrl }) => {
      if (previousAvatarUrl) {
        try {
          await deleteAvatarIfUnreferenced(
            getDb(),
            userId,
            previousAvatarUrl,
          );
        } catch {
          // 账户事实已提交；头像删除沿用原有幂等清理语义。
        }
      }
      await publishSearchIndexEvent("user", userId, "delete");
    },
  };
}

/** 用户通过本地密码确认后注销自己的账户。 */
export async function deleteOwnAccount(
  actor: UserActor,
  password: string,
  clientIp?: string,
): Promise<void> {
  if (!password) throw new BadRequestError("请输入当前密码");
  await deleteOwnAccountCommand(actor, password, {
    ...accountLifecycleBoundary(),
    meta: { ipAddress: clientIp },
  });
  await logAuthEvent(
    actor.userId,
    clientIp ?? "unknown",
    "auth.delete_account",
    {
      user_id: actor.userId,
    },
  );
}

/** 管理员注销指定用户；管理员身份必须由认证适配器显式传入。 */
export async function adminDeleteAccount(
  targetUserId: string,
  actor: UserActor,
): Promise<void> {
  await adminDeleteAccountCommand(actor, targetUserId, {
    ...accountLifecycleBoundary(),
  });
}
