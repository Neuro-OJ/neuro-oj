/**
 * @deprecated Judge 镜像白名单已归 `modules/platform`。
 * 旧测试/路由适配器保留无 actor 的调用形状；新 application 必须显式传入 UserActor。
 */
import type { UserActor } from "../../../modules/access/contracts/actor.ts";
import type {
  CreateJudgeImageInput,
  JudgeImageKind,
  JudgeImageResponse,
  UpdateJudgeImageInput,
} from "../../../modules/platform/types/judge-images.ts";
import {
  createJudgeImage as platformCreateJudgeImage,
  deleteJudgeImage as platformDeleteJudgeImage,
  listJudgeImages,
  listJudgeImagesByKind,
  updateJudgeImage as platformUpdateJudgeImage,
  validateJudgeImage,
  validateJudgeImageWithKind,
} from "../../../modules/platform/services/judge-images.ts";

const LEGACY_ACTOR: UserActor = {
  kind: "user",
  userId: "legacy-judge-image-compat" as UserActor["userId"],
};

export {
  listJudgeImages,
  listJudgeImagesByKind,
  validateJudgeImage,
  validateJudgeImageWithKind,
};

export async function createJudgeImage(
  input: CreateJudgeImageInput,
): Promise<JudgeImageResponse> {
  return await platformCreateJudgeImage(input, LEGACY_ACTOR);
}

export async function updateJudgeImage(
  id: string,
  input: UpdateJudgeImageInput,
): Promise<JudgeImageResponse> {
  return await platformUpdateJudgeImage(id, input, LEGACY_ACTOR);
}

export async function deleteJudgeImage(id: string): Promise<void> {
  return await platformDeleteJudgeImage(id, LEGACY_ACTOR);
}

export type {
  CreateJudgeImageInput,
  JudgeImageKind,
  JudgeImageResponse,
  UpdateJudgeImageInput,
};
