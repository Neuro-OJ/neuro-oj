import { Hono } from "hono";
import {
  assertPermission,
  type AuthEnv,
  authMiddleware,
  checkPermission,
} from "../../identity/index.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { parseOiArchive } from "../services/oi-archive.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../services/support-package.ts";
import {
  authorizeOiData,
  loadOiData,
  type OiDataFile,
  saveOiData,
  saveOiMetadata,
  validateOiDataPath,
} from "../services/oi-data.ts";
import type {
  CreateProblemInput,
  UpdateProblemInput,
} from "../types/problems.ts";
import {
  enforceProblemImportRateLimit,
  getStorageProvider,
} from "../../system/index.ts";

const router = new Hono<AuthEnv>();
router.use("*", authMiddleware);

async function archive(file: unknown) {
  if (
    !(file instanceof File) || !file.name.toLowerCase().endsWith(".zip") ||
    file.size > MAX_SUPPORT_PACKAGE_SIZE
  ) {
    throw new BadRequestError("请上传不超过 128 MiB 的 ZIP 题目包");
  }
  return parseOiArchive(new Uint8Array(await file.arrayBuffer()));
}

function preview(path: string, bytes: Uint8Array) {
  if (bytes.length > 1024 * 1024) {
    return { path, size: bytes.length, text: null, truncated: true };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      path,
      size: bytes.length,
      text: text.includes("\0") ? null : text,
      truncated: false,
    };
  } catch {
    return { path, size: bytes.length, text: null, truncated: false };
  }
}

router.post("/preview", async (c) => {
  await enforceProblemImportRateLimit(c, c.get("userId"));
  const form = await c.req.parseBody();
  if (typeof form.problem_id === "string") {
    await authorizeOiData(c, form.problem_id);
  } else await assertPermission(c, "problem:create");
  const parsed = await archive(form.file);
  if (parsed.manifest.judge_type !== "oi") {
    throw new BadRequestError("需要 OI 题目包");
  }
  const path = typeof form.path === "string" ? form.path : undefined;
  if (path) {
    validateOiDataPath(path);
    const bytes = parsed.entries[path];
    if (!bytes) throw new NotFoundError("数据文件不存在");
    return c.json({ data: preview(path, bytes) });
  }
  return c.json({
    data: {
      manifest: parsed.manifest,
      description: parsed.statement ?? parsed.manifest.description,
      files: Object.entries(parsed.entries).filter(([name]) =>
        !name.endsWith("/")
      ).map(([path, bytes]) => ({ path, size: bytes.length })),
      warnings: [],
    },
  });
});

router.get("/:id/files", async (c) => {
  const { row } = await authorizeOiData(c, c.req.param("id"));
  const files = row.oi_data_files == null ? await loadOiData(c, row.id) : null;
  return c.json({
    data: {
      updated_at: row.updated_at,
      files: files
        ? Object.entries(files).map(([path, bytes]) => ({
          path,
          size: bytes.length,
        }))
        : Object.entries(row.oi_data_files!).map(([path, item]) => ({
          path,
          size: (item as OiDataFile).size,
        })),
    },
  });
});

router.get("/:id/file", async (c) => {
  const path = c.req.query("path");
  if (!path) throw new BadRequestError("缺少文件路径");
  validateOiDataPath(path);
  const { row } = await authorizeOiData(c, c.req.param("id"));
  const index = row.oi_data_files as
    | Record<string, OiDataFile>
    | null
    | undefined;
  const bytes = index == null
    ? (await loadOiData(c, row.id))[path]
    : index[path]
    ? await (await getStorageProvider()).get(
      index[path].storage_url,
    )
    : undefined;
  if (!bytes) throw new NotFoundError("文件不存在");
  if (c.req.query("download") === "1") {
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${
          encodeURIComponent(path.split("/").at(-1)!)
        }`,
      },
    });
  }
  return c.json({ data: preview(path, bytes) });
});

router.post("/:id/save", async (c) => {
  const reference = c.req.param("id") === "new" ? null : c.req.param("id");
  if (reference) await authorizeOiData(c, reference);
  else await assertPermission(c, "problem:create");
  await enforceProblemImportRateLimit(c, c.get("userId"));
  const form = await c.req.parseBody({ all: true });
  if (
    typeof form.metadata !== "string" || form.metadata.length > 4 * 1024 * 1024
  ) throw new BadRequestError("缺少合法编辑配置");
  let metadata: {
    problem: CreateProblemInput & UpdateProblemInput;
    changes?: Record<string, string>;
    removed?: string[];
    updated_at?: string;
    upload_paths?: string[];
  };
  try {
    metadata = JSON.parse(form.metadata);
  } catch {
    throw new BadRequestError("编辑配置不是有效 JSON");
  }
  if (
    !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
    !metadata.problem || typeof metadata.problem.title !== "string" ||
    !metadata.problem.title.trim() ||
    typeof metadata.problem.description !== "string"
  ) throw new BadRequestError("标题和题面不能为空");
  if (
    (metadata.changes !== undefined &&
      (!metadata.changes || typeof metadata.changes !== "object" ||
        Array.isArray(metadata.changes))) ||
    (metadata.removed !== undefined &&
      (!Array.isArray(metadata.removed) ||
        !metadata.removed.every((item) => typeof item === "string"))) ||
    (metadata.upload_paths !== undefined &&
      (!Array.isArray(metadata.upload_paths) ||
        !metadata.upload_paths.every((item) => typeof item === "string")))
  ) {
    throw new BadRequestError("文件变更配置非法");
  }
  if (
    metadata.problem.type === "P" &&
    !await checkPermission(c, "problem:create_p")
  ) await assertPermission(c, "problem:create_p");
  // 客户端不能向数据服务注入已有对象引用。
  delete metadata.problem.oi_data_files;
  delete metadata.problem.support_package_storage_url;
  if (
    reference && form.file === undefined && form.data_files === undefined &&
    Object.keys(metadata.changes ?? {}).length === 0 &&
    (metadata.removed ?? []).length === 0
  ) {
    return c.json({
      data: await saveOiMetadata(
        c,
        reference,
        metadata.problem,
        metadata.updated_at,
      ),
    });
  }
  const files = form.file instanceof File
    ? (await archive(form.file)).entries
    : reference
    ? await loadOiData(c, reference)
    : Object.create(null);
  for (
    const path of ["problem.json", "problem.yaml", "problem.md", "statement.md"]
  ) delete files[path];
  for (const path of metadata.removed ?? []) {
    validateOiDataPath(path);
    delete files[path];
  }
  for (const [path, text] of Object.entries(metadata.changes ?? {})) {
    validateOiDataPath(path);
    if (typeof text !== "string") {
      throw new BadRequestError("编辑内容必须是文本");
    }
    files[path] = new TextEncoder().encode(text);
  }
  const added = form.data_files;
  let uploadIndex = 0;
  for (
    const file of added === undefined
      ? []
      : Array.isArray(added)
      ? added
      : [added]
  ) {
    if (!(file instanceof File) || file.size > 64 * 1024 * 1024) {
      throw new BadRequestError("数据文件超过 64 MiB 或格式非法");
    }
    const path = metadata.upload_paths?.[uploadIndex++] ?? file.name;
    if (typeof path !== "string") throw new BadRequestError("上传路径非法");
    validateOiDataPath(path);
    files[path] = new Uint8Array(await file.arrayBuffer());
  }
  return c.json({
    data: await saveOiData(
      c,
      reference,
      metadata.problem,
      files,
      metadata.updated_at,
    ),
  });
});

export default router;
