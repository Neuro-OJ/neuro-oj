/**
 * 域题目的 HTTP 契约客户端（CLI 内部共享）。
 *
 * 为什么单独一层（2026-11-02 rc/v0.11 审计 F3）：`problem push` 与恢复演练
 * 都曾各自拼 URL，演练还在调用**已删除**的无域 `POST /problems/import-bundle`
 * （真实 core 返回 404），而 825 个 CLI 单测因 mock 与契约脱节全部通过。
 * 现在两条链路共用这一层的路径常量与调用形状，路径只有一处定义。
 *
 * 所有路径都相对**已含 `/api/v1` 的基址**。
 */

/** 客户端依赖（测试注入 fake fetch）。 */
export interface DomainProblemClientDeps {
  /** core API 基址，必须已包含 `/api/v1`（如 `https://noj.example.com/api/v1`）。 */
  baseUrl: string;
  fetch: typeof fetch;
  /** 认证头（由调用方构造，客户端不读环境变量）。 */
  headers: () => HeadersInit;
  /** 工作空间 slug。 */
  domain: string;
}

/** CLI 侧错误：保留 HTTP 状态与业务码，便于给出可操作提示。 */
export class DomainProblemHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DomainProblemHttpError";
  }
}

/** 导入结果。 */
export interface ImportedBundle {
  problem_id: string;
  number: number;
  draft_revision: number;
}

/** 发布结果（服务端 `PublishProblemVersionResult`）。 */
export interface PublishedVersion {
  problem_id: string;
  version_id: string;
  version: number;
  draft_revision: number;
  unchanged: boolean;
}

function base(deps: DomainProblemClientDeps): string {
  return `${deps.baseUrl.replace(/\/+$/, "")}/domains/${deps.domain}/problems`;
}

async function failure(res: Response, action: string): Promise<never> {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string })?.code;
  } catch { /* 非 JSON 错误体：保留原文 */ }
  throw new DomainProblemHttpError(
    `${action}失败：HTTP ${res.status}${text ? `（${text}）` : ""}`,
    res.status,
    code,
  );
}

/** 导入题目包（同一工作空间内新建或按题号替换草稿）。 */
export async function importProblemBundle(
  deps: DomainProblemClientDeps,
  bundle: { name: string; data: Uint8Array },
): Promise<ImportedBundle> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bundle.data as BlobPart], { type: "application/zip" }),
    bundle.name,
  );
  const res = await deps.fetch(`${base(deps)}/import-bundle`, {
    method: "POST",
    headers: deps.headers(),
    body: form,
  });
  if (!res.ok) await failure(res, "导入题目包");
  const payload = await res.json() as {
    data?: { problem_id?: string; number?: number; draft_revision?: number };
  };
  const data = payload.data ?? {};
  if (
    typeof data.problem_id !== "string" || typeof data.number !== "number" ||
    typeof data.draft_revision !== "number"
  ) {
    throw new DomainProblemHttpError(
      "导入响应缺少 problem_id/number/draft_revision",
      res.status,
    );
  }
  return {
    problem_id: data.problem_id,
    number: data.number,
    draft_revision: data.draft_revision,
  };
}

/** 按草稿 revision 显式发布（旧 multipart `publish=true` 约定不再存在）。 */
export async function publishProblemVersion(
  deps: DomainProblemClientDeps,
  reference: string | number,
  draftRevision: number,
  changeNote: string,
): Promise<PublishedVersion> {
  const res = await deps.fetch(
    `${base(deps)}/${encodeURIComponent(String(reference))}/publish`,
    {
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(deps.headers())),
        "Content-Type": "application/json",
        "If-Match": String(draftRevision),
      },
      body: JSON.stringify({ change_note: changeNote }),
    },
  );
  if (!res.ok) await failure(res, "发布题目版本");
  const payload = await res.json() as Partial<PublishedVersion>;
  if (typeof payload.version_id !== "string") {
    throw new DomainProblemHttpError("发布响应缺少 version_id", res.status);
  }
  return {
    problem_id: payload.problem_id ?? "",
    version_id: payload.version_id,
    version: payload.version ?? 0,
    draft_revision: payload.draft_revision ?? draftRevision,
    unchanged: payload.unchanged === true,
  };
}

/** 读取题目列表（域入口）。 */
export async function listProblems(
  deps: DomainProblemClientDeps,
  query: { page?: number; limit?: number } = {},
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const params = new URLSearchParams({
    page: String(query.page ?? 1),
    limit: String(query.limit ?? 20),
  });
  const res = await deps.fetch(`${base(deps)}?${params}`, {
    headers: deps.headers(),
  });
  if (!res.ok) await failure(res, "读取题目列表");
  const payload = await res.json() as { items?: unknown[]; total?: number };
  return {
    items: Array.isArray(payload.items)
      ? payload.items as Array<Record<string, unknown>>
      : [],
    total: typeof payload.total === "number" ? payload.total : 0,
  };
}

/** 读取题目详情（域入口）。 */
export async function readProblem(
  deps: DomainProblemClientDeps,
  reference: string | number,
): Promise<Record<string, unknown>> {
  const res = await deps.fetch(
    `${base(deps)}/${encodeURIComponent(String(reference))}`,
    { headers: deps.headers() },
  );
  if (!res.ok) await failure(res, "读取题目详情");
  return await res.json() as Record<string, unknown>;
}

/** 下载支持包（经 core 代理，不暴露对象存储 URL）。 */
export async function downloadSupportPackage(
  deps: DomainProblemClientDeps,
  reference: string | number,
): Promise<Uint8Array> {
  const res = await deps.fetch(
    `${base(deps)}/${encodeURIComponent(String(reference))}/support-package`,
    { headers: deps.headers() },
  );
  if (!res.ok) await failure(res, "下载支持包");
  return new Uint8Array(await res.arrayBuffer());
}

/** 创建域内自测（`version_id` 必填：评测协议 v3 不允许静默绑定最新版）。 */
export async function createSelfTest(
  deps: DomainProblemClientDeps,
  reference: string | number,
  input: {
    language: string;
    code: string;
    file_name?: string;
    version_id: string;
  },
): Promise<{ id: string }> {
  const res = await deps.fetch(
    `${base(deps)}/${encodeURIComponent(String(reference))}/self-tests`,
    {
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(deps.headers())),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) await failure(res, "创建自测");
  const payload = await res.json() as { data?: { id?: string } };
  if (typeof payload.data?.id !== "string") {
    throw new DomainProblemHttpError("自测响应缺少 id", res.status);
  }
  return { id: payload.data.id };
}

/** 读取域内自测状态。 */
export async function getSelfTest(
  deps: DomainProblemClientDeps,
  id: string,
): Promise<Record<string, unknown>> {
  const res = await deps.fetch(
    `${deps.baseUrl.replace(/\/+$/, "")}/domains/${deps.domain}/self-tests/${
      encodeURIComponent(id)
    }`,
    { headers: deps.headers() },
  );
  if (!res.ok) await failure(res, "读取自测状态");
  const payload = await res.json() as { data?: Record<string, unknown> };
  return payload.data ?? {};
}
