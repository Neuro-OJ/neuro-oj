/**
 * noj-tests E2E 测试辅助函数。
 *
 * 提供 REST API 客户端、用户注册/提交辅助。
 *
 * 容器生命周期由 .github/workflows/e2e.yml 或 scripts/e2e/setup.sh 管理，测试本身不自动启停。
 *
 * 环境变量：
 *   NOJ_RUN_E2E       - 设为 "1" 时启用 E2E 测试
 *   E2E_NO_CLEANUP    - 设为 "1" 时不自动清理容器（调试用）
 *   E2E_BASE_URL      - noj-core 服务地址（默认 http://localhost:8099）
 */

import { measurePhase } from "../../scripts/lib/test-timing.ts";
import { WaitHttpError, waitUntil } from "../fixtures/wait.ts";

// ── 配置 ──────────────────────────────────────────

export const isE2E = Deno.env.get("NOJ_RUN_E2E") === "1";
export const BASE_URL = Deno.env.get("E2E_BASE_URL") || "http://localhost:8099";

// ── API 客户端 ────────────────────────────────────

async function request(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
    /** 轮询读取传入的取消信号（单次请求超时/外部取消）。 */
    signal?: AbortSignal;
  },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };

  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: options?.signal,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}

export async function api(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const result = await request(method, path, options);
  // E2E 并行分组下，admin token 可能刚被其他进程刷新而短暂失效；
  // 若本次请求使用的正是缓存的 admin token 且返回 401，重置后重试一次。
  if (
    result.status === 401 &&
    options?.token &&
    _adminToken &&
    options.token === _adminToken
  ) {
    _adminToken = null;
    const freshToken = await getAdminToken();
    return await request(method, path, { ...options, token: freshToken });
  }
  return result;
}

export function apiPost(path: string, body: unknown, token?: string) {
  return api("POST", path, { body, token });
}

export function apiPut(
  path: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
) {
  return api("PUT", path, { body, token, headers });
}

export function apiPatch(
  path: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
) {
  return api("PATCH", path, { body, token, headers });
}

export function apiDelete(
  path: string,
  token?: string,
  headers?: Record<string, string>,
) {
  return api("DELETE", path, { token, headers });
}

export function apiGet(path: string, token?: string) {
  return api("GET", path, { token });
}

/**
 * 等待批量任务进入终态（Handbook §4.3/§5.7）。
 *
 * 重测/升级任务受理后立即返回 202，真正的评测由后台 worker 异步派发：
 * 只轮询提交状态会在"上一条尝试的 finished 仍然可见"时提前返回，因此断言
 * 重测效果前必须等任务终态（completed / completed_with_errors）。
 */
export async function waitForJobCompleted(
  token: string,
  jobId: string,
  maxRetries = 60,
  intervalMs = 1000,
): Promise<{ status: string; total_items: number }> {
  // 旧签名是"重试次数 × 间隔"，转换为总预算；首次读取立即执行，不再固定 sleep。
  const timeoutMs = maxRetries * intervalMs;
  return await measurePhase("job wait", () =>
    waitUntil(
      async (signal) => {
        const res = await request(
          "GET",
          `/api/v1/admin/submission-jobs/${jobId}`,
          { token, signal },
        );
        if (res.status !== 200) {
          throw new WaitHttpError(
            res.status,
            `读取任务 ${jobId} 失败: ${res.status}`,
          );
        }
        return (res.body as {
          data: { status: string; total_items: number };
        }).data;
      },
      (data) =>
        data.status === "completed" ||
        data.status === "completed_with_errors",
      {
        timeoutMs,
        resourceId: `任务 ${jobId}`,
        describe: (data) => `status=${data.status}`,
      },
    ));
}

// ── 用户辅助 ──────────────────────────────────────

// ── Token 缓存 ──────────────────────────────────────

const adminCreds = {
  email: Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com",
  pass: Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass",
  newPass: "E2eAdminChangedPass1",
};

let _adminToken: string | null = null;

/**
 * 获取缓存的 admin token。
 * 首次调用执行完整的 loginAndChangePassword 流程（含强制改密），
 * 后续调用直接返回缓存 token，避免重复 bcrypt 哈希。
 */
export async function getAdminToken(): Promise<string> {
  if (_adminToken) return _adminToken;
  _adminToken = await loginAndChangePassword(
    adminCreds.email,
    adminCreds.pass,
    adminCreds.newPass,
  );
  return _adminToken;
}

const _userCache = new Map<string, { token: string; password: string }>();

/**
 * 获取或创建缓存用户。
 *
 * 首次以该 key 调用时注册用户，后续返回缓存的 token。
 * 避免同一逻辑用户被重复注册（每次注册都触发 bcrypt）。
 *
 * @param key   缓存键（如 "submissions_user"）
 * @param username 用户名
 * @param email    邮箱
 * @param password 密码（默认 TEST_PASSWORD）
 */
export async function getOrCreateUser(
  key: string,
  username: string,
  email: string,
  password = TEST_PASSWORD,
): Promise<{ token: string; password: string }> {
  const cached = _userCache.get(key);
  if (cached) return cached;

  const token = await registerUser(username, email, password);
  const entry = { token, password };
  _userCache.set(key, entry);
  return entry;
}

/**
 * 按题号获取样例题真实 id。
 *
 * problem-bundle-import 后题目 id 为服务端生成的 UUID（旧 seed 的数字 id
 * 兼容已不存在），E2E 测试须通过列表接口按 number 筛选拿到真实 UUID。
 *
 * @param number 题号（如 1001）
 */
export async function getProblemIdByNumber(
  number: number,
): Promise<string> {
  let token = await getAdminToken();
  let res = await apiGet(
    `/api/v1/problems?number=${number}&limit=1`,
    token,
  );
  // 并发 E2E 分组下 admin token 可能刚被其他进程刷新而短暂失效；
  // 重置缓存后重试一次。
  if (res.status === 401) {
    _adminToken = null;
    token = await getAdminToken();
    res = await apiGet(
      `/api/v1/problems?number=${number}&limit=1`,
      token,
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `获取默认域题目 ${number} 失败: ${res.status} ${
        JSON.stringify(res.body)
      }`,
    );
  }
  const items = (res.body as { data: { id: string }[] }).data;
  const problem = items.find((p) => p.id);
  if (!problem) {
    throw new Error(`默认域题目 ${number} 不存在（dev-setup 未导入？）`);
  }
  return problem.id;
}

/**
 * Judge canary 证据（由统一启动器 `scripts/test-runner.ts` 在正式运行前生成）。
 *
 * 子测试不再各自提交探测任务：只读取运行清单里的 canary 记录，校验 runId 与
 * 提交/尝试 ID 后继续自己的真实评测断言。缺少证据或证据来自其他运行直接失败，
 * 避免"探测失败 → 直接 return → 显示通过"的历史问题。
 */
export interface JudgeCanaryEvidence {
  runId: string;
  submissionId: string;
  attemptId: string;
  result: string;
}

interface JudgeCanaryManifest {
  version?: number;
  runId?: string;
  canary?: {
    runId?: string;
    submissionId?: string;
    attemptId?: string;
    result?: string;
  } | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 校验运行清单中的 canary 证据。
 *
 * 拒绝伪造/串运行清单：清单 runId 必须等于期望 runId，canary.runId 必须与
 * 清单一致，提交与尝试 ID 必须是合法 UUID，结果必须是 finished。
 */
export function validateJudgeCanaryManifest(
  raw: unknown,
  expected: { runId: string; submissionId?: string },
): JudgeCanaryEvidence {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Judge canary 清单不是 JSON 对象");
  }
  const manifest = raw as JudgeCanaryManifest;
  if (manifest.version !== 1) {
    throw new Error(`Judge canary 清单版本不支持：${String(manifest.version)}`);
  }
  if (!expected.runId) throw new Error("缺少期望 runId，拒绝读取 canary 清单");
  if (manifest.runId !== expected.runId) {
    throw new Error(
      `Judge canary 清单 runId 不匹配：清单 ${
        manifest.runId ?? "(缺失)"
      }，期望 ${expected.runId}`,
    );
  }
  const canary = manifest.canary;
  if (!canary || typeof canary !== "object") {
    throw new Error(`运行 ${expected.runId} 没有 Judge canary 证据`);
  }
  if (canary.runId !== manifest.runId) {
    throw new Error(
      `Judge canary runId 与清单不一致：canary ${
        canary.runId ?? "(缺失)"
      }，清单 ${manifest.runId}`,
    );
  }
  if (!canary.submissionId || !UUID_PATTERN.test(canary.submissionId)) {
    throw new Error(
      `Judge canary 提交 ID 非法：${canary.submissionId ?? "(缺失)"}`,
    );
  }
  if (!canary.attemptId || !UUID_PATTERN.test(canary.attemptId)) {
    throw new Error(
      `Judge canary 尝试 ID 非法：${canary.attemptId ?? "(缺失)"}`,
    );
  }
  if (expected.submissionId && canary.submissionId !== expected.submissionId) {
    throw new Error(
      `Judge canary 提交 ID 不匹配：清单 ${canary.submissionId}，期望 ${expected.submissionId}`,
    );
  }
  if (canary.result !== "finished") {
    throw new Error(
      `Judge canary 结果不是完成的正常评测：${canary.result ?? "(缺失)"}`,
    );
  }
  return {
    runId: manifest.runId,
    submissionId: canary.submissionId,
    attemptId: canary.attemptId,
    result: canary.result,
  };
}

/**
 * 读取并校验启动器写出的运行清单（路径由 `NOJ_TEST_MANIFEST` 注入）。
 */
export async function readJudgeCanary(
  manifestPath?: string,
): Promise<JudgeCanaryEvidence> {
  const path = manifestPath ?? Deno.env.get("NOJ_TEST_MANIFEST");
  const runId = Deno.env.get("NOJ_TEST_RUN_ID");
  if (!path || !runId) {
    throw new Error(
      "缺少 NOJ_TEST_MANIFEST / NOJ_TEST_RUN_ID：请通过 scripts/test-runner.ts 运行 E2E",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    throw new Error(
      `读取 Judge canary 清单失败（${path}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return validateJudgeCanaryManifest(raw, { runId });
}

/** 读取 canary 并输出定位信息；缺少证据时抛错（正式运行不再静默跳过）。 */
export async function requireJudgeCanary(): Promise<JudgeCanaryEvidence> {
  const canary = await readJudgeCanary();
  console.log(
    `  → Judge canary 可用：submission=${
      canary.submissionId.slice(0, 8)
    } attempt=${canary.attemptId.slice(0, 8)}`,
  );
  return canary;
}

/**
 * 为题包构建阶段计时（P1 阶段归因）。
 *
 * 测试在构造 ZIP 时调用；未开启 `NOJ_TEST_PROFILE` 时直接执行，无额外开销。
 */
export function measureBundleBuild<T>(fn: () => Promise<T> | T): Promise<T> {
  return measurePhase("bundle build", async () => await fn());
}

/**
 * 注册用户、完成邮箱验证并返回 token。如果已存在则登录。
 *
 * E2E 栈会在注册响应中返回仅供隔离测试环境使用的一次性验证令牌；辅助函数
 * 随即调用公开验证端点，确保后续写操作与真实已验证账号走相同代码路径。
 */
async function registerUserAccount(
  username: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/register", {
    username,
    email,
    password,
    accepted_legal: true,
  });

  if (res.status !== 201) {
    // 可能已存在，尝试登录
    const loginRes = await apiPost("/api/v1/auth/login", {
      login: email,
      password,
    });
    if (loginRes.status === 200) {
      return (loginRes.body as { data: { token: string } }).data.token;
    }
    throw new Error(
      `注册失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  const registration = res.body as {
    data?: { email_verification_token?: string };
  };
  const verificationToken = registration.data?.email_verification_token;
  if (!verificationToken) {
    throw new Error("注册成功但 E2E 响应未返回邮箱验证令牌");
  }
  const verifyRes = await apiPost("/api/v1/auth/email/verify", {
    token: verificationToken,
  });
  if (verifyRes.status !== 200) {
    throw new Error(
      `注册成功但邮箱验证失败: ${verifyRes.status} ${
        JSON.stringify(verifyRes.body)
      }`,
    );
  }

  const loginRes = await apiPost("/api/v1/auth/login", {
    login: email,
    password,
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `注册成功但登录失败: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
    );
  }
  return (loginRes.body as { data: { token: string } }).data.token;
}

/** 注册（或复用已有账号）并完成邮箱验证；阶段计时归入账号准备。 */
export function registerUser(
  username: string,
  email: string,
  password: string,
): Promise<string> {
  return measurePhase(
    "account preparation",
    () => registerUserAccount(username, email, password),
  );
}

/**
 * 登录用户返回 token。
 */
export async function loginUser(
  login: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/login", { login, password });
  if (res.status !== 200) {
    throw new Error(
      `登录失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { token: string } }).data.token;
}

/**
 * 尝试登录，失败返回 null（不抛错）。供幂等 helper 使用。
 */
async function tryLogin(
  login: string,
  password: string,
): Promise<string | null> {
  const res = await apiPost("/api/v1/auth/login", { login, password });
  if (res.status !== 200) return null;
  return (res.body as { data: { token: string } }).data.token;
}

/**
 * 登录 admin 并完成强制改密，返回无 must_change_password flag 的 token
 * （评审修复 H2：E2E 必须走完整强制改密流程才能验证 403 守卫）。
 *
 * 幂等设计：E2E 各测试 setup 共享同一个 admin 账户，前序测试已把密码改为
 * newPassword。流程（整体包在最多 3 轮重试里）：
 *   1. 先用 newPassword 登录（如果成功 → 已经是无 flag 状态，直接返回）
 *   2. 失败 → 用 password 登录（拿 flag token）
 *   3. 调 change-password 完成改密
 *   4. 用 newPassword 重新登录拿到无 flag token
 *
 * 并发重试（2026-08 修复）：noj-tests 分 3 组并行时，多个进程同时执行
 * 本流程存在竞态窗口——另一进程可能恰好在本进程"试旧密码"与"改密"之间
 * 完成改密，导致旧密码失效（登录失败或 change-password 400）。任何一步
 * 因竞态失败都重试整轮：下轮先试 newPassword 直接收敛。
 *
 * @param login    登录标识（邮箱或用户名）
 * @param password 当前密码（seed 设置的 ADMIN_PASS）
 * @param newPassword 改密后的密码（所有测试统一目标）
 * @returns 无改密 flag 的 admin token
 */
async function loginAndChangePasswordFlow(
  login: string,
  password: string,
  newPassword: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 步骤 1：前序测试可能已改密。先用 newPassword 试登录拿无 flag token。
    const cleanToken = await tryLogin(login, newPassword);
    if (cleanToken) return cleanToken;

    // 步骤 2：用 password 登录拿 flag token。
    const flagToken = await tryLogin(login, password);
    if (!flagToken) {
      // 并发竞态窗口：另一进程已先完成改密（旧密码失效）。
      // 本轮重试（下轮步骤 1 会用 newPassword 登录收敛）。
      continue;
    }

    // 步骤 3：调 change-password 完成改密。
    // authMiddleware 在 must_change_password=true 状态下放行 /api/v1/auth/change-password。
    const changeRes = await apiPost(
      "/api/v1/auth/change-password",
      { old_password: password, new_password: newPassword },
      flagToken,
    );
    if (changeRes.status !== 200) {
      // 并发竞态窗口：另一进程已先完成改密（change-password 400）。
      // 本轮重试（下轮步骤 1 用 newPassword 登录收敛）。
      continue;
    }

    // 步骤 4：用 newPassword 重新登录拿到无 flag token。
    return await loginUser(login, newPassword);
  }

  // 3 轮重试后仍未收敛：admin 账户状态异常（既不是初始密码也不是改密后
  // 密码），或并发竞争持续存在。
  throw new Error(
    `loginAndChangePassword: ${login} 重试 3 轮后仍无法完成改密流程（既无法用初始密码登录，也无法用改密后密码登录）`,
  );
}

/** 登录并完成强制改密；阶段计时归入账号准备（含并发竞态重试）。 */
export function loginAndChangePassword(
  login: string,
  password: string,
  newPassword: string,
): Promise<string> {
  return measurePhase(
    "account preparation",
    () => loginAndChangePasswordFlow(login, password, newPassword),
  );
}

/**
 * 为题目把当前内容显式发布为版本，返回作答版本 ID（Handbook §4.1）。
 *
 * 版本化后**提交必须携带 `version_id`**：只创建不发布的题目没有作答版本，
 * 提交会被 409 拒绝。E2E 建题后应先调用本函数固定版本。
 */
/** 设置域题目状态（可见性/停用）：域端点要求 If-Match 草稿 revision。 */
export async function setProblemState(
  token: string,
  problemId: string,
  body: {
    disabled?: boolean;
    visibility?: "public" | "members";
    reason?: string;
  },
) {
  const path = await domainProblemPath(problemId, token);
  const reference = path.split("/").pop()!;
  // `/state` 的 If-Match 是**题库配置 revision**（绑定行），不是草稿 revision。
  const bindings = await apiGet(
    `/api/v1/domains/main/problem-bindings?keyword=${
      encodeURIComponent(reference)
    }&limit=100`,
    token,
  );
  // 绑定列表返回 `{page, limit, total, items: [...]}`，reference 是对象。
  const rows = (bindings.body as {
    items?: Array<{
      reference?: {
        number?: number;
        display_ref?: string;
        qualified_ref?: string;
      };
      revision: number;
    }>;
  }).items ?? [];
  const hit = rows.find((row) =>
    String(row.reference?.number ?? "") === reference ||
    row.reference?.display_ref === reference ||
    row.reference?.qualified_ref?.endsWith(`:${reference}`)
  );
  if (!hit) {
    throw new Error(
      `未找到题目 ${reference} 的域绑定（先发布再改状态）: ${
        JSON.stringify(bindings.body)
      }`,
    );
  }
  return await api("POST", `${path}/state`, {
    body: { disabled: false, reason: "e2e", ...body },
    token,
    headers: { "If-Match": String(hit.revision) },
  });
}

export async function publishProblemVersion(
  token: string,
  problemId: string,
  changeNote = "e2e",
): Promise<string> {
  // 0.11 起发布只在域入口：`POST /domains/:slug/problems/:reference/publish`
  const path = await domainProblemPath(problemId, token);
  const draft = await apiGet(`${path}/draft`, token);
  if (draft.status !== 200) {
    throw new Error(
      `读取草稿失败: ${draft.status} ${JSON.stringify(draft.body)}`,
    );
  }
  const draftBody = draft.body as {
    revision?: number;
    data?: { revision?: number };
  };
  const revision = draftBody.revision ?? draftBody.data?.revision;
  if (typeof revision !== "number") {
    throw new Error(`草稿未回传 revision: ${JSON.stringify(draft.body)}`);
  }

  const pub = await api("POST", `${path}/publish`, {
    body: { change_note: changeNote },
    token,
    headers: { "If-Match": String(revision) },
  });
  if (pub.status !== 200 && pub.status !== 201) {
    throw new Error(
      `发布版本失败: ${pub.status} ${JSON.stringify(pub.body)}`,
    );
  }
  const body = pub.body as {
    version_id?: string;
    data?: { version_id?: string };
  };
  const versionId = body.version_id ?? body.data?.version_id;
  if (!versionId) {
    throw new Error(`发布未回传 version_id: ${JSON.stringify(pub.body)}`);
  }
  return versionId;
}

/**
 * 读取题目默认作答版本 ID（`any` → 最新版 / `exact` → 要求版本）。
 */
export async function getAnswerVersionId(
  token: string,
  problemId: string,
): Promise<string | null> {
  const res = await apiGet(`/api/v1/problems/${problemId}`, token);
  if (res.status !== 200) {
    throw new Error(`读取题目失败: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return (res.body as { data: { version_id: string | null } }).data.version_id;
}

/** 读取竞赛固定作答版本；不使用题库默认版本，也不绕过公开赛保密规则。 */
export async function getContestAnswerVersionId(
  token: string,
  contestId: string,
  problemId: string,
): Promise<string> {
  const res = await apiGet(
    `/api/v1/domains/main/contests/${contestId}/problems`,
    token,
  );
  if (res.status !== 200) {
    throw new Error(
      `读取竞赛题目失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  const problem = (res.body as {
    data: { problem_id: string; version_id: string | null }[];
  }).data.find((item) => item.problem_id === problemId);
  if (!problem?.version_id) throw new Error("竞赛没有固定作答版本");
  return problem.version_id;
}

/** 域题目路径（0.11 起写操作只在域入口）：UUID → 题号。 */
export async function domainProblemPath(
  problemId: string,
  token?: string,
): Promise<string> {
  return `/api/v1/domains/main/problems/${await getProblemReference(
    problemId,
    token,
  )}`;
}

/** 题目 UUID → 本域题号（域提交入口只接受数字或 `domain:number`）。 */
export async function getProblemReference(
  problemId: string,
  token?: string,
): Promise<string> {
  const auth = token ?? await getAdminToken();
  // 未发布的域新题对匿名/普通用户 404：调用方没带 token 时用管理员身份再读一次。
  const res = await apiGet(`/api/v1/problems/${problemId}`, auth);
  if (res.status === 200) {
    const number = (res.body as { data: { number: number } }).data.number;
    return String(number);
  }
  // 无域详情只服务"已绑定默认域"的题目：未发布的域新题会 404，
  // 退回域草稿列表按 id 反查题号。
  const admin = auth;
  for (const page of [1, 2, 3, 4, 5]) {
    const list = await apiGet(
      `/api/v1/domains/main/problem-drafts?page=${page}&limit=100`,
      admin,
    );
    if (list.status !== 200) break;
    // 列表统一返回 `{page, limit, total, items: [...]}`。
    const payload = list.body as {
      items?: Array<{ id: string; number: number }>;
      data?: Array<{ id: string; number: number }>;
    };
    const rows = payload.items ?? payload.data ?? [];
    const hit = rows.find((row) => row.id === problemId);
    if (hit) return String(hit.number);
    if (rows.length < 100) break;
  }
  throw new Error(
    `读取题目 ${problemId} 的题号失败: ${res.status} ${
      JSON.stringify(res.body)
    }`,
  );
}

/**
 * 提交代码并返回 submission ID。
 *
 * `versionId` 缺省时自动读取题目**默认作答版本**（新客户端必须携带版本）。
 *
 * 0.11 起提交只走域入口 `/api/v1/domains/:slug/submissions`（无域 `POST /submissions`
 * 已删除）。题目以「题号」定位，因此这里把调用方传的 UUID 换成题号；非 main 域的题目
 * 需要显式传 `domainSlug`。
 */
export async function submitCode(
  token: string,
  problemId: string,
  code: string,
  language = "python3",
  versionId?: string | null,
  options: { domainSlug?: string; reference?: string } = {},
): Promise<string> {
  const version = versionId ?? await getAnswerVersionId(token, problemId);
  if (!version) {
    throw new Error(
      `题目 ${problemId} 尚未发布任何版本，无法提交（先调用 publishProblemVersion）`,
    );
  }
  const slug = options.domainSlug ?? "main";
  const reference = options.reference ??
    await getProblemReference(problemId, token);
  const res = await apiPost(
    `/api/v1/domains/${slug}/submissions`,
    { problem_ref: reference, language, code, version_id: version },
    token,
  );

  if (res.status !== 201) {
    throw new Error(
      `提交失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

/** 提交详情轮询结果；attempt 字段用于识别"旧 attempt 已结束、新重评测未完成"。 */
export interface SubmissionPollResult {
  status: string;
  verdict: string;
  score: number;
  /** 最近一次评测尝试 ID（提交绑定版本后必有）。 */
  attempt_id: string | null;
  /** 最近一次评测尝试状态（finished / error / queued / judging / superseded）。 */
  attempt_state: string | null;
}

interface SubmissionPollData {
  status?: string;
  result?: { status?: string; score?: number } | null;
  latest_attempt?: {
    attempt_id?: string;
    state?: string;
  } | null;
}

/**
 * 判断提交是否真正完成（而不是"旧 attempt 的 finished 仍然可见"）。
 *
 * 重评测会创建新的 attempt；提交状态在旧结果上可能仍是 finished，因此
 * 必须同时要求 latest_attempt 进入终态（finished / error）。error 提交本身
 * 已是终态（可能是 MQ 推送失败等平台错误），不再等 attempt，保持原有
 * `allowErrorResult` 语义。
 */
function submissionSettled(data: SubmissionPollData): boolean {
  const status = data.status;
  if (status === "error") return true;
  if (status !== "finished") return false;
  const latest = data.latest_attempt;
  if (!latest) return true;
  return latest.state === "finished" || latest.state === "error";
}

function describeSubmission(data: SubmissionPollData): string {
  const attempt = data.latest_attempt;
  return `status=${data.status ?? "(未知)"} attempt=${
    attempt
      ? `${attempt.state ?? "?"}/${attempt.attempt_id?.slice(0, 8) ?? "?"}`
      : "(无)"
  }`;
}

/**
 * 轮询 submission 直到完成或超时。
 *
 * 默认预算 90s（45 次 × 2s）：CI 上多组 E2E 并行提交真实评测时，
 * judge 队列排队 + 容器启动开销叠加，原 30s 阈值会误判为超时。
 * 超时错误会附带最后一次观测到的 status / attempt / HTTP 码与读取次数。
 *
 * 重评测保护：只有 latest_attempt 也进入终态才返回，避免旧 attempt 的
 * finished 让调用方提前成功；`allowErrorResult` 保留原有语义。
 */
export async function pollSubmission(
  token: string,
  submissionId: string,
  maxRetries = 45,
  intervalMs = 2000,
  allowErrorResult = false,
): Promise<SubmissionPollResult> {
  const timeoutMs = maxRetries * intervalMs;
  return await measurePhase("submission wait", async () => {
    const data = await waitUntil(
      async (signal) => {
        const res = await request(
          "GET",
          `/api/v1/submissions/${submissionId}`,
          { token, signal },
        );
        if (res.status !== 200) {
          throw new WaitHttpError(
            res.status,
            `读取提交 ${submissionId} 失败: ${res.status}`,
          );
        }
        return (res.body as { data: SubmissionPollData }).data;
      },
      submissionSettled,
      {
        timeoutMs,
        resourceId: `提交 ${submissionId}`,
        describe: describeSubmission,
      },
    );

    const subStatus = data.status as string;
    // API 返回 data.result.status / data.result.score（见 getSubmission）
    const verdict = data.result?.status || "Unknown";
    const score = data.result?.score || 0;
    const attemptId = data.latest_attempt?.attempt_id ?? null;
    const attemptState = data.latest_attempt?.state ?? null;

    if (subStatus === "error" && !allowErrorResult) {
      throw new Error(
        `Submission ${submissionId} 评测失败，verdict=${verdict}` +
          (attemptId ? `，attempt=${attemptId}` : ""),
      );
    }

    return {
      status: subStatus,
      verdict,
      score,
      attempt_id: attemptId,
      attempt_state: attemptState,
    };
  });
}

/**
 * E2E 测试统一密码（注册/登录用）。
 */
export const TEST_PASSWORD = "Test12345679";

/**
 * E2E 测试包装：统一处理非 E2E 环境的跳过标记与资源清理选项。
 *
 * 用法：
 * ```ts
 * e2eTest("用例名", async () => { ... });
 * ```
 * `extraIgnore` 为附加跳过条件（如 `!isS3Mode`）。
 */
export function e2eTest(
  name: string,
  fn: () => Promise<void> | void,
  extraIgnore = false,
): void {
  Deno.test({
    name,
    ignore: !isE2E || extraIgnore,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/**
 * 等待 noj-core API 就绪。
 *
 * 保留位置参数签名（重试次数 × 间隔 → 总预算）；首次请求立即发出，
 * 5xx/网络错误在预算内重试，404 等确定性错误直接失败。
 */
export async function waitForServer(
  retries = 30,
  intervalMs = 2000,
): Promise<void> {
  const timeoutMs = retries * intervalMs;
  console.log(`  → 等待 noj-core API 就绪 (${BASE_URL})...`);
  const started = performance.now();
  await measurePhase(
    "server wait",
    () =>
      waitUntil(
        async (signal) => {
          const res = await fetch(`${BASE_URL}/health`, { signal });
          if (!res.ok) {
            throw new WaitHttpError(
              res.status,
              `健康检查返回 ${res.status}`,
            );
          }
          return true;
        },
        (ready) => ready,
        { timeoutMs, resourceId: `noj-core API ${BASE_URL}` },
      ),
  );
  console.log(
    `  ✓ noj-core API 就绪（${Math.round(performance.now() - started)}ms）`,
  );
}

// ── 测试代码模板 ──────────────────────────────────

/**
 * 不同评测场景的代码模板。
 *
 * 对应 problem P1001（A+B Problem）：
 * - evaluate.py 通过 Solution SDK 调用 solve(input_str)
 * - 函数返回两个整数之和
 */
export const CODE_SAMPLES = {
  /** 正确实现：解析输入字符串并返回两个整数之和 */
  accepted: `def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)`,

  /** 错误实现：总是输出错误结果 */
  wrongAnswer: `def solve(_input_str: str) -> str:
    return "0"`,

  /** 死循环，触发 TLE */
  timeLimitExceeded: `def solve(_input_str: str) -> str:
    while True:
        pass`,

  /** 内存无限分配，触发 MLE */
  memoryLimitExceeded: `def solve(_input_str: str) -> str:
    import time
    data = []
    while True:
        data.append([0] * 10_000_000)
        time.sleep(0.1)`,

  /** 运行时错误：非零退出码 */
  runtimeError: `def solve(_input_str: str) -> str:
    raise RuntimeError("测试运行时异常")`,

  /** 语法错误 */
  syntaxError: `def solve(:  # 语法错误
    print("never")`,
};

/**
 * E2E 重试辅助：对已知偶发 flaky 的断言进行有限重试。
 *
 * @param fn 需要重试的异步断言函数
 * @param options.retries 最大重试次数（默认 2）
 * @param options.delayMs 重试间隔（默认 1000）
 */
export async function retryE2E(
  fn: () => Promise<void>,
  options: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const { retries = 2, delayMs = 1000 } = options;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
