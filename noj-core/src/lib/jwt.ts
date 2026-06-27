import { type JWTPayload, jwtVerify, SignJWT } from "jose";

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
 * 临时凭证被滥用。true 时 token 已强制更新为新密码，但**旧 token 仍有效
 * 至自然过期**（依赖前端清 Cookie 重登）。
 */
export interface TokenPayload {
  /** 用户 ID */
  sub: string;
  /** 用户角色 */
  role: string;
  /** 是否必须修改密码（issue #75） */
  must_change_password?: boolean;
  /** JWT 唯一标识（用于未来实现 token 黑名单/撤销） */
  jti?: string;
}

/**
 * 签发 JWT。
 *
 * @param payload - 包含用户 ID (sub) 和角色 (role) 的负载
 * @returns 签名的 JWT 字符串
 */
export async function signToken(
  payload: TokenPayload,
): Promise<string> {
  const secret = getSecretKey();
  const expiresIn = Deno.env.get("JWT_EXPIRES_IN") || "24h";
  const jti = payload.jti ?? crypto.randomUUID();

  const token = await new SignJWT({
    role: payload.role,
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
 * jti 字段透传以便上层实现黑名单机制（当前未启用，需配合 Redis 存储）。
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
  });

  return {
    sub: payload.sub as string,
    role: payload.role as string,
    // 旧 token 无该字段，缺省视为 false
    must_change_password: (payload.must_change_password as boolean) ?? false,
    jti: payload.jti,
  };
}
