/**
 * 旧的无域自测路由（`/problems/:id/self-test*`、`/self-tests/:id`）已删除，
 * 自测只经使用域入口 `/domains/:slug/...` 提供（见 `domain-submissions.ts`）。
 */
import { Hono } from "hono";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";

const router = new Hono<AuthEnv>();

export default router;
