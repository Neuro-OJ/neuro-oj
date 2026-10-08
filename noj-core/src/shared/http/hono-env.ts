/**
 * Hono 路由共享 Env 类型。
 *
 * 从 middleware/auth.ts 抽出，供所有域路由统一引用，避免跨域深路径导入
 * identity 中间件。
 */

/** authMiddleware 注入的 Variables 类型（必有字段）。 */
export interface AuthEnv {
  Variables: {
    userId: string;
    userRole: string;
    mustChangePassword: boolean;
    emailVerified: boolean;
    jti?: string;
    /** 当前 token 的过期时间（Unix 秒），用于撤销 TTL 与改密换发 */
    tokenExp?: number;
  };
}

/** optionalAuthMiddleware 注入的 Variables 类型（可能 undefined）。 */
export interface OptionalAuthEnv {
  Variables: {
    userId?: string;
    userRole?: string;
    mustChangePassword?: boolean;
    emailVerified?: boolean;
    jti?: string;
    /** 当前 token 的过期时间（Unix 秒），用于撤销 TTL 与改密换发 */
    tokenExp?: number;
  };
}
