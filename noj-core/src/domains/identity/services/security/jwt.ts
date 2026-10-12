import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { getSetting } from "../../../system/index.ts";

/**
 * JWT 签发者与接收者标识。
 *
 * - iss: 标识 token 由 noj-core 签发，防止其他服务的 token 被误用
 * - aud: 标识 token 仅供 noj-ui 消费，跨服务 token 验证失败
 *
 * 多服务部署时需确保 issuer 与 audience 配置与本模块一致。
 */
const JWT_ISSUER = "noj-core";
const JWT_AUDIENCE = "noj-ui";

/**
 * 获取 JWT 签名密钥。
 * 从环境变量 `JWT_SECRET` 读取，未设置时抛出错误。
 */
function getSecretKey(): Uint8Array {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) {
    throw new Error("环境变量 JWT_SECRET 未设置，无法签发 JWT");
  }
  return new TextEncoder().encode(secret);
}

/**
 * JWT 负载中包含的用户信息。
 *
 * must_change_password（issue #75）：当用户密码为临时凭证（如引导管理员）
 * 时，登录后必须修改密码。authMiddleware 据此拦截非白名单请求，避免
 * 临时凭证被滥用。session_version 与数据库实时比较，凭据变更后旧会话失效。
 */
export interface TokenPayload {
  /** 用户 ID */
  sub: string;
  /** 用户角色名（仅展示/审计，权限判定实时查询权限集，不依赖此字段） */
  role: string;
  /** 是否必须修改密码（issue #75） */
  must_change_password?: boolean;
  /** 签发时的用户会话版本；历史令牌缺省为 0。 */
  session_version?: number;
  /** JWT 唯一标识（用于单会话黑名单/撤销） */
  jti?: string;
  /** 过期时间（Unix 秒）；仅 verifyToken 返回，签发时忽略 */
  exp?: number;
}

/**
 * 签发选项。
 *
 * - remember：「记住我」登录，改用 `jwt_remember_expires_in`（默认 30d）
 * - expiresAt：沿用指定的绝对过期时间（Unix 秒），用于改密换发新 token 时
 *   保持原会话时长，优先级高于 remember
 */
export interface SignTokenOptions {
  remember?: boolean;
  expiresAt?: number;
}

/** 读取字符串类型的时长设置，缺失或为空时回退默认值。 */
function readDurationSetting(key: string, fallback: string): string {
  const setting = getSetting(key);
  return typeof setting?.value === "string" && setting.value.length > 0
    ? setting.value
    : fallback;
}

/**
 * 签发 JWT。
 *
 * @param payload - 包含用户 ID (sub) 和角色 (role) 的负载
 * @param options - 有效期选项（记住我 / 沿用原过期时间）
 * @returns 签名的 JWT 字符串
 */
export async function signToken(
  payload: TokenPayload,
  options: SignTokenOptions = {},
): Promise<string> {
  const secret = getSecretKey();
  const expiresIn: string | number = options.expiresAt ??
    (options.remember
      ? readDurationSetting("jwt_remember_expires_in", "30d")
      : readDurationSetting("jwt_expires_in", "24h"));
  const jti = payload.jti ?? crypto.randomUUID();

  const token = await new SignJWT({
    role: payload.role,
    session_version: payload.session_version ?? 0,
    // 仅写入存在的字段，避免向 token 注入 undefined
    ...(payload.must_change_password !== undefined && {
      must_change_password: payload.must_change_password,
    }),
    jti,
  } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(payload.sub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);

  return token;
}

/**
 * 验证 JWT 并返回负载。
 *
 * 校验 issuer 与 audience 防止跨服务 token 误用。
 * jti 字段供上层校验 Redis 黑名单，session_version 供上层校验用户会话版本。
 * must_change_password 缺省时视为 false（向旧 token 兼容）。
 *
 * @param token - JWT 字符串
 * @returns 解码后的负载（含 sub、role、jti、must_change_password）
 * @throws 令牌无效或已过期时抛出错误
 */
export async function verifyToken(
  token: string,
): Promise<TokenPayload> {
  const secret = getSecretKey();

  const { payload } = await jwtVerify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    // 安全修复 NOJ-000：固定仅接受 HS256，拒绝 HS384/HS512 等算法混淆。
    algorithms: ["HS256"],
  });

  // 仅缺省字段兼容历史令牌，拒绝负数、非整数或其他类型。
  const sessionVersion = payload.session_version === undefined
    ? 0
    : payload.session_version;
  if (
    typeof sessionVersion !== "number" ||
    !Number.isSafeInteger(sessionVersion) || sessionVersion < 0
  ) {
    throw new Error("认证令牌会话版本无效");
  }

  return {
    sub: payload.sub as string,
    role: payload.role as string,
    session_version: sessionVersion,
    // 旧 token 无 must_change_password 字段，缺省视为 false
    must_change_password: (payload.must_change_password as boolean) ?? false,
    jti: payload.jti,
    exp: payload.exp,
  };
}
