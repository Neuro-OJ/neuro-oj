import { getSetting } from "../services/system-settings.ts";
import { Hono } from "hono";
import announcements from "./announcements.ts";
import carousel from "./carousel.ts";
import emailDelivery from "./email-delivery.ts";

/**
 * 读取公开法务设置文本。
 *
 * 兼容链：新键 → 旧键别名（`data_policy_*`，2026-09-25 评审加入）。旧 env 名在
 * 升级后仍被读取，避免"迁移了 DB 行、却让 .env.prod 里的旧配置静默失效"。
 *
 * @param key 新设置键
 * @param legacyKey 旧设置键（可选）
 * @returns 文本值；两者皆空返回空串
 */
function publicLegalText(key: string, legacyKey?: string): string {
  const value = String(getSetting(key)?.value ?? "");
  if (value) return value;
  return legacyKey ? String(getSetting(legacyKey)?.value ?? "") : "";
}

/** system 域公开路由，挂载到 `/api/v1`。 */
export const systemRouter = new Hono();
systemRouter.route("/announcements", announcements);
systemRouter.route("/carousel", carousel);
systemRouter.route("/", emailDelivery);
// 明确白名单，禁止将完整系统设置暴露给匿名访客。
// 2026-09-23：改读 legal_* 键（data_policy_* 已迁移），响应结构保持兼容。
// 2026-09-25 评审：`deployment` 恢复为"部署补充说明"（此前误取处理者名称）。
systemRouter.get("/data-policy", (c) =>
  c.json({
    data: {
      contact: publicLegalText("legal_contact", "data_policy_contact"),
      deployment: publicLegalText(
        "legal_deployment_notes",
        "data_policy_deployment",
      ),
    },
  }));

/**
 * 站点元信息（公开）：备案信息、第三方服务清单与个人信息处理者。
 *
 * 供页脚展示备案、政策页展示处理者与第三方清单。全部为公开展示字段，
 * 不含敏感值（`tsa_root_cert` 等 secret 项绝不在此暴露）。
 * GET /api/v1/site/meta
 */
systemRouter.get("/site/meta", (c) =>
  c.json({
    data: {
      icp_number: String(getSetting("legal_icp_number")?.value ?? ""),
      icp_url: String(getSetting("legal_icp_url")?.value ?? ""),
      police_number: String(getSetting("legal_police_number")?.value ?? ""),
      police_url: String(getSetting("legal_police_url")?.value ?? ""),
      third_parties: String(getSetting("legal_third_parties")?.value ?? ""),
      operator_name: String(getSetting("legal_operator_name")?.value ?? ""),
      contact: publicLegalText("legal_contact", "data_policy_contact"),
      deployment_notes: publicLegalText(
        "legal_deployment_notes",
        "data_policy_deployment",
      ),
    },
  }));
