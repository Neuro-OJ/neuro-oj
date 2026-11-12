/**
 * 知识图谱只读 HTTP API（挂在 `/api/v1`）。
 *
 * - `GET /knowledge/graph`：整图（激活包 + active 领域/节点/前置）；
 * - `GET /knowledge/nodes/:id`：单点详情（requires / dependents）。
 *
 * 公开读：与其他列表接口一致使用可选鉴权（实例访问政策中间件在
 * `/api/v1/*` 全局生效）。`knowledge_enabled = false` 时两个接口都返回 404
 * `KNOWLEDGE_DISABLED`；开关每次请求经 `getSetting()` 读取，不走本模块缓存。
 */
import { Hono } from "hono";
import { optionalAuthMiddleware } from "../../modules/access/index.ts";
import { getSetting } from "../../modules/platform/index.ts";
import { AppError } from "../../shared/base/errors.ts";
import type { AuthEnv } from "../../shared/http/hono-env.ts";
import { readKnowledgeGraph, readKnowledgeNode } from "./graph.ts";

export const knowledgeRouter = new Hono<AuthEnv>();

/** 关闭提示：与 NotFoundError 同状态码，但使用专用错误码便于前端区分。 */
class KnowledgeDisabledError extends AppError {
  constructor() {
    super("知识图谱功能已关闭", 404, "KNOWLEDGE_DISABLED");
    this.name = "KnowledgeDisabledError";
  }
}

function assertEnabled(): void {
  if (getSetting("knowledge_enabled")?.value !== true) {
    throw new KnowledgeDisabledError();
  }
}

knowledgeRouter.get("/knowledge/graph", optionalAuthMiddleware, async (c) => {
  assertEnabled();
  return c.json({ data: await readKnowledgeGraph() });
});

knowledgeRouter.get(
  "/knowledge/nodes/:id",
  optionalAuthMiddleware,
  async (c) => {
    assertEnabled();
    return c.json({ data: await readKnowledgeNode(c.req.param("id")!) });
  },
);
