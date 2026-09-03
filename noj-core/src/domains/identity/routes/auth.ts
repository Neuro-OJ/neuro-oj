import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { users } from "./../../../shared/db/schema.ts";
import {
  type AuthEnv,
  authMiddleware,
  getUserBanState,
} from "./../middleware/auth.ts";
import {
  changePassword,
  getUserProfile,
  loginUser,
  MIN_PASSWORD_LENGTH,
  registerUser,
  setPassword,
} from "../services/auth.ts";
import {
  consumeOAuthState,
  createOAuthAuthorization,
  fetchOAuthIdentity,
  linkPasswordMatches,
  listLinkedOAuthAccounts,
  listOAuthProviders,
  oauthFrontendRedirect,
  type OAuthProviderId,
  oauthStateCookieName,
  resolveOAuthIdentity,
  unlinkOAuthAccount,
} from "../services/oauth.ts";
import {
  confirmTfa,
  disableTfa,
  regenerateRecoveryCodes,
  setupTfa,
} from "../services/tfa.ts";
import { requestReset, resetPassword } from "../services/passwordReset.ts";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { getUserPermissions } from "./../services/security/permissions.ts";
import { signToken, verifyToken } from "./../services/security/jwt.ts";
import { revokeJti } from "./../services/security/revokedTokens.ts";
import { getSetting } from "../../system/index.ts";
import { getClientIp } from "../../system/index.ts";
import { getBannedIpDetail } from "../services/banlist.ts";
import {
  applyLoginBackoff,
  clearLoginFailure,
  isLoginLocked,
  recordLoginBackoff,
  recordLoginFailure,
} from "./../services/security/loginThrottle.ts";
import {
  checkLoginAccountRateLimit,
  LOGIN_LIMITS,
  loginIpRateLimit,
  resolveLoginAccountKey,
  throwRateLimited,
} from "./../middleware/login-rate-limit.ts";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from "../../../types/auth.ts";
import { SECONDS_PER_DAY } from "./../../../shared/base/constants.ts";
import {
  enforcePasswordResetEmailRateLimit,
  enforcePasswordResetIpRateLimit,
  enforceRegisterRateLimit,
} from "../../system/index.ts";

// change-password 端点的限流命名空间（独立于登录端点）
// 失败计数 / 锁定 / 退避均使用此前缀，避免改密失败反锁 /login（issue #75 评审 H4）
const PWCHANGE_NAMESPACE = "pwchange";
const TFA_NAMESPACE = "tfa";

// PR-6 评审修订：使用 middleware/auth.ts 导出的 AuthEnv 类型
// 避免与 inline 定义重复（之前两边各定义一份完全相同的 Variables 结构）
const auth = new Hono<AuthEnv>();

/**
 * 用户注册端点。
 * POST /api/v1/auth/register
 *
 * PR-2：allow_register 设置生效（管理后台可关闭注册入口）。
 * 关闭时直接 403，不暴露"用户已存在"等详细信息（防枚举）。
 */
auth.post("/register", async (c) => {
  // PR-2 死开关：allow_register
  const allowRegisterSetting = getSetting("allow_register");
  if (allowRegisterSetting?.value === false) {
    throw new ForbiddenError("注册已关闭", "REGISTER_DISABLED");
  }

  // NOJ-093：注册端点 IP 限流。
  await enforceRegisterRateLimit(c);

  const body = await parseJsonBody<RegisterInput>(c);

  // 验证必填字段
  if (!body.username || !body.email || !body.password) {
    const missing: string[] = [];
    if (!body.username) missing.push("username");
    if (!body.email) missing.push("email");
    if (!body.password) missing.push("password");
    throw new ValidationError(
      `缺少必填字段：${missing.join(", ")}`,
    );
  }

  // 验证用户名格式（3-30 字符，仅字母、数字、下划线）
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(body.username)) {
    throw new ValidationError("用户名仅允许字母、数字和下划线，长度 3-30");
  }

  // 验证邮箱格式
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw new ValidationError("邮箱格式不正确");
  }

  // 验证密码长度
  if (body.password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
  }

  const clientIp = getClientIp(c);
  const user = await registerUser(body, clientIp);
  return c.json({ data: user }, 201);
});

/**
 * 用户登录端点。
 * POST /api/v1/auth/login
 *
 * 限流（issue #73）：
 * 1. IP 维度（中间件）：30s 10 次 → 429
 * 2. 账号维度（路由层）：30s 5 次 → 429
 * 3. 失败退避：连续失败每次 +15s 等待（内存 Map）
 * 4. 失败锁定：连续 10 次失败 → 锁 1 小时
 */

/**
 * 执行账号维度限流三步检查（限流 + 退避 + 锁定）。
 * namespace 区分登录（默认）与改密（PWCHANGE_NAMESPACE）。
 */
async function enforceAccountRateLimit(
  account: string,
  namespace?: string,
): Promise<string> {
  const accountKey = await resolveLoginAccountKey(account);
  const accResult = await checkLoginAccountRateLimit(account, namespace);
  if (!accResult.allowed) {
    throwRateLimited(LOGIN_LIMITS.acc, accResult);
  }

  // 内存退避：未到 deadline 则 sleep
  await applyLoginBackoff(accountKey, namespace);

  // 账号锁定检查
  if (await isLoginLocked(accountKey, namespace)) {
    throw new UnauthorizedError("登录尝试过多，账号已临时锁定");
  }
  return accountKey;
}

/** 记录一次认证失败（失败计数 + 退避），不阻塞响应。 */
async function recordAuthFailure(
  account: string,
  namespace?: string,
): Promise<void> {
  const failCount = await recordLoginFailure(account, namespace);
  await recordLoginBackoff(account, failCount, namespace);
}

/** 执行需验证码的 TFA 管理操作，并以独立限流桶防止验证码枚举。 */
async function executeTfaProtectedAction<T>(
  userId: string,
  action: () => Promise<T>,
): Promise<T> {
  const accountKey = await enforceAccountRateLimit(userId, TFA_NAMESPACE);
  try {
    const result = await action();
    await clearLoginFailure(accountKey, TFA_NAMESPACE);
    return result;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await recordAuthFailure(accountKey, TFA_NAMESPACE);
    }
    throw err;
  }
}

/** 解析 TFA 管理请求体并执行需验证码的操作。 */
async function tfaAction<T>(
  c: Context,
  action: (userId: string, code: string, ip: string) => Promise<T>,
): Promise<T> {
  const body = await parseJsonBody<{ code?: string }>(c);
  if (!body.code) {
    throw new ValidationError("缺少字段 code");
  }
  const userId = c.get("userId") as string;
  return executeTfaProtectedAction(
    userId,
    () => action(userId, body.code!, getClientIp(c)),
  );
}

/**
 * 用户登录端点。
 * POST /api/v1/auth/login
 *
 * 需登录名与密码；执行账号维度限流（限流 + 退避 + 锁定），成功后返回
 * `{ data: { user, token } }`，失败记录认证失败计数。
 */
auth.post("/login", loginIpRateLimit(), async (c) => {
  const body = await parseJsonBody<LoginInput>(c);

  // 验证必填字段
  if (!body.login || !body.password) {
    throw new ValidationError("缺少必填字段：login, password");
  }

  // 1. 账号维度限流（限流 + 退避 + 锁定）
  const accountKey = await enforceAccountRateLimit(body.login);

  // 2. 验证
  try {
    const clientIp = getClientIp(c);
    const result = await loginUser(body, clientIp);
    await clearLoginFailure(accountKey);
    return c.json({ data: result }, 200);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // 失败：记录（不阻塞响应）
      await recordAuthFailure(accountKey);
    }
    throw err;
  }
});

/** 构造 OAuth 会话 Cookie 的公共选项（HttpOnly、SameSite=Lax、生产环境 Secure）。 */
function oauthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: Deno.env.get("NOJ_ENV") === "production",
    path: "/",
    maxAge: SECONDS_PER_DAY,
  };
}

/**
 * 手动序列化并写入 OAuth 登录后的 noj:token / noj:session Cookie。
 * 因 Hono serializer 不允许 `:`，此处手动拼接以保持与 Nitro 契约的 Cookie 名一致。
 * @param c Hono 上下文
 * @param user 当前用户信息
 * @param token 签发的 JWT
 */
function setOAuthSession(c: Parameters<typeof setCookie>[0], user: {
  id: string;
  username: string;
  email: string;
  is_admin: boolean;
  must_change_password: boolean;
  tfa_enabled: boolean;
  avatar_url: string | null;
}, token: string) {
  // Hono 的 cookie serializer 不允许 `:`，但现有 Nitro 契约使用 `noj:token`
  // / `noj:session`。回调直接返回给浏览器时手动序列化，保持两层 Cookie 名称一致。
  const options = oauthCookieOptions();
  const suffix = `${
    options.secure ? "; Secure" : ""
  }; HttpOnly; Path=/; SameSite=Lax; Max-Age=${options.maxAge}`;
  c.header(
    "Set-Cookie",
    `noj:token=${encodeURIComponent(token)}${suffix}`,
    { append: true },
  );
  const session = JSON.stringify({
    userId: user.id,
    username: user.username,
    role: user.is_admin ? "admin" : "user",
    email: user.email,
    is_admin: user.is_admin,
    must_change_password: user.must_change_password,
    tfa_enabled: user.tfa_enabled,
    avatar_url: user.avatar_url,
  });
  c.header(
    "Set-Cookie",
    `noj:session=${encodeURIComponent(session)}${
      suffix.replace("; HttpOnly", "")
    }`,
    { append: true },
  );
}

/** 返回当前可用的第三方登录方式。 */
auth.get("/oauth/providers", (c) => {
  return c.json({ data: listOAuthProviders() }, 200);
});

/** 发起登录或绑定授权。绑定由 POST /oauth/:provider/link 创建 state。 */
auth.get("/oauth/:provider", async (c) => {
  const requestUrl = c.req.url;
  const result = await createOAuthAuthorization(
    c.req.param("provider") as string,
    "login",
    requestUrl,
  );
  setCookie(c, oauthStateCookieName(), result.cookieValue, {
    ...oauthCookieOptions(),
    httpOnly: true,
    maxAge: 600,
  });
  return c.redirect(result.url, 302);
});

/**
 * OAuth 回调端点。
 * GET /api/v1/auth/oauth/:provider/callback
 *
 * 校验并消费 state，用 code 换取身份后解析为登录/绑定会话，写入 Cookie 并
 * 重定向回前端；失败时携带 oauth_error 参数重定向。
 */
auth.get("/oauth/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as OAuthProviderId;
  const requestUrl = c.req.url;
  try {
    const state = await consumeOAuthState(
      provider,
      c.req.query("state"),
      getCookie(c, oauthStateCookieName()),
    );
    deleteCookie(c, oauthStateCookieName(), { path: "/" });
    const code = c.req.query("code");
    if (!code) {
      throw new BadRequestError(
        "OAuth 回调缺少 code",
        "OAUTH_CALLBACK_INVALID",
      );
    }
    const identity = await fetchOAuthIdentity(provider, code, requestUrl);
    const result = await resolveOAuthIdentity(
      provider,
      identity,
      state.intent,
      state.userId,
    );
    setOAuthSession(c, result.user, result.token);
    return c.redirect(
      oauthFrontendRedirect(
        requestUrl,
        undefined,
        state.intent === "link"
          ? "/settings"
          : result.user.has_local_password
          ? "/"
          : "/set-password",
      ),
      302,
    );
  } catch (error) {
    deleteCookie(c, oauthStateCookieName(), { path: "/" });
    const code =
      error instanceof BadRequestError && error.code.startsWith("OAUTH_STATE")
        ? "state_invalid"
        : "provider_error";
    return c.redirect(oauthFrontendRedirect(requestUrl, code), 302);
  }
});

/**
 * 发起绑定第三方账号授权。
 * POST /api/v1/auth/oauth/:provider/link
 * 需登录；校验本地密码后创建绑定授权，返回 `{ data: { authorization_url } }`。
 */
auth.post("/oauth/:provider/link", authMiddleware, async (c) => {
  const body = await parseJsonBody<{ password?: string }>(c);
  await linkPasswordMatches(c.get("userId") as string, body.password ?? "");
  const result = await createOAuthAuthorization(
    c.req.param("provider") as string,
    "link",
    c.req.url,
    c.get("userId") as string,
  );
  setCookie(c, oauthStateCookieName(), result.cookieValue, {
    ...oauthCookieOptions(),
    maxAge: 600,
  });
  return c.json({ data: { authorization_url: result.url } }, 200);
});

/**
 * 查询当前用户已绑定的 OAuth 账号。
 * GET /api/v1/auth/oauth/accounts
 * 需登录；返回 `{ data: LinkedOAuthAccount[] }`（外部用户 ID 已脱敏）。
 */
auth.get("/oauth/accounts", authMiddleware, async (c) => {
  return c.json({
    data: await listLinkedOAuthAccounts(c.get("userId") as string),
  }, 200);
});

/**
 * 解绑当前用户的一条 OAuth 账号。
 * DELETE /api/v1/auth/oauth/accounts/:id
 * 需登录；body 需提供 password 确认，成功返回 204。
 */
auth.delete("/oauth/accounts/:id", authMiddleware, async (c) => {
  const body = await parseJsonBody<{ password?: string }>(c);
  const userId = c.get("userId") as string;
  await linkPasswordMatches(userId, body.password ?? "");
  await unlinkOAuthAccount(userId, c.req.param("id") as string);
  return c.body(null, 204);
});

/**
 * 为 OAuth 用户补设本地密码。
 * POST /api/v1/auth/set-password
 * 需登录；body 需提供 new_password，成功返回 `{ data: { user } }`。
 */
auth.post("/set-password", authMiddleware, async (c) => {
  const body = await parseJsonBody<{ new_password?: string }>(c);
  if (!body.new_password) {
    throw new ValidationError("缺少必填字段：new_password");
  }
  const user = await setPassword(
    c.get("userId") as string,
    body.new_password,
    getClientIp(c),
  );
  return c.json({ data: { user } }, 200);
});

/**
 * 获取当前用户信息端点。
 * GET /api/v1/auth/me
 * 需要 Bearer token 认证。
 */
auth.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const user = await getUserProfile(userId);
  const permissions = await getUserPermissions(userId);
  return c.json({ data: { ...user, permissions: [...permissions] } }, 200);
});

/**
 * 修改密码端点（issue #75）。
 * POST /api/v1/auth/change-password
 * 需要 Bearer token 认证。
 *
 * 中间件顺序：loginIpRateLimit() 在前挡 DoS，authMiddleware 在前注入 userId。
 * 通过 PASSWORD_CHANGE_WHITELIST 配置，authMiddleware 对 change-password
 * 路径放行 must_change_password 拦截（评审修复 H1）。
 *
 * 限流（独立命名空间 PWCHANGE_NAMESPACE，避免改密失败反锁 /login）：
 * 1. IP 维度（中间件）：30s 10 次 → 429
 * 2. 账号维度（路由层）：30s 5 次 → 429
 * 3. 失败退避：连续失败每次 +15s 等待（内存 Map，独立 namespace）
 * 4. 失败锁定：连续 10 次失败 → 锁 1 小时（独立 namespace）
 *
 * 业务：
 * - 成功：清改密失败计数 + 撤销旧 token + 签发新 token + 返回
 *   `{ user, token }`（must_change_password=false，token 是新 jti）
 * - 失败：401（用户不存在/旧密码错/强度不足），记录改密失败（独立 namespace）
 *
 * 撤销机制（issue #75 撤销）：成功后立即将旧 jti 写入 Redis 黑名单，
 * 旧 token 在剩余有效期内也会被 middleware 拒绝。新 token 由前端 Nitro
 * 代理同步写入 noj:token cookie，用户无感知。
 */
auth.post(
  "/change-password",
  loginIpRateLimit(PWCHANGE_NAMESPACE),
  authMiddleware,
  async (c) => {
    const body = await parseJsonBody<ChangePasswordInput>(c);

    if (!body.old_password || !body.new_password) {
      const missing: string[] = [];
      if (!body.old_password) missing.push("old_password");
      if (!body.new_password) missing.push("new_password");
      throw new ValidationError(`缺少必填字段：${missing.join(", ")}`);
    }

    const userId = c.get("userId") as string;

    // 账号维度限流：按 userId 防止暴力试老密码（独立 namespace）
    await enforceAccountRateLimit(userId, PWCHANGE_NAMESPACE);

    try {
      const user = await changePassword(
        userId,
        body.old_password,
        body.new_password,
        getClientIp(c),
      );
      await clearLoginFailure(userId, PWCHANGE_NAMESPACE);

      // 撤销旧 jti（issue #75 JWT 撤销机制）：jose 验证后拿不到原 exp，
      // 直接用 24h 上限（jwt_expires_in 默认值）作为保守 TTL
      const oldJti = c.get("jti");
      if (oldJti) {
        await revokeJti(oldJti, SECONDS_PER_DAY);
      }

      // 签发新 token（must_change_password 必为 false，changePassword 已 UPDATE）
      const newToken = await signToken({
        sub: user.id,
        role: "user",
        must_change_password: false,
      });

      return c.json({ data: { user, token: newToken } }, 200);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await recordAuthFailure(userId, PWCHANGE_NAMESPACE);
      }
      throw err;
    }
  },
);

/**
 * TFA 管理端点（issue #228）。
 * 以下端点均需登录，用于启用/禁用 TOTP 与恢复码管理。
 */
auth.post("/tfa/setup", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const result = await setupTfa(userId, "", getClientIp(c));
  return c.json(
    { data: { secret: result.secret, otpauth_url: result.otpauthUrl } },
    200,
  );
});

/**
 * 确认启用 TFA。
 * POST /api/v1/auth/tfa/confirm
 * 需登录；body 需提供 TOTP code，成功返回 `{ data: { recovery_codes } }`。
 */
auth.post(
  "/tfa/confirm",
  loginIpRateLimit(TFA_NAMESPACE),
  authMiddleware,
  async (c) => {
    const recoveryCodes = await tfaAction(
      c,
      (userId, code, ip) => confirmTfa(userId, code, ip),
    );
    return c.json({ data: { recovery_codes: recoveryCodes } }, 200);
  },
);

/**
 * 禁用 TFA。
 * POST /api/v1/auth/tfa/disable
 * 需登录；body 需提供 TOTP code 或恢复码，成功返回 `{ data: { ok: true } }`。
 */
auth.post(
  "/tfa/disable",
  loginIpRateLimit(TFA_NAMESPACE),
  authMiddleware,
  async (c) => {
    await tfaAction(c, (userId, code, ip) => disableTfa(userId, code, ip));
    return c.json({ data: { ok: true } }, 200);
  },
);

/**
 * 重新生成 TFA 恢复码。
 * POST /api/v1/auth/tfa/recovery-codes/regenerate
 * 需登录；body 需提供 TOTP code 或恢复码，成功返回 `{ data: { recovery_codes } }`。
 */
auth.post(
  "/tfa/recovery-codes/regenerate",
  loginIpRateLimit(TFA_NAMESPACE),
  authMiddleware,
  async (c) => {
    const recoveryCodes = await tfaAction(
      c,
      (userId, code, ip) => regenerateRecoveryCodes(userId, code, ip),
    );
    return c.json({ data: { recovery_codes: recoveryCodes } }, 200);
  },
);

/**
 * 登出端点（issue #75 JWT 撤销机制）。
 * POST /api/v1/auth/logout
 * 需要 Bearer token 认证。
 *
 * 服务端将当前 token 的 jti 写入 Redis 黑名单（TTL = token 剩余有效期），
 * 之后该 token 即使签名有效也会被 authMiddleware 拒绝。
 * 同时清除客户端的 noj:token / noj:session Cookie（由 noj-ui Nitro 代理处理）。
 *
 * 设计权衡：BAN_WHITELIST 中保留 /logout，使被封禁用户也能主动结束会话。
 */
auth.post("/logout", authMiddleware, async (c) => {
  const jti = c.get("jti");
  if (jti) {
    // TTL 取保守 24h（与 jwt_expires_in 默认一致）；
    // 精确的剩余 TTL 需要重新解析 token exp，复杂度高于收益。
    await revokeJti(jti, SECONDS_PER_DAY);
  }
  return c.json({ data: { ok: true } }, 200);
});

/**
 * 当前请求的封禁状态（issue #102 / ban-status-endpoint）。
 * GET /api/v1/auth/ban-status
 *
 * 不受 banlistMiddleware 和 authMiddleware 封禁检查限制（GET 方法限制自动放行）。
 * 返回 IP 封禁状态 +（如有有效 JWT）用户封禁状态。
 *
 * 前端在布局级调用此端点以决定是否渲染全局 BanBanner。
 */
auth.get("/ban-status", async (c) => {
  // ─── IP 封禁状态 ───
  const clientIp = getClientIp(c);
  let ipBanned = false;
  let ipBanInfo: {
    matched_cidr: string;
    reason: string;
    expires_at: string | null;
    created_at: string;
  } | null = null;

  if (clientIp && clientIp !== "unknown") {
    const detail = await getBannedIpDetail(clientIp);
    if (detail) {
      ipBanned = true;
      ipBanInfo = detail;
    }
  }

  // ─── 用户封禁状态（尝试解析 token，不强校验） ───
  let authenticated = false;
  let user: { id: string; role: string; username: string } | null = null;
  let userBanned = false;
  let userBanInfo: { reason: string; until: string | null } | null = null;

  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const payload = await verifyToken(authHeader.slice(7));
      authenticated = true;

      // 从 DB 查 username（JWT payload 不包含 username）
      const db = getDb();
      const [userRow] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);

      user = {
        id: payload.sub,
        role: payload.role ?? "user",
        username: userRow?.username ?? "unknown",
      };
      const banState = await getUserBanState(payload.sub);
      const stillBanned = banState.banned &&
        (!banState.until || Date.parse(banState.until) > Date.now());
      if (stillBanned) {
        userBanned = true;
        userBanInfo = { reason: banState.reason, until: banState.until };
      }
    } catch {
      // token 无效/过期 —— 忽略，视为未认证
    }
  }

  return c.json({
    ip_banned: ipBanned,
    ip_ban_info: ipBanInfo,
    user_banned: userBanned,
    user_ban_info: userBanInfo,
    authenticated,
    user,
  }, 200);
});

/**
 * 密码重置请求端点（issue #49）。
 * POST /api/v1/auth/forgot-password
 *
 * 防枚举行为：不管邮箱是否存在，统一返 200 + 同一消息。
 * 邮箱存在时生成 token + 调 sendPasswordResetEmail()。
 */
auth.post("/forgot-password", async (c) => {
  const body = await parseJsonBody<ForgotPasswordInput>(c);

  if (!body.email) {
    throw new BadRequestError("缺少字段 email");
  }

  // NOJ-094：忘记密码 IP + 邮箱双维度限流。
  await enforcePasswordResetIpRateLimit(c);
  await enforcePasswordResetEmailRateLimit(body.email);

  // APP_URL 由 requestReset 优先使用；请求头仅作为非生产环境开发回退。
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? "localhost:3000";
  const appBaseUrl = `${proto}://${host}`;

  await requestReset(body.email, appBaseUrl, getClientIp(c));

  return c.json(
    {
      ok: true,
      message: "如果该邮箱已注册，您将收到一封密码重置邮件",
    },
    200,
  );
});

/**
 * 密码重置执行端点（issue #49）。
 * POST /api/v1/auth/reset-password
 *
 * 用邮件链接中的 token + 新密码重置密码。
 * 令牌无效/过期/已用时返 400 明确错误（用户主动操作场景）。
 */
auth.post("/reset-password", async (c) => {
  const body = await parseJsonBody<ResetPasswordInput>(c);

  if (!body.token || !body.new_password) {
    const missing: string[] = [];
    if (!body.token) missing.push("token");
    if (!body.new_password) missing.push("new_password");
    throw new BadRequestError(`缺少字段：${missing.join(", ")}`);
  }

  // NOJ-094：重置密码 IP 维度限流。
  await enforcePasswordResetIpRateLimit(c);

  await resetPassword(body.token, body.new_password, getClientIp(c));

  return c.json(
    {
      ok: true,
      message: "密码重置成功，请使用新密码登录",
    },
    200,
  );
});

export default auth;
