/**
 * `noj-cli problem push`：把题目包推送到线上平台建题。
 *
 * 调用平台的 `POST /api/v1/problems/import-bundle`（与网页「从题目包导入」同一端点，
 * 不带 problem_id = 新建题目），默认导入为草稿，`--publish` 时导入后立即发布。
 *
 * 认证：优先 `NOJ_TOKEN` 环境变量；未设置且处于交互终端时提示登录（密码不回显，
 * 支持两步验证）。令牌只在本次进程内使用，不落盘。服务器地址必须是 HTTPS
 * （本机回环地址除外），避免口令/令牌明文过网。
 */
import type { PromptIO } from "../tui/io.ts";
import { UsageError } from "../util/args.ts";

/** 推送所需的外部依赖（测试注入 fake）。 */
export interface PushDeps {
  fetch: typeof fetch;
  /** 交互输入；为 null 表示非交互（缺令牌时直接报错）。 */
  io: PromptIO | null;
  /** 环境变量中的令牌（`NOJ_TOKEN`）。 */
  envToken?: string;
}

/** 推送输入。 */
export interface PushInput {
  server: string;
  /** zip 字节与上传文件名（服务端只接受 .zip 后缀）。 */
  bundle: { name: string; data: Uint8Array };
  publish: boolean;
}

/** 平台返回的导入结果（仅用到的字段）。 */
export interface PushResult {
  id: string;
  display_id?: string;
  title?: string;
  published?: { version: number; unchanged?: boolean } | null;
  /** 编辑页地址（核对并发布）。 */
  edit_url: string;
}

/** 平台返回的错误（保留错误码，便于给出可操作提示）。 */
export class PushError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * 规范化服务器地址：去掉末尾斜杠；非 HTTPS 仅允许本机回环地址。
 *
 * @throws {UsageError} 地址非法或为非回环的 http://
 */
export function normalizeServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--server 不是合法的 URL：${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`--server 仅支持 http(s)，收到 ${url.protocol}`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UsageError(
      `--server 必须使用 HTTPS（${url.host} 不是本机地址；明文 HTTP 会泄露口令与令牌）`,
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** 从登录响应中取 JWT：直连 core 在响应体，经网页 Nitro 代理则只在 Set-Cookie。 */
export function extractLoginToken(
  body: unknown,
  setCookie: string | null,
): string | null {
  const fromBody = (body as { data?: { token?: unknown } } | null)?.data?.token;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  if (!setCookie) return null;
  // 多个 Set-Cookie 会被 Headers 以 ", " 拼接；按 cookie 名精确匹配
  const match = /(?:^|[;,]\s*)noj:token=([^;,\s]+)/.exec(setCookie);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** 解析平台错误响应体为 {@link PushError}。 */
async function toPushError(
  res: Response,
  fallback: string,
): Promise<PushError> {
  let message = `${fallback}（HTTP ${res.status}）`;
  let code: string | undefined;
  try {
    const body = await res.json() as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // 非 JSON（如网关错误页）：保留兜底文案
  }
  return new PushError(message, res.status, code);
}

/** 交互登录（支持两步验证）；返回 JWT。 */
async function interactiveLogin(
  server: string,
  deps: PushDeps,
): Promise<string> {
  const io = deps.io!;
  io.write(`登录 ${server}（也可设置 NOJ_TOKEN 环境变量跳过登录）\n`);
  const login = (await io.readLine("用户名或邮箱: ")).trim();
  const password = await io.readSecret("密码: ");
  if (!login || !password) throw new UsageError("用户名和密码不能为空");

  const attempt = (code?: string) =>
    deps.fetch(`${server}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, ...(code ? { code } : {}) }),
    });

  let res = await attempt();
  if (!res.ok) {
    const err = await toPushError(res, "登录失败");
    if (err.code !== "TFA_REQUIRED") throw err;
    const code = (await io.readLine("两步验证码: ")).trim();
    res = await attempt(code);
    if (!res.ok) throw await toPushError(res, "登录失败");
  }
  const token = extractLoginToken(
    await res.json().catch(() => null),
    res.headers.getSetCookie().join("; ") || null,
  );
  if (!token) throw new PushError("登录成功但未取得访问令牌，请改用 NOJ_TOKEN");
  return token;
}

/**
 * 推送题目包。
 *
 * @throws {PushError} 登录或导入失败（含平台错误码）
 * @throws {UsageError} 缺少令牌且无法交互、或服务器地址非法
 */
export async function pushBundle(
  input: PushInput,
  deps: PushDeps,
): Promise<PushResult> {
  const server = normalizeServer(input.server);
  let token = deps.envToken?.trim();
  if (!token) {
    if (!deps.io) {
      throw new UsageError(
        "缺少访问令牌：请设置 NOJ_TOKEN 环境变量，或在交互终端中运行以登录",
      );
    }
    token = await interactiveLogin(server, deps);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([input.bundle.data as BlobPart], { type: "application/zip" }),
    input.bundle.name,
  );
  if (input.publish) form.append("publish", "true");

  const res = await deps.fetch(`${server}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw await toPushError(res, "导入失败");

  // 平台返回完整题目资源（含题面、存储地址等）；只取出题人需要的字段
  const data =
    (await res.json() as { data: Omit<PushResult, "edit_url"> }).data;
  return {
    id: data.id,
    display_id: data.display_id,
    title: data.title,
    published: data.published
      ? { version: data.published.version, unchanged: data.published.unchanged }
      : null,
    edit_url: `${server}/problems/${data.display_id ?? data.id}/edit`,
  };
}

/** 失败时的补充提示（可操作的下一步）。 */
export function pushErrorHint(err: PushError): string | null {
  if (err.status === 401) {
    return "令牌无效或已过期：请重新登录，或更新 NOJ_TOKEN";
  }
  if (err.status === 428 || err.code === "DRAFT_REVISION_REQUIRED") {
    return "problem.json 中的 number 与已有题目重复：如需新建请删除 number；如需更新该题请在其编辑页上传支持包";
  }
  if (err.status === 403) {
    return "当前账号无权导入该类型题目（主题库 P 型题需要管理员）";
  }
  return null;
}
