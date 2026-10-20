/** @deprecated 轮播图能力已归 `modules/platform`；该文件只为旧 HTTP/测试路径提供适配。 */
import {
  type UserActor,
  userActorFromAuthenticatedId,
} from "../../../modules/access/contracts/actor.ts";
import { getRequestContext } from "./request-context.ts";
import {
  createSlide as createPlatformSlide,
  deleteSlide as deletePlatformSlide,
  reorderSlides as reorderPlatformSlides,
  updateSlide as updatePlatformSlide,
  uploadCarouselImage as uploadPlatformCarouselImage,
} from "../../../modules/platform/services/carousel.ts";
import type { ContentScope } from "../../../modules/platform/services/content-scope.ts";
import type { CarouselSlideInput } from "../../../modules/platform/services/carousel.ts";
import {
  getCarouselImageBytes,
  listAllSlides,
  listEnabledSlides,
} from "../../../modules/platform/services/carousel.ts";
export { MAX_CAROUSEL_IMAGE_SIZE } from "../../../modules/platform/services/carousel.ts";
export type {
  CarouselKind,
  CarouselSlide,
  CarouselSlideInput,
} from "../../../modules/platform/services/carousel.ts";
export type { ContentScope } from "../../../modules/platform/services/content-scope.ts";

function requestActor(): UserActor {
  try {
    const context = getRequestContext();
    return context.actor?.kind === "user"
      ? context.actor
      : userActorFromAuthenticatedId(context.actorId);
  } catch (error) {
    // 旧 service/test 路径允许脱离 HTTP context 直接调用；保留这个兼容
    // 入口，但不把 root 或默认操作者伪装成当前用户。真实 HTTP 写入经过
    // withActorContext，始终使用已认证的 UserActor。
    if (
      error instanceof Error &&
      error.message.startsWith("RequestContext 未注入")
    ) {
      return userActorFromAuthenticatedId("legacy-carousel-compat");
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

export { getCarouselImageBytes, listAllSlides, listEnabledSlides };

export async function createSlide(
  input: CarouselSlideInput,
  scope?: ContentScope,
) {
  return await createPlatformSlide(
    input,
    requestActor(),
    scope,
    auditMeta(),
  );
}

export async function updateSlide(
  id: string,
  input: Partial<CarouselSlideInput>,
  scope?: ContentScope,
) {
  return await updatePlatformSlide(
    id,
    input,
    requestActor(),
    scope,
    auditMeta(),
  );
}

export async function uploadCarouselImage(
  file: File,
  scope?: ContentScope,
) {
  return await uploadPlatformCarouselImage(file, requestActor(), scope);
}

export async function deleteSlide(id: string, scope?: ContentScope) {
  return await deletePlatformSlide(
    id,
    requestActor(),
    scope,
    auditMeta(),
  );
}

export async function reorderSlides(ids: string[], scope?: ContentScope) {
  return await reorderPlatformSlides(
    ids,
    requestActor(),
    scope,
    auditMeta(),
  );
}
