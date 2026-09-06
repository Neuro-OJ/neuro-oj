import { Hono } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import {
  clearEmailSuppression,
  listEmailSuppressions,
} from "../services/email-delivery/service.ts";

/** 管理端查看和解除坏地址抑制；地址仅以脱敏值展示。 */
const router = new Hono<AuthEnv>();

router.get("/email-delivery/suppressions", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? "100");
  return c.json({
    data: await listEmailSuppressions(
      Number.isFinite(rawLimit) ? rawLimit : 100,
    ),
  });
});

router.post("/email-delivery/suppressions/:id/clear", async (c) => {
  const cleared = await clearEmailSuppression(
    c.req.param("id"),
    c.get("userId"),
  );
  if (!cleared) throw new NotFoundError("抑制记录不存在或已经解除");
  return c.json({ data: { cleared: true } });
});

export default router;
