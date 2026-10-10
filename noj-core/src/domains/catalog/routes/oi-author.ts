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
import { authorizeOiData, validateOiDataPath } from "../services/oi-data.ts";
import { updateProblem } from "../services/problems/problems-crud.ts";
import {
  draftRevisionRequired,
  getProblemDraft,
} from "../services/versioning/draft.ts";
import {
  listDraftOiFiles,
  loadOiDataFromDraft,
  saveOiDraft,
} from "../services/versioning/oi-draft.ts";
import { createProblem } from "../services/problems/problems.ts";
import type {
  CreateProblemInput,
  UpdateProblemInput,
} from "../types/problems.ts";
import { enforceProblemImportRateLimit } from "../../system/index.ts";

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
  const [draft, files] = await Promise.all([
    getProblemDraft(row.id, row),
    listDraftOiFiles(row.id),
  ]);
  return c.json({
    data: {
      // 草稿 revision 是唯一乐观锁（保存时必须原样回传）
      draft_revision: draft.revision,
      updated_at: draft.updated_at ?? row.updated_at,
      files,
    },
  });
});

router.get("/:id/file", async (c) => {
  const path = c.req.query("path");
  if (!path) throw new BadRequestError("缺少文件路径");
  validateOiDataPath(path);
  const { row } = await authorizeOiData(c, c.req.param("id"));
  const bytes = (await loadOiDataFromDraft(row.id))[path];
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
  const previous = reference ? await authorizeOiData(c, reference) : undefined;
  if (!reference) await assertPermission(c, "problem:create");
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
    /** 草稿乐观锁：`GET /:id/files` 下发的 `draft_revision`。 */
    draft_revision?: number;
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

  // 草稿 revision 是唯一乐观锁（Handbook §5.2 第 2 步）：迁移期老客户端只传
  // `updated_at` 时拒绝，不静默绑定新版草稿。
  if (reference && metadata.draft_revision == null) {
    throw draftRevisionRequired();
  }

  const wantsFiles = form.file !== undefined || form.data_files !== undefined ||
    Object.keys(metadata.changes ?? {}).length > 0 ||
    (metadata.removed ?? []).length > 0;

  // 逐文件内容：整包替换 → 删除 → 文本编辑 → 追加新文件（与既有语义一致）。
  let entries: Record<string, Uint8Array> | undefined;
  if (wantsFiles) {
    let files: Record<string, Uint8Array> = reference
      ? await loadOiDataFromDraft(previous!.row.id)
      : Object.create(null);
    if (form.file instanceof File) {
      files = Object.create(null);
      for (
        const [path, bytes] of Object.entries(
          (await archive(form.file)).entries,
        )
      ) {
        if (
          ["problem.json", "problem.yaml", "problem.md", "statement.md"]
            .includes(path)
        ) continue;
        files[path] = bytes;
      }
    }
    for (
      const path of [
        "problem.json",
        "problem.yaml",
        "problem.md",
        "statement.md",
      ]
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
    entries = files;
  }

  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 管理信息（难度、标签、可见性）与内容分离：内容进草稿，管理信息进题目行。
  const management = {
    difficulty: metadata.problem.difficulty,
    tag_ids: metadata.problem.tag_ids,
    visibility: metadata.problem.visibility,
  };
  const hasManagement = management.difficulty !== undefined ||
    management.tag_ids !== undefined || management.visibility !== undefined;

  let problemId: string;
  let expectedRevision: number | null | undefined = metadata.draft_revision ??
    null;
  if (reference) {
    problemId = previous!.row.id;
    if (hasManagement) {
      await updateProblem(problemId, management, userId, userRole, c);
    }
  } else {
    // 创建：先建身份与空草稿，再按草稿 revision 写入内容与文件引用。
    const created = await createProblem(
      { ...metadata.problem, judge_type: "oi" },
      userId,
      userRole,
      c,
    );
    problemId = created.id;
    expectedRevision = (await getProblemDraft(problemId)).revision;
  }

  const saved = await saveOiDraft(problemId, {
    runtime_config: metadata.problem.runtime_config,
    title: metadata.problem.title.trim(),
    description: metadata.problem.description,
    samples: metadata.problem.samples,
    expectedRevision,
    actorId: userId,
  }, entries);

  return c.json({
    data: {
      id: problemId,
      problem_id: problemId,
      draft_revision: saved.revision,
      files_changed: saved.files_changed,
    },
  });
});

export default router;
