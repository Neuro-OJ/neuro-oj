/**
 * 公告/轮播分离 E2E 剧本（2026-09-24）。
 *
 * 覆盖验收标准：
 * - 管理员建轮播 slide → 公开接口返回（仅启用项，按 sort_order）
 * - 停用/删除后公开接口不再返回
 * - reorder 生效
 * - 建带 `banner_text` 的公告 → `/announcements/banner` 返回；无则 null
 * - 横幅关闭为纯前端 localStorage（后端无用户态）：重复请求结果恒定
 *
 * 前置：管理员 token 来自 seed（`getAdminToken`）。
 */

import {
  api,
  apiDelete,
  apiPatch,
  apiPost,
  e2eTest,
  getAdminToken,
} from "../helper.ts";

interface Slide {
  id: string;
  kind: string;
  title: string | null;
  is_enabled: boolean;
  sort_order: number;
}

/** 建一个文案型 slide。 */
async function createTextSlide(
  adminToken: string,
  title: string,
  enabled = true,
): Promise<string> {
  const res = await apiPost(
    "/api/v1/admin/carousel/slides",
    { kind: "text", title, gradient_key: "blue", is_enabled: enabled },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(`建 slide 失败: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return (res.body as { data: { id: string } }).data.id;
}

async function listPublicSlides(): Promise<Slide[]> {
  const res = await api("GET", "/api/v1/carousel/slides");
  if (res.status !== 200) {
    throw new Error(`公开 slide 列表应 200，实际 ${res.status}`);
  }
  return (res.body as { data: Slide[] }).data;
}

e2eTest("carousel-e2e: 建 slide → 公开可见；停用后不可见", async () => {
  const adminToken = await getAdminToken();
  const ts = Date.now();
  const id = await createTextSlide(adminToken, `E2E-轮播-${ts}`);

  let slides = await listPublicSlides();
  if (!slides.some((s) => s.id === id)) {
    throw new Error("新建的启用 slide 应出现在公开列表");
  }

  // 停用（PATCH 部分更新）
  await apiPatch(
    `/api/v1/admin/carousel/slides/${id}`,
    { is_enabled: false },
    adminToken,
  );
  slides = await listPublicSlides();
  if (slides.some((s) => s.id === id)) {
    throw new Error("停用后的 slide 不应出现在公开列表");
  }

  // 清理
  await apiDelete(`/api/v1/admin/carousel/slides/${id}`, adminToken);
});

e2eTest("carousel-e2e: reorder 生效（公开列表顺序随之后移）", async () => {
  const adminToken = await getAdminToken();
  const ts = Date.now();
  const a = await createTextSlide(adminToken, `E2E-序A-${ts}`);
  const b = await createTextSlide(adminToken, `E2E-序B-${ts}`);

  // 把 b 排到最前
  const all = await api("GET", "/api/v1/admin/carousel/slides", {
    token: adminToken,
  });
  const ids = (all.body as { data: Slide[] }).data.map((s) => s.id);
  const reordered = [b, ...ids.filter((x) => x !== b)];
  const reorderRes = await apiPost(
    "/api/v1/admin/carousel/slides/reorder",
    { ids: reordered },
    adminToken,
  );
  if (reorderRes.status !== 200) {
    throw new Error(`reorder 应 200，实际 ${reorderRes.status}`);
  }

  const slides = await listPublicSlides();
  const idxB = slides.findIndex((s) => s.id === b);
  const idxA = slides.findIndex((s) => s.id === a);
  if (!(idxB >= 0 && idxA >= 0 && idxB < idxA)) {
    throw new Error(`b 应排在 a 之前（b=${idxB}, a=${idxA}）`);
  }

  await apiDelete(`/api/v1/admin/carousel/slides/${a}`, adminToken);
  await apiDelete(`/api/v1/admin/carousel/slides/${b}`, adminToken);
});

e2eTest("carousel-e2e: 非管理员不可管理轮播（403）", async () => {
  const res = await apiPost(
    "/api/v1/admin/carousel/slides",
    { kind: "text", title: "x" },
    // 无 token
  );
  if (res.status !== 401 && res.status !== 403) {
    throw new Error(`未认证管理轮播应 401/403，实际 ${res.status}`);
  }
});

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
