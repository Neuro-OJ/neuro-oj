import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../modules/access/index.ts";
import { BadRequestError } from "../../shared/base/errors.ts";
import {
  parseByokInput,
  readByok,
  removeByok,
  saveByok,
  testByok,
} from "./service.ts";

/** 用户自带模型（BYOK）路由，挂在 `/api/v1` 下；只操作本人数据。 */
export const byokRouter = new Hono<AuthEnv>();
const prefix = "/me/llm-provider";

function parseRevision(header: string | undefined): number {
  const raw = (header ?? "").replace(/^"|"$/g, "");
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(
      "If-Match 必须是自带模型的 revision（新建为 0）",
      "REVISION_REQUIRED",
    );
  }
  return Number(raw);
}

/**
 * 读取本人自带模型与实例开关。
 * GET /api/v1/me/llm-provider
 * 响应：`{ data: { enabled, allowed_hosts, provider | null } }`（Key 仅掩码）
 */
byokRouter.get(prefix, authMiddleware, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ data: await readByok(c.var.userId as string) });
});

/**
 * 创建或更新本人自带模型。
 * PUT /api/v1/me/llm-provider
 * header: `If-Match: <revision>`（新建为 0）
 * body: `{ base_url, model, api_key?, enabled? }`；更新时省略 api_key 即保留原 Key
 */
byokRouter.put(prefix, authMiddleware, async (c) => {
  const revision = parseRevision(c.req.header("If-Match"));
  const input = parseByokInput(await c.req.json().catch(() => null));
  const provider = await saveByok(c.var.userId as string, input, revision);
  return c.json({ data: provider }, revision === 0 ? 201 : 200);
});

/**
 * 删除本人自带模型（含加密 Key，不可恢复）。
 * DELETE /api/v1/me/llm-provider
 */
byokRouter.delete(prefix, authMiddleware, async (c) => {
  await removeByok(c.var.userId as string);
  return c.body(null, 204);
});

/**
 * 测试本人自带模型连通性（真实请求 max_tokens=1，费用由用户承担）。
 * POST /api/v1/me/llm-provider/test
 * 响应：`{ data: { status: "ok" | "failed", code?, message? } }`
 */
byokRouter.post(`${prefix}/test`, authMiddleware, async (c) => {
  return c.json({ data: await testByok(c.var.userId as string) });
});
