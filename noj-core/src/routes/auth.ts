import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import {
  getUserProfile,
  loginUser,
  promoteUser,
  registerUser,
} from "../services/auth.ts";
import { ValidationError } from "../lib/errors.ts";
import { parseJsonBody } from "../lib/request.ts";
import type { LoginInput, RegisterInput } from "../types/auth.ts";

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
 */
auth.post("/login", async (c) => {
  const body = await parseJsonBody<LoginInput>(c);

  // 验证必填字段
  if (!body.login || !body.password) {
    throw new ValidationError("缺少必填字段：login, password");
  }

  const result = await loginUser(body);
  return c.json({ data: result }, 200);
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
 * 管理员用户管理路由。
 * 需要 authMiddleware + adminMiddleware 双重保护。
 */
const adminAuth = new Hono<
  { Variables: { userId: string; userRole: string } }
>();

/**
 * 管理员提升/降级用户角色。
 * PATCH /api/v1/admin/users/:id/role
 */
adminAuth.patch(
  "/users/:id/role",
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const targetUserId = c.req.param("id") as string;
    const body = await parseJsonBody<{ role: string }>(c);

    if (!body.role) {
      throw new ValidationError("缺少必填字段：role");
    }

    const user = await promoteUser(targetUserId, body.role);
    return c.json({ data: user }, 200);
  },
);

export { adminAuth };
export default auth;
