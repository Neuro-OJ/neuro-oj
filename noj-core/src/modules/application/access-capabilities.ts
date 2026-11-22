/**
 * access 写用例的生产组合能力。
 *
 * `modules/access` 只负责访问本地事实和事务不变量；跨模块事实由
 * application 在这里绑定到真实的教育/题目持久写入。HTTP 只能使用这些
 * 已组合的能力，不能用可选 callback 把必要副作用省略掉。
 */
import type { DbTx } from "../../shared/db/executor.ts";
import type { UserActor } from "../access/contracts/actor.ts";
import type { DomainChangeBoundary } from "../access/domains.ts";
import type { ClassroomInvitationBoundary } from "../access/invitations.ts";
import type { MemberRemovalBoundary } from "../access/members.ts";
import { retireDomainEducationMemberships } from "../education/services/account-lifecycle.ts";
import {
  assertClassroomInvitationIssuer,
  joinInvitedClassroom,
} from "../education/services/invitations.ts";
import { recordSourceDomainEducationChange } from "../problems/services/workspace/education-events.ts";

/** 成员移除必须同步结束相关班级任职，且与域成员事实共用同一 DbTx。 */
export const accessMemberRemovalBoundary: MemberRemovalBoundary = {
  onMemberRemovedTx: async (tx, domainId, userId) => {
    await retireDomainEducationMemberships(tx, domainId, userId);
  },
};

/** 访问策略/状态变化必须登记题目共享的失效事实。 */
export const accessDomainChangeBoundary: DomainChangeBoundary = {
  onAccessPolicyChangedTx: async (tx, domainId) => {
    await recordSourceDomainEducationChange(tx, domainId);
  },
};

/** 班级邀请的权限核验与教学成员写入必须复用同一个 DbTx。 */
export function accessClassroomInvitationBoundary(): ClassroomInvitationBoundary {
  return {
    assertIssuerTx: async (
      tx: DbTx,
      slug: string,
      classroomId: string,
      actor: UserActor,
    ) => {
      const classroom = await assertClassroomInvitationIssuer(
        slug,
        classroomId,
        actor.userId,
        tx,
      );
      return { classroomName: classroom.name };
    },
    joinTx: async (
      tx: DbTx,
      domainId: string,
      classroomId: string,
      actor: UserActor,
    ) => {
      await joinInvitedClassroom(tx, domainId, classroomId, actor.userId);
    },
  };
}
