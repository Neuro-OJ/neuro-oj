/**
 * 轮播幻灯片服务（与公告解耦，2026-09-24）。
 *
 * - `listEnabledSlides()`：公开端，仅 `is_enabled`，按 `sort_order` 升序。
 * - `listAllSlides()`：管理端，含停用项。
 * - `createSlide()` / `updateSlide()` / `deleteSlide()` / `reorderSlides()`：管理 CRUD。
 *
 * 约定：
 * - `kind=image` 必须有 `image_storage_url`；`kind=text` 必须有非空 `title`。
 * - 全部写操作记录审计日志（carousel.create / update / delete / reorder）。
 */

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { carouselSlides } from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import {
  getStorageProvider,
  isStorageUrl,
  parseStorageUrl,
} from "./../index.ts";
import {
  IMAGE_MAGIC_MIME,
  type ImageFile,
  validateImageFile,
} from "./../../../shared/security/image-validation.ts";
import { logAudit } from "./audit-log.ts";

/** 轮播图片大小上限（5MB） */
export const MAX_CAROUSEL_IMAGE_SIZE = 5 * 1024 * 1024;

/** 幻灯片类型 */
export type CarouselKind = "image" | "text";

/** 幻灯片（对外结构） */
export interface CarouselSlide {
  id: string;
  kind: CarouselKind;
  image_storage_url: string | null;
  title: string | null;
  subtitle: string | null;
  gradient_key: string | null;
  link_url: string | null;
  sort_order: number;
  is_enabled: boolean;
}

/** 新建 / 更新入参 */
export interface CarouselSlideInput {
  kind: CarouselKind;
  image_storage_url?: string | null;
  title?: string | null;
  subtitle?: string | null;
  gradient_key?: string | null;
  link_url?: string | null;
  is_enabled?: boolean;
}

/** 允许的渐变预设键（与前端保持一致）。 */
const GRADIENT_KEYS = [
  "blue",
  "green",
  "purple",
  "sunset",
  "ocean",
  "slate",
] as const;

/**
 * 校验并规范化字段，非法抛 ValidationError（HTTP 400）。
 *
 * @param kind 幻灯片类型（已确定）
 * @param fields 待校验字段（可能与既有行合并后）
 */
function validateFields(
  kind: CarouselKind,
  fields: {
    image_storage_url?: string | null;
    title?: string | null;
    subtitle?: string | null;
    gradient_key?: string | null;
    link_url?: string | null;
  },
): {
  image_storage_url: string | null;
  title: string | null;
  subtitle: string | null;
  gradient_key: string | null;
  link_url: string | null;
} {
  const imageUrl = fields.image_storage_url?.trim() || null;
  const title = fields.title?.trim() || null;
  const subtitle = fields.subtitle?.trim() || null;
  const gradient = fields.gradient_key?.trim() || null;
  const linkUrl = fields.link_url?.trim() || null;

  if (kind === "image" && !imageUrl) {
    throw new ValidationError("kind=image 时必须提供 image_storage_url");
  }
  if (kind === "text" && !title) {
    throw new ValidationError("kind=text 时必须提供 title");
  }
  // text 型不应携带图片（避免脏数据）
  if (kind === "text" && imageUrl) {
    throw new ValidationError("kind=text 时不应提供 image_storage_url");
  }
  if (gradient && !(GRADIENT_KEYS as readonly string[]).includes(gradient)) {
    throw new ValidationError(`gradient_key 非法：${gradient}`);
  }
  if (linkUrl && !/^https?:\/\//i.test(linkUrl) && !linkUrl.startsWith("/")) {
    throw new ValidationError(
      "link_url 必须是 http(s) 绝对地址或以 / 开头的站内路径",
    );
  }
  return {
    image_storage_url: imageUrl,
    title,
    subtitle,
    gradient_key: gradient,
    link_url: linkUrl,
  };
}

/** 新建入参校验（kind 必填）。 */
function validateCreateInput(input: CarouselSlideInput) {
  if (input.kind !== "image" && input.kind !== "text") {
    throw new ValidationError("kind 必须为 image 或 text");
  }
  return validateFields(input.kind, input);
}

/** 公开端：仅启用项，按 sort_order 升序（同序按 created_at）。 */
export async function listEnabledSlides(): Promise<CarouselSlide[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(carouselSlides)
    .where(eq(carouselSlides.is_enabled, true))
    .orderBy(asc(carouselSlides.sort_order), asc(carouselSlides.created_at));
  return rows.map((r) => ({ ...r, kind: r.kind as CarouselKind }));
}

/** 管理端：全部幻灯片，按 sort_order 升序。 */
export async function listAllSlides(): Promise<CarouselSlide[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(carouselSlides)
    .orderBy(asc(carouselSlides.sort_order), asc(carouselSlides.created_at));
  return rows.map((r) => ({ ...r, kind: r.kind as CarouselKind }));
}

/**
 * 新建幻灯片（追加到末尾）。
 *
 * @returns 新幻灯片 id
 */
export async function createSlide(input: CarouselSlideInput): Promise<string> {
  const fields = validateCreateInput(input);
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // 追加到末尾：取当前最大 sort_order + 1
  const existing = await db
    .select({ sort_order: carouselSlides.sort_order })
    .from(carouselSlides)
    .orderBy(asc(carouselSlides.sort_order));
  const nextOrder = existing.length === 0
    ? 0
    : Math.max(...existing.map((r) => r.sort_order)) + 1;

  await db.insert(carouselSlides).values({
    id,
    kind: input.kind,
    ...fields,
    sort_order: nextOrder,
    is_enabled: input.is_enabled ?? true,
    created_at: now,
    updated_at: now,
  });

  await logAudit(
    "carousel.create",
    { action: "carousel.create", kind: input.kind },
    { type: "carousel_slide", id },
  );
  return id;
}

/**
 * 更新幻灯片（**部分更新**语义；未提供字段沿用既有值，不改 sort_order）。
 *
 * @throws {NotFoundError} 幻灯片不存在
 */
export async function updateSlide(
  id: string,
  input: Partial<CarouselSlideInput>,
): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(carouselSlides)
    .where(eq(carouselSlides.id, id))
    .limit(1);
  if (!existing) throw new NotFoundError("幻灯片不存在");

  const kind = (input.kind ?? existing.kind) as CarouselKind;
  if (kind !== "image" && kind !== "text") {
    throw new ValidationError("kind 必须为 image 或 text");
  }
  // 部分更新语义：`undefined` = 未提供（沿用既有），`null` = 显式清空。
  // 切换 kind 时清掉不再适用的字段，避免脏数据。
  const pick = (v: string | null | undefined, fallback: string | null) =>
    v === undefined ? fallback : v;
  const isImage = kind === "image";
  const fields = validateFields(kind, {
    image_storage_url: isImage
      ? pick(input.image_storage_url, existing.image_storage_url)
      : (input.image_storage_url === undefined
        ? null
        : input.image_storage_url),
    title: pick(input.title, existing.title),
    subtitle: pick(input.subtitle, existing.subtitle),
    gradient_key: isImage
      ? (input.gradient_key === undefined ? null : input.gradient_key)
      : pick(input.gradient_key, existing.gradient_key),
    link_url: pick(input.link_url, existing.link_url),
  });

  await db
    .update(carouselSlides)
    .set({
      kind,
      ...fields,
      ...(input.is_enabled !== undefined
        ? { is_enabled: input.is_enabled }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .where(eq(carouselSlides.id, id));

  await logAudit(
    "carousel.update",
    { action: "carousel.update", kind },
    { type: "carousel_slide", id },
  );
}

/**
 * 读取轮播图片字节与元数据（供前端 `<img>` 展示；`noj-storage://` 不能直接作 src）。
 *
 * 2026-09-25 评审：公开端点只服务于**已启用**的 image 幻灯片——此前仅按 id 取图，
 * 停用后的图片仍可被任意人按 UUID 拉取，与"停用即公开端不可见"的语义不符。
 *
 * @param id 幻灯片 id
 * @returns 字节、Content-Type、ETag
 * @throws {NotFoundError} 幻灯片不存在、已停用/非图片，或无图片
 */
export async function getCarouselImageBytes(
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const db = getDb();
  const [row] = await db
    .select({ url: carouselSlides.image_storage_url })
    .from(carouselSlides)
    .where(
      and(
        eq(carouselSlides.id, id),
        eq(carouselSlides.is_enabled, true),
        eq(carouselSlides.kind, "image"),
      ),
    )
    .limit(1);
  const url = row?.url;
  if (!url) throw new NotFoundError("幻灯片无图片");
  // 非 storage URL（脏数据）→ 404，避免 provider 解析抛错导致 500
  if (!isStorageUrl(url)) throw new NotFoundError("幻灯片图片地址无效");

  const provider = await getStorageProvider();
  const bytes = await provider.get(url);
  const parsed = parseStorageUrl(url);
  const contentType = /\.png$/i.test(parsed.key)
    ? "image/png"
    : /\.webp$/i.test(parsed.key)
    ? "image/webp"
    : "image/jpeg";
  const etag = parsed.checksumSha256
    ? `"${parsed.checksumSha256}"`
    : `"${parsed.key}"`;
  return { bytes, contentType, etag };
}

/**
 * 上传轮播图片（复用 StorageProvider；类型/尺寸经 magic bytes 校验）。
 *
 * @param file multipart 上传的图片
 * @returns 存储 URL（`noj-storage://...`）
 * @throws {BadRequestError} 文件非法（类型/大小/magic 不符）
 */
export async function uploadCarouselImage(file: File): Promise<string> {
  let validated: ImageFile;
  try {
    validated = await validateImageFile(
      file,
      MAX_CAROUSEL_IMAGE_SIZE,
      "5MB",
    );
  } catch (err) {
    // 统一为 BadRequestError，避免 500
    throw new BadRequestError(
      err instanceof Error ? err.message : "轮播图片不合法",
    );
  }
  const { bytes, type } = validated;
  const ext = type === "png" ? "png" : type === "webp" ? "webp" : "jpg";
  const provider = await getStorageProvider();
  return await provider.put(
    `carousel/${crypto.randomUUID()}.${ext}`,
    bytes,
    IMAGE_MAGIC_MIME[type],
  );
}

/**
 * 删除幻灯片（同时清理其图片文件，尽力而为）。
 *
 * @throws {NotFoundError} 幻灯片不存在
 */
export async function deleteSlide(id: string): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(carouselSlides)
    .where(eq(carouselSlides.id, id))
    .limit(1);
  if (!existing) throw new NotFoundError("幻灯片不存在");

  await db.delete(carouselSlides).where(eq(carouselSlides.id, id));

  // 清理图片文件（尽力而为；失败不影响删除结果）。
  // local provider 内容寻址：字节相同的图片共享同一文件名/URL，直接删会破坏
  // 仍引用它的其他 slide。必须先确认无其他 slide 引用（对齐头像的引用计数）。
  if (existing.image_storage_url && isStorageUrl(existing.image_storage_url)) {
    try {
      const refs = await db
        .select({ id: carouselSlides.id })
        .from(carouselSlides)
        .where(eq(carouselSlides.image_storage_url, existing.image_storage_url))
        .limit(1);
      if (refs.length === 0) {
        const provider = await getStorageProvider();
        await provider.delete(existing.image_storage_url);
      }
    } catch {
      // 文件不存在或清理失败时静默
    }
  }

  await logAudit(
    "carousel.delete",
    { action: "carousel.delete", kind: existing.kind },
    { type: "carousel_slide", id },
  );
}

/**
 * 按给定 id 顺序重排全部幻灯片（sort_order = 数组下标）。
 *
 * @throws {ValidationError} ids 与实际集合不一致（缺漏/多余/重复）
 */
export async function reorderSlides(ids: string[]): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: carouselSlides.id })
    .from(carouselSlides);
  const actual = new Set(rows.map((r) => r.id));
  const given = new Set(ids);
  if (
    ids.length !== rows.length || given.size !== ids.length ||
    [...actual].some((x) => !given.has(x))
  ) {
    throw new ValidationError("重排 id 列表必须完整且不重复地覆盖全部幻灯片");
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(carouselSlides)
        .set({ sort_order: i, updated_at: now })
        .where(eq(carouselSlides.id, ids[i]!));
    }
  });

  await logAudit(
    "carousel.reorder",
    { action: "carousel.reorder", count: ids.length },
    { type: "carousel_slide", id: "reorder" },
  );
}
