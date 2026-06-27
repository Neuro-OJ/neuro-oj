import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import {
  getUserProfile,
  listUsers,
  loginUser,
  promoteUser,
  registerUser,
} from "../services/auth.ts";
import { requestReset, resetPassword } from "../services/passwordReset.ts";
import { BadRequestError, ValidationError } from "../lib/errors.ts";
import { parseJsonBody } from "../lib/request.ts";
import {
  applyLoginBackoff,
  clearLoginFailure,
  isLoginLocked,
  recordLoginBackoff,
  recordLoginFailure,
} from "../lib/loginThrottle.ts";
import {
  checkLoginAccountRateLimit,
  LOGIN_LIMITS,
  loginIpRateLimit,
  throwRateLimited,
} from "../middleware/rateLimit.ts";
import { UnauthorizedError } from "../lib/errors.ts";
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from "../types/auth.ts";

const auth = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 用户注册端点。
 * POST /api/v1/auth/register
 */
auth.post("/register", async (c) => {
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
  if (body.password.length < 8) {
    throw new ValidationError("密码长度不能少于 8 位");
  }

  const user = await registerUser(body);
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
auth.post("/login", loginIpRateLimit(), async (c) => {
  const body = await parseJsonBody<LoginInput>(c);

  // 验证必填字段
  if (!body.login || !body.password) {
    throw new ValidationError("缺少必填字段：login, password");
  }

  // 1. 账号维度限流
  const accResult = await checkLoginAccountRateLimit(body.login);
  if (!accResult.allowed) {
    throwRateLimited(LOGIN_LIMITS.acc, accResult);
  }

  // 2. 内存退避：未到 deadline 则 sleep
  await applyLoginBackoff(body.login);

  // 3. 账号锁定检查
  if (await isLoginLocked(body.login)) {
    throw new UnauthorizedError("登录尝试过多，账号已临时锁定");
  }

  // 4. 验证
  try {
    const result = await loginUser(body);
    await clearLoginFailure(body.login);
    return c.json({ data: result }, 200);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // 5. 失败：记录（不阻塞响应）
      const failCount = await recordLoginFailure(body.login);
      await recordLoginBackoff(body.login, failCount);
    }
    throw err;
  }
});

/**
 * 获取当前用户信息端点。
 * GET /api/v1/auth/me
 * 需要 Bearer token 认证。
 */
auth.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const user = await getUserProfile(userId);
  return c.json({ data: user }, 200);
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

  // 应用基础 URL：从请求头 Host 拼出（生产环境后续接 APP_URL 环境变量）
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? "localhost:3000";
  const appBaseUrl = `${proto}://${host}`;

  await requestReset(body.email, appBaseUrl);

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

  await resetPassword(body.token, body.new_password);

  return c.json(
    {
      ok: true,
      message: "密码重置成功，请使用新密码登录",
    },
    200,
  );
});
export default auth;
