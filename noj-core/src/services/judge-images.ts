import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { judgeImages } from "../db/schema.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  isImageInWhitelist,
  isValidJudgeImageKind,
  type JudgeImageKind,
} from "../types/problems.ts";
import type {
  CreateJudgeImageInput,
  JudgeImageResponse,
  UpdateJudgeImageInput,
} from "../types/problems.ts";

const VALID_MODES = ["exact", "all_versions"];

/**
 * 将数据库行转换为响应格式。
 */
function toResponse(
  row: typeof judgeImages.$inferSelect,
): JudgeImageResponse {
  return {
    id: row.id,
    image: row.image,
    mode: row.mode,
    kind: row.kind as JudgeImageKind,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 获取所有白名单条目。
 */
export async function listJudgeImages(): Promise<JudgeImageResponse[]> {
  const db = getDb();
  const rows = await db.select().from(judgeImages).orderBy(judgeImages.image);
  return rows.map(toResponse);
}

/**
 * 按 kind 过滤白名单条目（dual-container-judge §5）。
 */
export async function listJudgeImagesByKind(
  kind: JudgeImageKind,
): Promise<JudgeImageResponse[]> {
  const all = await listJudgeImages();
  return all.filter((img) => img.kind === kind);
}

/**
 * 新增白名单条目。
 *
 * @throws {ValidationError} mode / kind 非法
 */
export async function createJudgeImage(
  input: CreateJudgeImageInput,
): Promise<JudgeImageResponse> {
  if (!input.image?.trim()) {
    throw new ValidationError("镜像名不能为空");
  }
  if (!VALID_MODES.includes(input.mode)) {
    throw new ValidationError(
      `mode 仅允许 ${VALID_MODES.join("/")}，收到: ${input.mode}`,
    );
  }
  if (!isValidJudgeImageKind(input.kind)) {
    throw new ValidationError(
      `kind 仅允许 evaluator/solution，收到: ${input.kind}`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(judgeImages).values({
    id,
    image: input.image.trim(),
    mode: input.mode,
    kind: input.kind,
    description: input.description?.trim() ?? "",
    created_at: now,
    updated_at: now,
  });

  const [row] = await db
    .select()
    .from(judgeImages)
    .where(eq(judgeImages.id, id))
    .limit(1);

  return toResponse(row!);
}

/**
 * 更新白名单条目。
 *
 * @throws {NotFoundError} 条目不存在
 * @throws {ValidationError} mode / kind 非法
 */
export async function updateJudgeImage(
  id: string,
  input: UpdateJudgeImageInput,
): Promise<JudgeImageResponse> {
  const db = getDb();

  const existing = await db
    .select()
    .from(judgeImages)
    .where(eq(judgeImages.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("评测镜像白名单条目不存在");
  }

  if (input.mode && !VALID_MODES.includes(input.mode)) {
    throw new ValidationError(
      `mode 仅允许 ${VALID_MODES.join("/")}，收到: ${input.mode}`,
    );
  }
  if (input.kind !== undefined && !isValidJudgeImageKind(input.kind)) {
    throw new ValidationError(
      `kind 仅允许 evaluator/solution，收到: ${input.kind}`,
    );
  }

  const updates: Record<string, unknown> = {};
  if (input.image !== undefined) updates.image = input.image.trim();
  if (input.mode !== undefined) updates.mode = input.mode;
  if (input.kind !== undefined) updates.kind = input.kind;
  if (input.description !== undefined) {
    updates.description = input.description.trim();
  }
  updates.updated_at = new Date().toISOString();

  await db.update(judgeImages).set(updates).where(eq(judgeImages.id, id));

  const [row] = await db
    .select()
    .from(judgeImages)
    .where(eq(judgeImages.id, id))
    .limit(1);

  return toResponse(row!);
}

/**
 * 删除白名单条目。
 *
 * @throws {NotFoundError} 条目不存在
 */
export async function deleteJudgeImage(id: string): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(judgeImages)
    .where(eq(judgeImages.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("评测镜像白名单条目不存在");
  }

  await db.delete(judgeImages).where(eq(judgeImages.id, id));
}

/**
 * 校验 judge_image 是否在白名单中。
 *
 * @throws {ValidationError} 白名单为空或镜像不在白名单中时抛出，包含明确错误消息。
 */
export async function validateJudgeImage(image: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ image: judgeImages.image, mode: judgeImages.mode })
    .from(judgeImages);

  if (rows.length === 0) {
    throw new ValidationError(
      "系统尚未配置允许的评测镜像，请联系管理员",
    );
  }

  if (!isImageInWhitelist(image, rows)) {
    throw new ValidationError(
      `评测镜像 '${image}' 不在允许列表中`,
    );
  }

  return true;
}

/**
 * 校验 judge_image + kind 组合（dual-container-judge §5）。
 *
 * 用于 admin API 在创建/更新题目时校验 `runtime_config` 中的镜像：
 * - `runtime_config.evaluator.image` 必须 kind='evaluator'
 * - `runtime_config.solution.image` 必须 kind='solution'
 *
 * @throws {ValidationError} kind 不匹配或镜像不在白名单
 */
export async function validateJudgeImageWithKind(
  image: string,
  expectedKind: JudgeImageKind,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({
      image: judgeImages.image,
      mode: judgeImages.mode,
      kind: judgeImages.kind,
    })
    .from(judgeImages);

  if (rows.length === 0) {
    throw new ValidationError(
      "系统尚未配置允许的评测镜像，请联系管理员",
    );
  }

  // 1. 检查白名单
  if (!isImageInWhitelist(image, rows)) {
    throw new ValidationError(
      `评测镜像 '${image}' 不在允许列表中`,
    );
  }

  // 2. 检查 kind 匹配
  // 优先精确匹配（image 完全相等），再回退到 mode-based 匹配
  // 防止 all_versions 模式下，tagged 版本（如 noj-solution-python:3.12）
  // 被错误地匹配到无 tag 的引用（如 noj-solution-python）
  const exactMatch = rows.find((r) => r.image === image);
  const matched = exactMatch ?? rows.find((r) => isImageInWhitelist(image, [r]));
  if (!matched) {
    throw new ValidationError(
      `评测镜像 '${image}' 未匹配任何白名单条目`,
    );
  }
  if (matched.kind !== expectedKind) {
    throw new ValidationError(
      `image kind mismatch: 期望 ${expectedKind}，镜像 '${image}' 实际为 ${matched.kind}`,
    );
  }

  return true;
}
