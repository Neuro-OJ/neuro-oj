/**
 * 模拟赛压测（--live）多虚拟用户独立认证池解析与账号准备模块。
 *
 * - `--users > 1` 时禁止静默复用单账号 Token，避免触发 `noj-judge` 的 `user_busy` 串行锁；
 * - 支持 `--user-tokens`、`--user-credentials-file` 与 `--auto-register`；
 * - 仅传管理员 Token 且 `--users > 1` 时，优先走公开注册/登录，受限时回退管理员开号 API；
 * - 未显式 `--allow-shared-user` 且无法凑齐独立账号时明确报错拒绝假多用户并发。
 */

import type {
  LoadTestConfig,
  UserCredentialEntry,
} from "./contest-load-types.ts";

export type SemaphoreRunner = <T>(
  fn: () => Promise<T>,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

export function createSemaphore(maxConcurrency: number): SemaphoreRunner {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let active = 0;
  const waiters: Array<() => void> = [];
  return async <T>(
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<T> => {
    const signal = opts?.signal;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError");
    }
    if (active >= limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = waiters.indexOf(wake);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        };
        waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

export function buildAuthHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function parseRetryAfterMs(
  raw: string | null,
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  if (raw !== null) {
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Math.max(0, Math.round(Number(trimmed) * 1000));
    }
    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs)) {
      return Math.max(0, parsedMs - Date.now());
    }
  }
  return Math.min(maxBackoffMs, baseBackoffMs * (2 ** attempt));
}

/** 为准备期鉴权/开号/入域/报名请求提供全局节流与 HTTP 429 退避重试包装。 */
export function createAuthRequestRunner(
  fetchImpl: typeof fetch,
  opts: {
    paceMs?: number;
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
  } = {},
): typeof fetch {
  const paceMs = Math.max(0, opts.paceMs ?? 0);
  const maxRetries = Math.max(0, opts.maxRetries ?? 6);
  const baseBackoffMs = Math.max(10, opts.baseBackoffMs ?? 500);
  const maxBackoffMs = Math.max(baseBackoffMs, opts.maxBackoffMs ?? 30_000);

  let nextSlotAt = 0;
  let cooldownUntil = 0;

  const waitTurn = async (): Promise<void> => {
    const now = Date.now();
    const target = Math.max(now, nextSlotAt, cooldownUntil);
    if (paceMs > 0) {
      nextSlotAt = target + paceMs;
    }
    const waitMs = target - now;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    for (let attempt = 0;; attempt++) {
      await waitTurn();
      const res = await fetchImpl(input, init);
      if (res.status !== 429 || attempt >= maxRetries) {
        return res;
      }
      const delayMs = parseRetryAfterMs(
        res.headers.get("retry-after"),
        attempt,
        baseBackoffMs,
        maxBackoffMs,
      );
      await res.body?.cancel();
      if (delayMs > 0) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delayMs);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  };
}

function extractEmailVerifiedState(
  record: Record<string, unknown> | null | undefined,
): boolean | null {
  if (!record || typeof record !== "object") return null;
  if (typeof record.email_verified === "boolean") return record.email_verified;
  if (typeof record.emailVerified === "boolean") return record.emailVerified;
  if (record.email_verified_at !== undefined) {
    return record.email_verified_at !== null && record.email_verified_at !== "";
  }
  return null;
}

async function probeEmailVerifiedViaMe(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/auth/me`, {
      headers: buildAuthHeaders(token),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.json() as {
      data?: Record<string, unknown>;
    } & Record<string, unknown>;
    return extractEmailVerifiedState(body.data ?? body);
  } catch {
    return null;
  }
}

/** 调用公开登录接口换取 JWT，同时返回是否需要强制改密与邮箱验证状态。 */
async function loginForToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  login: string,
  password: string,
): Promise<{
  token: string;
  mustChangePassword: boolean;
  emailVerified: boolean | null;
}> {
  const res = await fetchImpl(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `登录压测账号 ${login} 失败: HTTP ${res.status} ${txt.slice(0, 120)}`,
    );
  }
  const body = await res.json() as {
    token?: string;
    user?: Record<string, unknown>;
    data?: {
      token?: string;
      user?: Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  const token = body.data?.token ?? body.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`登录压测账号 ${login} 成功但响应缺少 token`);
  }
  const userObj = body.data?.user ?? body.user ?? body.data ?? body;
  return {
    token: token.trim(),
    mustChangePassword: body.data?.user?.must_change_password === true,
    emailVerified: extractEmailVerifiedState(userObj),
  };
}

/** 管理员开号生成的临时密码首次登录后必须通过 change-password 解除拦截。 */
async function completeForcedPasswordChange(
  fetchImpl: typeof fetch,
  baseUrl: string,
  tempToken: string,
  oldPassword: string,
  newPassword: string,
): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/api/v1/auth/change-password`, {
    method: "POST",
    headers: buildAuthHeaders(tempToken),
    body: JSON.stringify({
      old_password: oldPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `压测账号强制改密失败: HTTP ${res.status} ${txt.slice(0, 120)}`,
    );
  }
  const body = await res.json() as {
    token?: string;
    data?: { token?: string };
  };
  const nextToken = body.data?.token ?? body.token;
  if (typeof nextToken !== "string" || nextToken.trim() === "") {
    throw new Error("压测账号改密响应缺少新 token");
  }
  return nextToken.trim();
}

function makeProvisionAccountSpec(
  runNonce: string,
  seq: number,
): { username: string; email: string; password: string } {
  const suffix = `${runNonce}_${seq}`.replace(/[^a-zA-Z0-9_]/g, "");
  const username = `stress_${suffix}`.slice(0, 30);
  const email = `${username}@stress.noj.invalid`;
  const password = `StressPass!2026_${suffix}`;
  return { username, email, password };
}

/** 优先通过公开注册（含 E2E 邮箱验证令牌消费）与登录获取独立用户 Token。 */
async function provisionViaPublicRegister(
  fetchImpl: typeof fetch,
  baseUrl: string,
  spec: { username: string; email: string; password: string },
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const regRes = await fetchImpl(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: spec.username,
        email: spec.email,
        password: spec.password,
        accepted_legal: true,
      }),
    });
    if (!regRes.ok) {
      const txt = await regRes.text();
      return {
        ok: false,
        reason: `POST /api/v1/auth/register HTTP ${regRes.status} ${
          txt.slice(0, 100)
        }`,
      };
    }

    const regBody = await regRes.json() as {
      token?: string;
      data?: {
        token?: string;
        email_verification_token?: string;
      } & Record<string, unknown>;
    } & Record<string, unknown>;
    const regVerified = extractEmailVerifiedState(regBody.data ?? regBody);
    const verifyToken = regBody.data?.email_verification_token;
    let verifiedByToken = false;
    if (typeof verifyToken === "string" && verifyToken.trim() !== "") {
      const verifyRes = await fetchImpl(`${baseUrl}/api/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: verifyToken }),
      });
      if (!verifyRes.ok) {
        const txt = await verifyRes.text();
        return {
          ok: false,
          reason: `POST /api/v1/auth/email/verify HTTP ${verifyRes.status} ${
            txt.slice(0, 100)
          }`,
        };
      }
      await verifyRes.body?.cancel();
      verifiedByToken = true;
    } else if (regVerified === false) {
      return {
        ok: false,
        reason:
          "公开注册未返回 email_verification_token 且账号邮箱未验证 (email_verified=false)",
      };
    }

    const directToken = regBody.data?.token ?? regBody.token;
    if (typeof directToken === "string" && directToken.trim() !== "") {
      const token = directToken.trim();
      if (verifiedByToken || regVerified === true) {
        return { ok: true, token };
      }
      const meVerified = await probeEmailVerifiedViaMe(
        fetchImpl,
        baseUrl,
        token,
      );
      if (meVerified === true) {
        return { ok: true, token };
      }
      return {
        ok: false,
        reason:
          "公开注册未返回 email_verification_token 且无法确认账号邮箱已验证",
      };
    }

    const loginResult = await loginForToken(
      fetchImpl,
      baseUrl,
      spec.username,
      spec.password,
    );
    if (verifiedByToken) {
      if (loginResult.emailVerified === false) {
        return {
          ok: false,
          reason: "消费邮箱验证令牌后登录仍返回 email_verified=false",
        };
      }
      return { ok: true, token: loginResult.token };
    }
    if (loginResult.emailVerified === true) {
      return { ok: true, token: loginResult.token };
    }
    if (loginResult.emailVerified === false) {
      return {
        ok: false,
        reason: "公开注册账号未完成邮箱验证 (email_verified=false)",
      };
    }
    const meVerified = await probeEmailVerifiedViaMe(
      fetchImpl,
      baseUrl,
      loginResult.token,
    );
    if (meVerified === true) {
      return { ok: true, token: loginResult.token };
    }
    return {
      ok: false,
      reason:
        "公开注册未返回 email_verification_token 且无法确认账号邮箱已验证",
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 公开注册受限时，通过管理员开号 API（批量导入或单建）创建独立账号并登录换取干净 JWT。 */
async function provisionViaAdminApi(
  fetchImpl: typeof fetch,
  baseUrl: string,
  adminToken: string,
  specs: Array<{ username: string; email: string; password: string }>,
): Promise<string[]> {
  if (specs.length === 0) return [];
  const createdCreds: Array<{ username: string; password: string }> = [];

  for (let offset = 0; offset < specs.length; offset += 500) {
    const chunk = specs.slice(offset, offset + 500);
    const importRes = await fetchImpl(
      `${baseUrl}/api/v1/admin/identity/users/import`,
      {
        method: "POST",
        headers: buildAuthHeaders(adminToken),
        body: JSON.stringify({ role: "user", users: chunk }),
      },
    );

    if (importRes.status === 404) {
      await importRes.body?.cancel();
      for (const spec of chunk) {
        const singleRes = await fetchImpl(
          `${baseUrl}/api/v1/admin/identity/users`,
          {
            method: "POST",
            headers: buildAuthHeaders(adminToken),
            body: JSON.stringify({ ...spec, role: "user" }),
          },
        );
        if (!singleRes.ok) {
          const txt = await singleRes.text();
          throw new Error(
            `管理员创建压测用户失败: HTTP ${singleRes.status} ${
              txt.slice(0, 120)
            }`,
          );
        }
        const singleBody = await singleRes.json() as {
          data?: { username?: string; password?: string };
        };
        createdCreds.push({
          username: singleBody.data?.username ?? spec.username,
          password: singleBody.data?.password ?? spec.password,
        });
      }
      continue;
    }

    if (!importRes.ok) {
      const txt = await importRes.text();
      throw new Error(
        `管理员批量开号失败: HTTP ${importRes.status} ${txt.slice(0, 120)}`,
      );
    }

    const body = await importRes.json() as {
      data?: Array<{ username?: string; password?: string }>;
    };
    const rows = Array.isArray(body.data) ? body.data : [];
    for (let i = 0; i < chunk.length; i++) {
      const row = rows[i];
      const spec = chunk[i]!;
      createdCreds.push({
        username: row?.username ?? spec.username,
        password: row?.password ?? spec.password,
      });
    }
  }

  const withLoginSlot = createSemaphore(8);
  return await Promise.all(
    createdCreds.map((cred, idx) =>
      withLoginSlot(async () => {
        const loginResult = await loginForToken(
          fetchImpl,
          baseUrl,
          cred.username,
          cred.password,
        );
        if (!loginResult.mustChangePassword) {
          return loginResult.token;
        }
        return await completeForcedPasswordChange(
          fetchImpl,
          baseUrl,
          loginResult.token,
          cred.password,
          `${cred.password}_Ready${idx}`,
        );
      })
    ),
  );
}

async function resolveCredentialEntries(
  entries: UserCredentialEntry[],
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<string[]> {
  const withLoginSlot = createSemaphore(8);
  return await Promise.all(
    entries.map((entry, idx) =>
      withLoginSlot(async () => {
        if (typeof entry.token === "string" && entry.token.trim() !== "") {
          return entry.token.trim();
        }
        if (
          typeof entry.login === "string" && entry.login.trim() !== "" &&
          typeof entry.password === "string" && entry.password !== ""
        ) {
          const { token, mustChangePassword } = await loginForToken(
            fetchImpl,
            baseUrl,
            entry.login.trim(),
            entry.password,
          );
          if (!mustChangePassword) return token;
          return await completeForcedPasswordChange(
            fetchImpl,
            baseUrl,
            token,
            entry.password,
            `${entry.password}_Ready${idx}`,
          );
        }
        throw new Error(
          `凭据池第 ${idx + 1} 项无效：必须提供 token 或 login + password`,
        );
      })
    ),
  );
}

/** 解析并校验多虚拟用户独立认证池。 */
export async function resolveLiveAuthPool(
  config: LoadTestConfig,
  fetchImpl: typeof fetch,
  baseUrl: string,
  runNonce: string,
  authRunner?: typeof fetch,
): Promise<{ controlToken: string; userTokens: string[] }> {
  const authFetch = authRunner ?? createAuthRequestRunner(fetchImpl, {
    paceMs: config.authPaceMs ?? (config.fetchFn ? 0 : 100),
    maxRetries: config.authMaxRetries ?? 6,
  });
  const usersCount = Math.max(1, config.users);
  const explicitAdminToken = config.adminToken?.trim() ||
    Deno.env.get("NOJ_STRESS_ADMIN_TOKEN")?.trim() || undefined;

  const explicitTokens: string[] = [];
  for (const raw of config.userTokens ?? []) {
    const trimmed = raw.trim();
    if (trimmed !== "") explicitTokens.push(trimmed);
  }

  const credentialEntries: UserCredentialEntry[] = [
    ...(config.userCredentials ?? []),
  ];
  if (config.userCredentialsFile) {
    const rawJson = await Deno.readTextFile(config.userCredentialsFile);
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(
        `--user-credentials-file (${config.userCredentialsFile}) 必须为 JSON 数组`,
      );
    }
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(
          `--user-credentials-file (${config.userCredentialsFile}) 元素必须为对象`,
        );
      }
      credentialEntries.push(item as UserCredentialEntry);
    }
  }

  if (credentialEntries.length > 0) {
    explicitTokens.push(
      ...(await resolveCredentialEntries(
        credentialEntries,
        authFetch,
        baseUrl,
      )),
    );
  }

  if (usersCount === 1) {
    if (explicitTokens.length >= 1) {
      return {
        controlToken: explicitAdminToken ?? explicitTokens[0]!,
        userTokens: [explicitTokens[0]!],
      };
    }
    if (config.autoRegister) {
      const spec = makeProvisionAccountSpec(runNonce, 0);
      const reg = await provisionViaPublicRegister(authFetch, baseUrl, spec);
      if (reg.ok) {
        return {
          controlToken: explicitAdminToken ?? reg.token,
          userTokens: [reg.token],
        };
      }
      if (explicitAdminToken) {
        const adminSpec = makeProvisionAccountSpec(`${runNonce}_adm`, 0);
        const [token] = await provisionViaAdminApi(
          authFetch,
          baseUrl,
          explicitAdminToken,
          [adminSpec],
        );
        return { controlToken: explicitAdminToken, userTokens: [token!] };
      }
      throw new Error(`自动注册单用户压测账号失败: ${reg.reason}`);
    }
    if (explicitAdminToken) {
      return {
        controlToken: explicitAdminToken,
        userTokens: [explicitAdminToken],
      };
    }
    throw new Error(
      "live 模式需要提供 --admin-token（或 NOJ_STRESS_ADMIN_TOKEN）、--user-tokens、--user-credentials-file 或启用 --auto-register",
    );
  }

  // usersCount > 1：必须使用独立账号，除非显式传了 --allow-shared-user
  if (explicitTokens.length >= usersCount) {
    const userTokens = explicitTokens.slice(0, usersCount);
    return {
      controlToken: explicitAdminToken ?? userTokens[0]!,
      userTokens,
    };
  }

  if (config.allowSharedUser) {
    const source = explicitTokens.length > 0
      ? explicitTokens
      : explicitAdminToken
      ? [explicitAdminToken]
      : [];
    if (source.length === 0) {
      throw new Error(
        "live 模式启用 --allow-shared-user 时仍需提供 --admin-token、--user-tokens 或 --user-credentials-file",
      );
    }
    const userTokens = Array.from(
      { length: usersCount },
      (_, idx) => source[idx % source.length]!,
    );
    return {
      controlToken: explicitAdminToken ?? userTokens[0]!,
      userTokens,
    };
  }

  if (explicitTokens.length > 0 && !config.autoRegister) {
    throw new Error(
      `--users=${usersCount} 需要至少 ${usersCount} 个独立用户 Token（当前仅提供 ${explicitTokens.length} 个）；拒绝假多用户并发，请补充 --user-tokens / --user-credentials-file、启用 --auto-register 或显式传入 --allow-shared-user`,
    );
  }

  if (!config.autoRegister && !explicitAdminToken) {
    throw new Error(
      "live 模式在 --users > 1 时需要提供 --user-tokens、--user-credentials-file、--auto-register 或 --admin-token",
    );
  }

  const needed = usersCount - explicitTokens.length;
  const specs = Array.from(
    { length: needed },
    (_, idx) => makeProvisionAccountSpec(runNonce, idx),
  );
  const provisioned: string[] = [];
  let firstPublicFailure: string | null = null;

  // 先探测首个账号的公开注册/邮箱验证/登录链路；不可用时快速切到管理员开号 API
  const probe = await provisionViaPublicRegister(
    authFetch,
    baseUrl,
    specs[0]!,
  );
  if (probe.ok) {
    provisioned.push(probe.token);
    const restSpecs = specs.slice(1);
    const withRegSlot = createSemaphore(8);
    const restResults = await Promise.all(
      restSpecs.map((spec) =>
        withRegSlot(() => provisionViaPublicRegister(authFetch, baseUrl, spec))
      ),
    );
    const failedSpecs: typeof specs = [];
    for (let i = 0; i < restResults.length; i++) {
      const r = restResults[i]!;
      if (r.ok) provisioned.push(r.token);
      else {
        firstPublicFailure ??= r.reason;
        failedSpecs.push(restSpecs[i]!);
      }
    }
    if (failedSpecs.length > 0) {
      if (explicitAdminToken) {
        const adminFallbackSpecs = failedSpecs.map((_, idx) =>
          makeProvisionAccountSpec(`${runNonce}_adm`, idx)
        );
        provisioned.push(
          ...(await provisionViaAdminApi(
            authFetch,
            baseUrl,
            explicitAdminToken,
            adminFallbackSpecs,
          )),
        );
      } else {
        throw new Error(
          `公开注册未能凑齐 ${usersCount} 个独立用户（仅成功 ${
            explicitTokens.length + provisioned.length
          } 个，失败原因: ${firstPublicFailure}）；拒绝假多用户并发`,
        );
      }
    }
  } else {
    firstPublicFailure = probe.reason;
    if (!explicitAdminToken) {
      throw new Error(
        `--users=${usersCount} 禁止假多用户并发，且公开注册不可用（${firstPublicFailure}）；请提供 --user-tokens / --user-credentials-file 或传入 --admin-token`,
      );
    }
    try {
      const adminSpecs = specs.map((_, idx) =>
        makeProvisionAccountSpec(`${runNonce}_adm`, idx)
      );
      provisioned.push(
        ...(await provisionViaAdminApi(
          authFetch,
          baseUrl,
          explicitAdminToken,
          adminSpecs,
        )),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `--users=${usersCount} 无法为每个虚拟用户获取独立 Token（公开注册: ${firstPublicFailure}；管理员开号: ${detail}）；拒绝假多用户并发，如需单账号压测请显式传入 --allow-shared-user`,
      );
    }
  }

  const allTokens = [...explicitTokens, ...provisioned];
  if (allTokens.length < usersCount) {
    throw new Error(
      `--users=${usersCount} 仅获取到 ${allTokens.length} 个独立用户 Token，拒绝假多用户并发`,
    );
  }
  const userTokens = allTokens.slice(0, usersCount);
  return {
    controlToken: explicitAdminToken ?? userTokens[0]!,
    userTokens,
  };
}

async function resolveCurrentUserId(
  authFetch: typeof fetch,
  baseUrl: string,
  userToken: string,
): Promise<string> {
  const res = await authFetch(`${baseUrl}/api/v1/auth/me`, {
    headers: buildAuthHeaders(userToken),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `读取压测用户身份失败: HTTP ${res.status} ${txt.slice(0, 120)}`,
    );
  }
  const body = await res.json() as {
    id?: string;
    user_id?: string;
    data?: { id?: string; user_id?: string };
  };
  const uid = body.data?.id ?? body.data?.user_id ?? body.id ?? body.user_id;
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("GET /api/v1/auth/me 响应缺少用户 id");
  }
  return uid.trim();
}

/**
 * 准备期确保所有压测账号：
 * 1. 已成为目标使用域成员（公开 `/join`、审批批准、域邀请兑换或 `/members` 兜底）；
 * 2. 若指定了 `contestId`，已完成竞赛报名（200/201/409 幂等放行）。
 */
export async function ensureLiveDomainAndContestAccess(opts: {
  authFetch: typeof fetch;
  baseUrl: string;
  domainSlug: string;
  contestId?: string;
  controlToken: string;
  userTokens: string[];
}): Promise<void> {
  const { authFetch, baseUrl, domainSlug, contestId, controlToken } = opts;
  const uniqueTokens = [...new Set(opts.userTokens.filter(Boolean))];
  if (uniqueTokens.length === 0) return;

  const encodedSlug = encodeURIComponent(domainSlug);
  const controlHeaders = buildAuthHeaders(controlToken);
  const withSlot = createSemaphore(8);

  const nonMembers: Array<{
    token: string;
    actorId?: string;
    joinPolicy?: string;
  }> = [];

  await Promise.all(
    uniqueTokens.map((token) =>
      withSlot(async () => {
        const res = await authFetch(
          `${baseUrl}/api/v1/domains/${encodedSlug}`,
          {
            headers: buildAuthHeaders(token),
          },
        );
        if (res.status === 404) {
          // 最小测试桩未实现域概览路由时跳过域加入探测
          await res.body?.cancel();
          return;
        }
        if (res.status === 403) {
          await res.body?.cancel();
          nonMembers.push({ token });
          return;
        }
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(
            `检查域 ${domainSlug} 成员身份失败: HTTP ${res.status} ${
              txt.slice(0, 120)
            }`,
          );
        }
        const body = await res.json() as {
          is_member?: boolean;
          actor_id?: string | null;
          configuration?: { join_policy?: string };
          data?: {
            is_member?: boolean;
            actor_id?: string | null;
            configuration?: { join_policy?: string };
          };
        };
        const detail = body.data ?? body;
        if (detail.is_member === true) return;
        nonMembers.push({
          token,
          actorId: typeof detail.actor_id === "string"
            ? detail.actor_id
            : undefined,
          joinPolicy: detail.configuration?.join_policy,
        });
      })
    ),
  );

  const adminFallbackUsers: Array<{ token: string; actorId?: string }> = [];
  if (nonMembers.length > 0) {
    await Promise.all(
      nonMembers.map((entry) =>
        withSlot(async () => {
          if (entry.joinPolicy === "invite") {
            adminFallbackUsers.push(entry);
            return;
          }
          const joinRes = await authFetch(
            `${baseUrl}/api/v1/domains/${encodedSlug}/join`,
            {
              method: "POST",
              headers: buildAuthHeaders(entry.token),
              body: "{}",
            },
          );
          if (joinRes.ok) {
            const joinBody = await joinRes.json() as {
              data?: { request?: { id?: string } };
            };
            const reqId = joinBody.data?.request?.id;
            if (reqId) {
              const reviewRes = await authFetch(
                `${baseUrl}/api/v1/domains/${encodedSlug}/join-requests/${
                  encodeURIComponent(reqId)
                }/review`,
                {
                  method: "POST",
                  headers: controlHeaders,
                  body: JSON.stringify({ approved: true }),
                },
              );
              if (!reviewRes.ok) {
                const txt = await reviewRes.text();
                throw new Error(
                  `审批域 ${domainSlug} 加入申请失败: HTTP ${reviewRes.status} ${
                    txt.slice(0, 120)
                  }`,
                );
              }
              await reviewRes.body?.cancel();
            }
            return;
          }
          if (
            joinRes.status === 403 ||
            joinRes.status === 404 ||
            joinRes.status === 405
          ) {
            await joinRes.body?.cancel();
            adminFallbackUsers.push(entry);
            return;
          }
          const txt = await joinRes.text();
          throw new Error(
            `加入域 ${domainSlug} 失败: HTTP ${joinRes.status} ${
              txt.slice(0, 120)
            }`,
          );
        })
      ),
    );
  }

  if (adminFallbackUsers.length > 0) {
    const inviteRes = await authFetch(
      `${baseUrl}/api/v1/domains/${encodedSlug}/invitations`,
      {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({
          mode: "general",
          max_uses: adminFallbackUsers.length,
        }),
      },
    );
    if (inviteRes.ok) {
      const inviteBody = await inviteRes.json() as {
        token?: string;
        code?: string;
        data?: { token?: string; code?: string };
      };
      const credential = inviteBody.data?.token ?? inviteBody.token ??
        inviteBody.data?.code ?? inviteBody.code;
      if (typeof credential !== "string" || credential.trim() === "") {
        throw new Error(`创建域 ${domainSlug} 邀请成功但缺少 token`);
      }
      await Promise.all(
        adminFallbackUsers.map((entry) =>
          withSlot(async () => {
            const acceptRes = await authFetch(
              `${baseUrl}/api/v1/domain-invitations/accept`,
              {
                method: "POST",
                headers: buildAuthHeaders(entry.token),
                body: JSON.stringify({ token: credential.trim() }),
              },
            );
            if (!acceptRes.ok) {
              const txt = await acceptRes.text();
              throw new Error(
                `兑换域 ${domainSlug} 邀请失败: HTTP ${acceptRes.status} ${
                  txt.slice(0, 120)
                }`,
              );
            }
            await acceptRes.body?.cancel();
          })
        ),
      );
    } else if (inviteRes.status === 404 || inviteRes.status === 405) {
      await inviteRes.body?.cancel();
      await Promise.all(
        adminFallbackUsers.map((entry) =>
          withSlot(async () => {
            const userId = entry.actorId ??
              await resolveCurrentUserId(authFetch, baseUrl, entry.token);
            const addRes = await authFetch(
              `${baseUrl}/api/v1/domains/${encodedSlug}/members`,
              {
                method: "POST",
                headers: controlHeaders,
                body: JSON.stringify({ user_id: userId, role: "member" }),
              },
            );
            if (
              addRes.status !== 200 &&
              addRes.status !== 201 &&
              addRes.status !== 409
            ) {
              const txt = await addRes.text();
              throw new Error(
                `管理员添加域 ${domainSlug} 成员失败: HTTP ${addRes.status} ${
                  txt.slice(0, 120)
                }`,
              );
            }
            await addRes.body?.cancel();
          })
        ),
      );
    } else {
      const txt = await inviteRes.text();
      throw new Error(
        `创建域 ${domainSlug} 邀请失败: HTTP ${inviteRes.status} ${
          txt.slice(0, 120)
        }`,
      );
    }
  }

  if (contestId && contestId.trim() !== "") {
    const encodedContest = encodeURIComponent(contestId.trim());
    await Promise.all(
      uniqueTokens.map((token) =>
        withSlot(async () => {
          const regRes = await authFetch(
            `${baseUrl}/api/v1/domains/${encodedSlug}/contests/${encodedContest}/register`,
            {
              method: "POST",
              headers: buildAuthHeaders(token),
              body: "{}",
            },
          );
          if (
            regRes.status === 200 ||
            regRes.status === 201 ||
            regRes.status === 409
          ) {
            await regRes.body?.cancel();
            return;
          }
          const txt = await regRes.text();
          throw new Error(
            `压测账号报名竞赛 ${contestId} 失败: HTTP ${regRes.status} ${
              txt.slice(0, 120)
            }`,
          );
        })
      ),
    );
  }
}
