/**
 * GitHub + 通用 OIDC OAuth 服务。
 * provider access/refresh token 只在一次回调请求内存中使用，绝不落库。
 */
import { and, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { getDb } from "../../../db/connection.ts";
import { oauthAccounts, roles, userRoles, users } from "../../../db/schema.ts";
import { signToken } from "../../../lib/jwt.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../lib/errors.ts";
import { isUserAdmin } from "../../../lib/permissions.ts";
import { logAuthEvent } from "../../system/index.ts";
import { toUserResponse } from "./auth/auth-register.ts";
import type { UserResponse } from "../../../types/auth.ts";

/** 支持的 OAuth 身份提供商。 */
export type OAuthProviderId = "github" | "oidc";
/** OAuth 流程用途：登录或绑定到当前用户。 */
export type OAuthIntent = "login" | "link";

/** 前端展示用的 OAuth 提供商信息。 */
export interface OAuthProviderInfo {
  id: OAuthProviderId;
  name: string;
}

/** 从 OAuth 提供商取得的、已完成基本校验的用户身份。 */
export interface OAuthIdentity {
  providerUserId: string;
  username?: string;
  email?: string;
  emailVerified: boolean;
}

interface ProviderConfig extends OAuthProviderInfo {
  clientId: string;
  clientSecret: string;
  issuer?: string;
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  issuer?: string;
}

interface OAuthStatePayload {
  purpose: "oauth_state";
  nonce: string;
  provider: OAuthProviderId;
  intent: OAuthIntent;
  userId?: string;
}

// Cookie 名不能包含 `:`（Hono serializer 会拒绝），与 Nitro 的 `noj:token`
// 分开使用下划线名称，避免依赖实现细节。
const STATE_COOKIE = "noj_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;
const consumedStates = new Map<string, number>();

/** 读取 JWT_SECRET 环境变量并编码为 Uint8Array，用于 OAuth state 签名/校验。 */
function secret(): Uint8Array {
  const value = Deno.env.get("JWT_SECRET");
  if (!value) {
    throw new Error("环境变量 JWT_SECRET 未设置，无法处理 OAuth state");
  }
  return new TextEncoder().encode(value);
}

/** 将未知值安全转换为对象；非对象（含 null/undefined）时返回空对象。 */
function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

/**
 * 校验值为非空字符串，否则抛出 OAuth provider 错误。
 * @param value 待校验值
 * @param name 字段名（用于错误信息）
 * @returns 校验通过的非空字符串
 * @throws {BadRequestError} 值缺失或非字符串
 */
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestError(
      `OAuth provider 返回的 ${name} 无效`,
      "OAUTH_PROVIDER_ERROR",
    );
  }
  return value;
}

/** 将 OIDC 返回的 email_verified 值（true / "true"）解析为布尔值。 */
function parseVerified(value: unknown): boolean {
  return value === true || value === "true";
}

/** 从环境变量读取配置完整且已启用的 OAuth 提供商列表（GitHub / OIDC）。 */
function configuredProviders(): ProviderConfig[] {
  const result: ProviderConfig[] = [];
  const githubId = Deno.env.get("OAUTH_GITHUB_CLIENT_ID")?.trim();
  const githubSecret = Deno.env.get("OAUTH_GITHUB_CLIENT_SECRET")?.trim() ||
    Deno.env.get("OAUTH_GITHUB_SECRET")?.trim();
  if (githubId && githubSecret) {
    result.push({
      id: "github",
      name: "GitHub",
      clientId: githubId,
      clientSecret: githubSecret,
    });
  }

  const issuer = Deno.env.get("OAUTH_OIDC_ISSUER_URL")?.trim().replace(
    /\/+$/,
    "",
  );
  const oidcId = Deno.env.get("OAUTH_OIDC_CLIENT_ID")?.trim();
  const oidcSecret = Deno.env.get("OAUTH_OIDC_CLIENT_SECRET")?.trim();
  if (issuer && oidcId && oidcSecret) {
    result.push({
      id: "oidc",
      name: Deno.env.get("OAUTH_OIDC_NAME")?.trim() || "OIDC",
      clientId: oidcId,
      clientSecret: oidcSecret,
      issuer,
    });
  }
  return result;
}

/** 返回当前环境中配置完整且已启用的 OAuth 提供商。 */
export function listOAuthProviders(): OAuthProviderInfo[] {
  return configuredProviders().map(({ id, name }) => ({ id, name }));
}

/**
 * 按提供商 ID 查找配置，未启用时抛 NotFoundError。
 * @param provider 提供商 ID（github / oidc）
 * @returns 对应的提供商配置
 * @throws {NotFoundError} 该第三方登录方式未启用
 */
function providerOrThrow(provider: string): ProviderConfig {
  const config = configuredProviders().find((item) => item.id === provider);
  if (!config) throw new NotFoundError("该第三方登录方式未启用");
  return config;
}

/** 解析应用基础地址：优先使用 APP_URL 环境变量，否则取请求 URL 的 origin。 */
function appUrl(requestUrl: string): string {
  const configured = Deno.env.get("APP_URL")?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(requestUrl).origin;
}

/** 根据应用地址生成指定提供商的 OAuth 回调地址。 */
export function callbackUrl(
  provider: OAuthProviderId,
  requestUrl: string,
): string {
  return `${appUrl(requestUrl)}/api/v1/auth/oauth/${provider}/callback`;
}

/** 生成 OAuth 完成后返回前端的地址，可附带错误信息。 */
export function oauthFrontendRedirect(
  requestUrl: string,
  error?: string,
  path = "/",
): string {
  const url = new URL(appUrl(requestUrl));
  url.pathname = path;
  if (error) url.searchParams.set("oauth_error", error);
  return url.toString();
}

/** 返回保存 OAuth state nonce 的 Cookie 名称。 */
export function oauthStateCookieName(): string {
  return STATE_COOKIE;
}

/** 创建 OAuth 授权地址、签名 state 和配套 Cookie 值。 */
export async function createOAuthAuthorization(
  providerId: string,
  intent: OAuthIntent,
  requestUrl: string,
  userId?: string,
): Promise<{ url: string; state: string; cookieValue: string }> {
  const provider = providerOrThrow(providerId);
  if (intent === "link" && !userId) {
    throw new BadRequestError("绑定第三方账号需要登录", "AUTH_REQUIRED");
  }
  const nonce = crypto.randomUUID();
  const payload: OAuthStatePayload = {
    purpose: "oauth_state",
    nonce,
    provider: provider.id,
    intent,
    ...(userId ? { userId } : {}),
  };
  const state = await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(secret());

  const redirectUri = callbackUrl(provider.id, requestUrl);
  let url: URL;
  if (provider.id === "github") {
    url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
  } else {
    const metadata = await oidcMetadata(provider);
    url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
  }
  return { url: url.toString(), state, cookieValue: nonce };
}

/** 校验并消费 OAuth state，拒绝伪造、过期和重放请求。 */
export async function consumeOAuthState(
  providerId: string,
  state: string | undefined,
  cookieValue: string | undefined,
): Promise<OAuthStatePayload> {
  if (!state || !cookieValue) {
    throw new BadRequestError(
      "OAuth state 无效或已过期",
      "OAUTH_STATE_INVALID",
    );
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(state, secret(), {
      algorithms: ["HS256"],
    }));
  } catch {
    throw new BadRequestError(
      "OAuth state 无效或已过期",
      "OAUTH_STATE_INVALID",
    );
  }
  const value = payload as unknown as Partial<OAuthStatePayload>;
  if (
    value.purpose !== "oauth_state" || value.provider !== providerId ||
    typeof value.nonce !== "string" || value.nonce !== cookieValue ||
    (value.intent !== "login" && value.intent !== "link")
  ) {
    throw new BadRequestError(
      "OAuth state 无效或已过期",
      "OAUTH_STATE_INVALID",
    );
  }
  const now = Date.now();
  for (const [nonce, expiry] of consumedStates) {
    if (expiry <= now) consumedStates.delete(nonce);
  }
  if (consumedStates.has(value.nonce)) {
    throw new BadRequestError("OAuth state 已使用", "OAUTH_STATE_REPLAYED");
  }
  consumedStates.set(value.nonce, now + STATE_TTL_SECONDS * 1000);
  return {
    purpose: "oauth_state",
    nonce: value.nonce,
    provider: value.provider,
    intent: value.intent,
    ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
  };
}

/**
 * 读取第三方响应 JSON；响应非 OK 时抛 OAuth provider 错误。
 * @param response 第三方 HTTP 响应
 * @returns 解析后的 JSON 对象
 * @throws {BadRequestError} 响应非 2xx 或 JSON 解析失败
 */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new BadRequestError(
      "第三方登录服务暂时不可用",
      "OAUTH_PROVIDER_ERROR",
    );
  }
  return jsonObject(await response.json());
}

/**
 * 获取 OIDC provider 的 OpenID 配置元数据，并校验 issuer 一致性。
 * @param provider OIDC 提供商配置
 * @returns OIDC 元数据（授权/令牌/userinfo 端点等）
 * @throws {BadRequestError} 元数据缺失或 issuer 校验失败
 */
async function oidcMetadata(provider: ProviderConfig): Promise<OidcMetadata> {
  const response = await fetch(
    `${provider.issuer}/.well-known/openid-configuration`,
    {
      headers: { accept: "application/json" },
    },
  );
  const data = await readJson(response);
  if (
    typeof data.issuer === "string" &&
    data.issuer.replace(/\/+$/, "") !== provider.issuer
  ) {
    throw new BadRequestError(
      "OIDC provider issuer 校验失败",
      "OAUTH_PROVIDER_ERROR",
    );
  }
  const authorizationEndpoint = requiredString(
    data.authorization_endpoint,
    "authorization_endpoint",
  );
  const tokenEndpoint = requiredString(data.token_endpoint, "token_endpoint");
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    userinfo_endpoint: typeof data.userinfo_endpoint === "string"
      ? data.userinfo_endpoint
      : undefined,
    issuer: typeof data.issuer === "string" ? data.issuer : undefined,
  };
}

/**
 * 使用授权码向提供商换取 access token。
 * @param provider 提供商配置
 * @param code 授权码
 * @param requestUrl 当前请求 URL（用于构造回调地址）
 * @returns access token 及（OIDC 时）元数据
 * @throws {BadRequestError} 换取失败或缺少 access_token
 */
async function exchangeCode(
  provider: ProviderConfig,
  code: string,
  requestUrl: string,
): Promise<{ accessToken: string; metadata?: OidcMetadata }> {
  const redirectUri = callbackUrl(provider.id, requestUrl);
  let endpoint: string;
  let body: URLSearchParams;
  const headers: Record<string, string> = { accept: "application/json" };
  let metadata: OidcMetadata | undefined;
  if (provider.id === "github") {
    endpoint = "https://github.com/login/oauth/access_token";
    body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
  } else {
    metadata = await oidcMetadata(provider);
    endpoint = metadata.token_endpoint;
    body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
  }
  const response = await fetch(endpoint, { method: "POST", headers, body });
  const data = await readJson(response);
  return {
    accessToken: requiredString(data.access_token, "access_token"),
    metadata,
  };
}

/** 使用授权码向提供商换取并读取用户身份信息。 */
export async function fetchOAuthIdentity(
  providerId: string,
  code: string,
  requestUrl: string,
): Promise<OAuthIdentity> {
  const provider = providerOrThrow(providerId);
  const { accessToken, metadata } = await exchangeCode(
    provider,
    code,
    requestUrl,
  );
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
  if (provider.id === "github") {
    const userResponse = await fetch("https://api.github.com/user", {
      headers,
    });
    if (!userResponse.ok) {
      throw new BadRequestError(
        "GitHub 用户信息获取失败",
        "OAUTH_PROVIDER_ERROR",
      );
    }
    const user = jsonObject(await userResponse.json());
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers,
    });
    if (!emailsResponse.ok) {
      throw new BadRequestError(
        "GitHub 邮箱信息获取失败",
        "OAUTH_PROVIDER_ERROR",
      );
    }
    const emailsData = await emailsResponse.json();
    const emailRows = Array.isArray(emailsData)
      ? emailsData as Array<Record<string, unknown>>
      : [];
    const primary = emailRows.find((item) =>
      item.primary === true && item.verified === true
    ) ??
      emailRows.find((item) =>
        item.verified === true
      );
    return {
      providerUserId: requiredString(user.id?.toString(), "id"),
      username: typeof user.login === "string" ? user.login : undefined,
      email: typeof primary?.email === "string" ? primary.email : undefined,
      emailVerified: primary?.verified === true,
    };
  }
  if (!metadata?.userinfo_endpoint) {
    throw new BadRequestError(
      "OIDC provider 未提供 userinfo_endpoint",
      "OAUTH_PROVIDER_ERROR",
    );
  }
  const userResponse = await fetch(metadata.userinfo_endpoint, { headers });
  if (!userResponse.ok) {
    throw new BadRequestError(
      "OIDC 用户信息获取失败",
      "OAUTH_PROVIDER_ERROR",
    );
  }
  const user = jsonObject(await userResponse.json());
  return {
    providerUserId: requiredString(user.sub, "sub"),
    username: typeof user.preferred_username === "string"
      ? user.preferred_username
      : typeof user.name === "string"
      ? user.name
      : undefined,
    email: typeof user.email === "string" ? user.email : undefined,
    emailVerified: parseVerified(user.email_verified),
  };
}

/**
 * 由 OAuth 身份生成用户名基础串：优先用身份用户名，否则用 provider + 用户 ID 尾号。
 * 仅保留字母数字下划线并截断，长度不足时回退为 `${provider}_user`。
 */
function usernameBase(
  provider: OAuthProviderId,
  identity: OAuthIdentity,
): string {
  const raw = identity.username ||
    `${provider}_${identity.providerUserId.slice(-12)}`;
  const value = raw.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
  return value.length >= 3 ? value : `${provider}_user`;
}

/**
 * 生成唯一用户名：优先使用 base，冲突时追加 `_1`、`_2`… 后缀。
 * @param base 用户名基础串
 * @returns 数据库中不存在的唯一用户名
 * @throws {ConflictError} 尝试 1000 次仍无法生成唯一用户名
 */
async function uniqueUsername(base: string): Promise<string> {
  const db = getDb();
  const normalized = base.slice(0, 30);
  if (
    (await db.select({ id: users.id }).from(users).where(
      eq(users.username, normalized),
    ).limit(1)).length === 0
  ) return normalized;
  for (let index = 1; index < 1000; index++) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 30 - suffix.length)}${suffix}`;
    if (
      (await db.select({ id: users.id }).from(users).where(
        eq(users.username, candidate),
      ).limit(1)).length === 0
    ) return candidate;
  }
  throw new ConflictError("无法生成唯一用户名");
}

/**
 * 为 OAuth 身份创建新用户并分配默认角色。
 * @param provider 提供商 ID
 * @param identity 已校验的 OAuth 身份
 * @returns 新创建的用户 ID
 */
async function createOAuthUser(
  provider: OAuthProviderId,
  identity: OAuthIdentity,
): Promise<string> {
  const db = getDb();
  const userId = crypto.randomUUID();
  const username = await uniqueUsername(usernameBase(provider, identity));
  const email = identity.emailVerified && identity.email
    ? identity.email
    : `${provider}-${identity.providerUserId}@oauth.invalid`;
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: userId,
    username,
    email,
    password_hash: null,
    created_at: now,
    updated_at: now,
  });
  const [defaultRole] = await db.select({ id: roles.id }).from(roles)
    .where(eq(roles.is_default, true)).limit(1);
  if (defaultRole) {
    await db.insert(userRoles).values({
      user_id: userId,
      role_id: defaultRole.id,
    }).onConflictDoNothing();
  }
  return userId;
}

/**
 * 为用户签发 OAuth 登录会话：查询用户、签发 JWT 并记录登录审计。
 * @param userId 目标用户 ID
 * @returns 用户信息与 JWT token
 * @throws {NotFoundError} 用户不存在
 */
async function issueOAuthSession(
  userId: string,
): Promise<{ user: UserResponse; token: string }> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new NotFoundError("用户不存在");
  const roleRows = await db.select({ name: roles.name }).from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id)).where(
      eq(userRoles.user_id, userId),
    );
  const role = roleRows.find((item) => item.name === "admin")?.name || "user";
  const token = await signToken({
    sub: userId,
    role,
    must_change_password: user.must_change_password,
  });
  await logAuthEvent(userId, "oauth", "auth.login_success", {
    user_id: userId,
    login: "oauth",
  });
  return {
    user: toUserResponse(user, { isAdmin: await isUserAdmin(userId) }),
    token,
  };
}

/** 将 OAuth 身份解析为现有用户、绑定关系或新用户会话。 */
export async function resolveOAuthIdentity(
  provider: OAuthProviderId,
  identity: OAuthIdentity,
  intent: OAuthIntent,
  linkUserId?: string,
): Promise<{ user: UserResponse; token: string; linked: boolean }> {
  const db = getDb();
  const [linked] = await db.select().from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.provider_user_id, identity.providerUserId),
      ),
    ).limit(1);

  if (intent === "link") {
    if (!linkUserId) {
      throw new BadRequestError("绑定目标用户无效", "AUTH_REQUIRED");
    }
    if (linked && linked.user_id !== linkUserId) {
      throw new ConflictError("该第三方账号已绑定其他用户");
    }
    if (!linked) {
      await db.insert(oauthAccounts).values({
        id: crypto.randomUUID(),
        provider,
        provider_user_id: identity.providerUserId,
        user_id: linkUserId,
        provider_username: identity.username ?? null,
        provider_email: identity.email ?? null,
        email_verified: identity.emailVerified,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    return { ...(await issueOAuthSession(linkUserId)), linked: true };
  }

  let userId = linked?.user_id;
  if (!userId && identity.emailVerified && identity.email) {
    const [emailUser] = await db.select({ id: users.id }).from(users).where(
      eq(users.email, identity.email),
    ).limit(1);
    userId = emailUser?.id;
    if (userId) {
      await db.insert(oauthAccounts).values({
        id: crypto.randomUUID(),
        provider,
        provider_user_id: identity.providerUserId,
        user_id: userId,
        provider_username: identity.username ?? null,
        provider_email: identity.email,
        email_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).onConflictDoNothing();
    }
  }
  if (!userId) {
    userId = await createOAuthUser(provider, identity);
    await db.insert(oauthAccounts).values({
      id: crypto.randomUUID(),
      provider,
      provider_user_id: identity.providerUserId,
      user_id: userId,
      provider_username: identity.username ?? null,
      provider_email: identity.email ?? null,
      email_verified: identity.emailVerified,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return { ...(await issueOAuthSession(userId)), linked: false };
}

/** 返回给设置页的已绑定 OAuth 账号信息。 */
export interface LinkedOAuthAccount {
  id: string;
  provider: OAuthProviderId;
  provider_user_id: string;
  provider_username: string | null;
  created_at: string;
}

/** 脱敏外部用户 ID：仅保留末 4 位，其余以 `****` 代替。 */
function maskProviderUserId(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

/** 查询用户已绑定的 OAuth 账号，并脱敏外部用户 ID。 */
export async function listLinkedOAuthAccounts(
  userId: string,
): Promise<LinkedOAuthAccount[]> {
  const db = getDb();
  const rows = await db.select({
    id: oauthAccounts.id,
    provider: oauthAccounts.provider,
    provider_user_id: oauthAccounts.provider_user_id,
    provider_username: oauthAccounts.provider_username,
    created_at: oauthAccounts.created_at,
  }).from(oauthAccounts).where(eq(oauthAccounts.user_id, userId));
  return rows.map((row) => ({
    ...row,
    provider: row.provider as OAuthProviderId,
    provider_user_id: maskProviderUserId(row.provider_user_id),
  }));
}

/** 删除当前用户的一条 OAuth 绑定，并保护最后一个登录方式。 */
export async function unlinkOAuthAccount(
  userId: string,
  accountId: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [account] = await tx.select().from(oauthAccounts)
      .where(
        and(eq(oauthAccounts.id, accountId), eq(oauthAccounts.user_id, userId)),
      ).limit(1);
    if (!account) throw new NotFoundError("第三方账号绑定不存在");
    const [user] = await tx.select({ password_hash: users.password_hash }).from(
      users,
    ).where(eq(users.id, userId)).limit(1);
    const others = await tx.select({ id: oauthAccounts.id }).from(oauthAccounts)
      .where(eq(oauthAccounts.user_id, userId));
    if (!user?.password_hash && others.length <= 1) {
      throw new BadRequestError("不能解绑唯一的登录方式", "LAST_LOGIN_METHOD");
    }
    await tx.delete(oauthAccounts).where(eq(oauthAccounts.id, accountId));
  });
}

/** 校验绑定操作提供的本地密码是否与当前用户匹配。 */
export async function linkPasswordMatches(
  userId: string,
  password: string,
): Promise<void> {
  const db = getDb();
  const [user] = await db.select({ password_hash: users.password_hash }).from(
    users,
  ).where(eq(users.id, userId)).limit(1);
  if (!user?.password_hash) return;
  const { comparePassword } = await import("../../../lib/password.ts");
  if (!(await comparePassword(password, user.password_hash))) {
    throw new BadRequestError("密码确认失败", "PASSWORD_CONFIRMATION_FAILED");
  }
}
