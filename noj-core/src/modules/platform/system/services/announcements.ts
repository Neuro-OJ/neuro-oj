/** @deprecated 公告能力已归 `modules/platform`；该文件只为旧 HTTP/测试路径提供适配。 */
import {
  type UserActor,
  userActorFromAuthenticatedId,
} from "../../../access/contracts/actor.ts";
import { getRequestContext } from "./request-context.ts";
import {
  createAnnouncement as createPlatformAnnouncement,
  deleteAnnouncement as deletePlatformAnnouncement,
  updateAnnouncement as updatePlatformAnnouncement,
} from "../../services/announcements.ts";
import type { ContentScope } from "../../services/content-scope.ts";
import type {
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from "../../services/announcements.ts";
import {
  getLatestBannerAnnouncement,
  getPublicAnnouncement,
  listAdminAnnouncements,
  listPublicAnnouncements,
  resolveAnnouncementId,
} from "../../services/announcements.ts";
export type {
  AdminAnnouncementItem,
  AnnouncementBanner,
  AnnouncementDetail,
  AnnouncementSummary,
  CreateAnnouncementInput,
  PublicAnnouncementListResponse,
  UpdateAnnouncementInput,
} from "../../services/announcements.ts";
export type { ContentScope } from "../../services/content-scope.ts";

function requestActor(): UserActor {
  try {
    const context = getRequestContext();
    return context.actor?.kind === "user"
      ? context.actor
      : userActorFromAuthenticatedId(context.actorId);
  } catch (error) {
    // 旧 service/test 路径允许脱离 HTTP context 直接调用；这个兼容 actor
    // 只存在于旧适配层，真实 HTTP 写入仍由 withActorContext 提供身份。
    if (
      error instanceof Error &&
      error.message.startsWith("RequestContext 未注入")
    ) {
      return userActorFromAuthenticatedId("legacy-announcement-compat");
    }
    throw error;
  }
}

function auditMeta() {
  try {
    const context = getRequestContext();
    return { ipAddress: context.actorIp, requestId: context.requestId };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("RequestContext 未注入")
    ) {
      return { ipAddress: "unknown" };
    }
    throw error;
  }
}

export {
  getLatestBannerAnnouncement,
  getPublicAnnouncement,
  listAdminAnnouncements,
  listPublicAnnouncements,
  resolveAnnouncementId,
};

export async function createAnnouncement(
  input: CreateAnnouncementInput,
  scope?: ContentScope,
) {
  return await createPlatformAnnouncement(
    input,
    requestActor(),
    scope,
    auditMeta(),
  );
}

export async function updateAnnouncement(
  id: string,
  input: UpdateAnnouncementInput,
  scope?: ContentScope,
) {
  return await updatePlatformAnnouncement(
    id,
    input,
    requestActor(),
    scope,
    auditMeta(),
  );
}

export async function deleteAnnouncement(
  id: string,
  scope?: ContentScope,
) {
  return await deletePlatformAnnouncement(
    id,
    requestActor(),
    scope,
    auditMeta(),
  );
}
