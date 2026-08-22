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

export function apiPut(path: string, body: unknown, token?: string) {
  return api("PUT", path, { body, token });
}

export function apiPatch(path: string, body: unknown, token?: string) {
  return api("PATCH", path, { body, token });
}

export function apiDelete(path: string, token?: string) {
  return api("DELETE", path, { token });
}

export function apiGet(path: string, token?: string) {
  return api("GET", path, { token });
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
 * @param type 题目类型（默认 P，样例题均为 P 型）
 */
export async function getProblemIdByNumber(
  number: number,
  type = "P",
): Promise<string> {
  let token = await getAdminToken();
  let res = await apiGet(
    `/api/v1/problems?number=${number}&type=${type}&limit=1`,
    token,
  );
  // 并发 E2E 分组下 admin token 可能刚被其他进程刷新而短暂失效；
  // 重置缓存后重试一次。
  if (res.status === 401) {
    _adminToken = null;
    token = await getAdminToken();
    res = await apiGet(
      `/api/v1/problems?number=${number}&type=${type}&limit=1`,
      token,
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `获取题目 ${type}${number} 失败: ${res.status} ${
        JSON.stringify(res.body)
      }`,
    );
  }
  const items = (res.body as { data: { id: string }[] }).data;
  const problem = items.find((p) => p.id);
  if (!problem) {
    throw new Error(`题目 ${type}${number} 不存在（dev-setup 未导入？）`);
  }
  return problem.id;
}

/**
 * 检测 judge worker 是否可用（提交后数秒内状态推进）。
 *
 * 创建一个临时用户提交一次，若 2s 内状态从 pending 变为 judging/finished
 * 则判定 judge worker 正常工作。
 */
export async function isJudgeAvailable(): Promise<boolean> {
  try {
    const ts = Date.now().toString(36);
    const t = await registerUser(
      "judge_chk_" + ts,
      "judge_chk_" + ts + "@test.com",
      TEST_PASSWORD,
    );
    // 题目 id 为 UUID（统一题目包导入），须动态获取
    const problemId = await getProblemIdByNumber(1001);
    const id = await submitCode(t, problemId, "print(1)");
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE_URL}/api/v1/submissions/${id}`, {
      headers: { Authorization: "Bearer " + t },
    });
    const data = await res.json();
    const status = (data as { data?: { status?: string } })?.data?.status || "";
    return status === "judging" || status === "finished";
  } catch {
    return false;
  }
}

/**
 * 注册用户并返回 token。如果已存在则登录。
 */
export async function registerUser(
  username: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/register", {
    username,
    email,
    password,
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
export async function loginAndChangePassword(
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

/**
 * 提交代码并返回 submission ID。
 */
export async function submitCode(
  token: string,
  problemId: string,
  code: string,
  language = "python3",
): Promise<string> {
  const res = await apiPost(
    "/api/v1/submissions",
    { problem_id: problemId, language, code },
    token,
  );

  if (res.status !== 201) {
    throw new Error(
      `提交失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

/**
 * 轮询 submission 直到完成或超时。
 *
 * 默认阈值 90s（45 次 × 2s）：CI 上多组 E2E 并行提交真实评测时，
 * judge 队列排队 + 容器启动开销叠加，原 30s 阈值会误判为超时。
 * 超时错误会附带最后一次观测到的 status / HTTP 码，便于区分
 * 「评测排队未完成」与「接口异常」。
 */
export async function pollSubmission(
  token: string,
  submissionId: string,
  maxRetries = 45,
  intervalMs = 2000,
  allowErrorResult = false,
): Promise<{ status: string; verdict: string; score: number }> {
  // 记录最后一次观测状态，用于超时时给出可诊断的错误信息
  let lastStatus = "(未取得)";
  let lastHttpStatus = 0;

  for (let i = 0; i < maxRetries; i++) {
    const res = await apiGet(
      `/api/v1/submissions/${submissionId}`,
      token,
    );
    lastHttpStatus = res.status;

    if (res.status === 200) {
      const data = (res.body as { data: Record<string, unknown> }).data;
      const subStatus = data.status as string;
      lastStatus = subStatus;

      if (subStatus === "finished" || subStatus === "error") {
        // API 返回 data.result.status / data.result.score（见 getSubmission）
        const resultData = data.result as Record<string, unknown> | null;
        const verdict = (resultData?.status as string) || "Unknown";
        const score = (resultData?.score as number) || 0;

        if (subStatus === "error" && !allowErrorResult) {
          throw new Error(
            `Submission ${submissionId} 评测失败，verdict=${verdict}`,
          );
        }

        return { status: subStatus, verdict, score };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const timeoutMs = maxRetries * intervalMs;
  const detail = `status=${lastStatus}, HTTP=${lastHttpStatus}`;
  throw new Error(
    `Submission ${submissionId} 超时（${timeoutMs}ms 未完成），最后状态 ${detail}`,
  );
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
 */
export async function waitForServer(
  retries = 30,
  intervalMs = 2000,
): Promise<void> {
  console.log(`  → 等待 noj-core API 就绪 (${BASE_URL})...`);
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) {
        console.log(`  ✓ noj-core API 就绪 (${i + 1}/${retries})`);
        return;
      }
    } catch {
      // 未就绪，继续等待
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `noj-core API ${BASE_URL} 未就绪（重试 ${retries} 次）`,
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
