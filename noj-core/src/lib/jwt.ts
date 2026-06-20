import { type JWTPayload, jwtVerify, SignJWT } from "jose";

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
 */
export interface TokenPayload {
  /** 用户 ID */
  sub: string;
  /** 用户角色 */
  role: string;
}

/**
 * 签发 JWT。
 * @param payload - 包含用户 ID (sub) 和角色 (role) 的负载
 * @returns 签名的 JWT 字符串
 */
export async function signToken(
  payload: TokenPayload,
): Promise<string> {
  const secret = getSecretKey();
  const expiresIn = Deno.env.get("JWT_EXPIRES_IN") || "24h";

  const token = await new SignJWT(payload as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);

  return token;
}

/**
 * 验证 JWT 并返回负载。
 * @param token - JWT 字符串
 * @returns 解码后的负载（含 sub 和 role）
 * @throws 令牌无效或已过期时抛出错误
 */
export async function verifyToken(
  token: string,
): Promise<TokenPayload> {
  const secret = getSecretKey();

  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub as string,
    role: payload.role as string,
  };
}
