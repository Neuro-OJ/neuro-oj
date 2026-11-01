/**
 * 公告横幅 E2E 剧本（2026-09-24；轮播部分随 #698 下线删除）。
 *
 * 覆盖验收标准：
 * - 建带 `banner_text` 的公告 → `/announcements/banner` 返回；无则 null
 * - 横幅关闭为纯前端 localStorage（后端无用户态）：重复请求结果恒定
 *
 * 前置：管理员 token 来自 seed（`getAdminToken`）。
 */

import { api, apiDelete, apiPost, e2eTest, getAdminToken } from "../helper.ts";

e2eTest("announcement-e2e: /banner 返回最新带 banner_text 的公告", async () => {
  const adminToken = await getAdminToken();
  const ts = Date.now();

  const res = await apiPost(
    "/api/v1/admin/system/announcements",
    {
      title: `E2E-横幅-${ts}`,
      content: "正文",
      banner_text: `横幅文字-${ts}`,
    },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(`建公告失败: ${res.status}`);
  }
  const annId = (res.body as { data: { id: string } }).data.id;

  const banner = await api("GET", "/api/v1/announcements/banner");
  const data =
    (banner.body as { data: { id: string; banner_text: string } | null }).data;
  if (!data || data.id !== annId || data.banner_text !== `横幅文字-${ts}`) {
    throw new Error("/banner 应返回最新带横幅文字的公告");
  }

  // 横幅关闭为纯前端：后端无用户态，重复请求结果恒定
  const again = await api("GET", "/api/v1/announcements/banner");
  const data2 = (again.body as { data: { id: string } | null }).data;
  if (data2?.id !== annId) {
    throw new Error("横幅端点无用户态：重复请求应返回相同公告");
  }

  await apiDelete(`/api/v1/admin/system/announcements/${annId}`, adminToken);
});
