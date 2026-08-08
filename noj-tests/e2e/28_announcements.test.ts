/**
 * 公告系统 E2E 集成测试（issue #231）。
 *
 * 覆盖验收标准：
 * - admin 发布 → 公开列表/首页可见（置顶优先）→ 下架消失
 * - 非 admin 无写权限（403）
 * - 置顶排序生效
 * - SSE announcement:updated 广播
 */

import {
  api,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  waitForServer,
} from "./helper.ts";

// 读取 SSE 流的前几个事件，带超时
async function readSSEEvents(
  url: string,
  token: string,
  maxEvents: number,
  timeoutMs = 15000,
): Promise<string[]> {
  const events: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    });
    if (!res.ok) {
      clearTimeout(timer);
      return events;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return events;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          events.push(trimmed.slice(6).trim());
        }
      }
    }
    controller.abort();
    clearTimeout(timer);
    return events;
  } catch {
    clearTimeout(timer);
    return events;
  }
}

let adminToken = "";
let userToken = "";
const ts = Date.now().toString(36);
let pinnedId = "";
let normalId = "";

e2eTest("[e2e/announcements] Setup: 管理员与普通用户就绪", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  userToken = await registerUser(
    `ann_user_${ts}`,
    `ann_user_${ts}@e2e.com`,
    "TestPass1234",
  );
  console.log("  ✓ 公告 E2E 用户就绪");
});

e2eTest(
  "[e2e/announcements] 1. admin 发布公告 → 公开列表可见（置顶优先）",
  async () => {
    if (!isE2E) return;
    // 先创建普通公告，再创建置顶公告（置顶较新，验证置顶优先而非时间优先）
    const normal = await apiPost(
      "/api/v1/admin/announcements",
      { title: `普通公告-${ts}`, content: "普通公告正文" },
      adminToken,
    );
    if (normal.status !== 201) {
      throw new Error(`创建普通公告失败: ${JSON.stringify(normal.body)}`);
    }
    normalId = (normal.body as { data: { id: string } }).data.id;

    const pinned = await apiPost(
      "/api/v1/admin/announcements",
      { title: `置顶公告-${ts}`, content: "置顶公告正文", is_pinned: true },
      adminToken,
    );
    if (pinned.status !== 201) {
      throw new Error(`创建置顶公告失败: ${JSON.stringify(pinned.body)}`);
    }
    pinnedId = (pinned.body as { data: { id: string } }).data.id;

    // 公开列表：置顶优先 + 不含 content 全文
    const listRes = await apiGet("/api/v1/announcements");
    if (listRes.status !== 200) {
      throw new Error(`公开列表失败: ${JSON.stringify(listRes.body)}`);
    }
    const list = listRes.body as {
      data: Array<
        { id: string; title: string; is_pinned: boolean; excerpt?: string }
      >;
      meta: { total: number };
    };
    if (list.data[0].id !== pinnedId) {
      throw new Error("置顶公告应排在第一位");
    }
    if (list.data[0].is_pinned !== true) {
      throw new Error("第一条应为置顶公告");
    }
    if (list.data.some((a) => a.id === normalId) !== true) {
      throw new Error("普通公告应可见");
    }
    if ("content" in list.data[0]) {
      throw new Error("公开列表不应包含 content 全文");
    }

    // 详情可读全文
    const detailRes = await apiGet(`/api/v1/announcements/${pinnedId}`);
    const detail = detailRes.body as { content?: string; title?: string };
    if (detailRes.status !== 200 || detail.content !== "置顶公告正文") {
      throw new Error(`详情应返回全文: ${JSON.stringify(detailRes.body)}`);
    }
    console.log("  ✓ admin 发布 → 公开可见 + 置顶优先");
  },
);

e2eTest("[e2e/announcements] 2. 非 admin 无写权限", async () => {
  if (!isE2E) return;
  const res = await apiPost(
    "/api/v1/admin/announcements",
    { title: "越权", content: "x" },
    userToken,
  );
  if (res.status !== 403) {
    throw new Error(`普通用户写入应 403，实际 ${res.status}`);
  }
  console.log("  ✓ 非 admin 写操作 403");
});

e2eTest(
  "[e2e/announcements] 3. admin 下架 → 公开列表消失 + 详情 404",
  async () => {
    if (!isE2E) return;
    // 下架置顶公告
    const unpublish = await apiPut(
      `/api/v1/admin/announcements/${pinnedId}`,
      { is_active: false },
      adminToken,
    );
    if (unpublish.status !== 200) {
      throw new Error(`下架失败: ${JSON.stringify(unpublish.body)}`);
    }

    const listRes = await apiGet("/api/v1/announcements");
    const list = listRes.body as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    if (list.data.some((a) => a.id === pinnedId)) {
      throw new Error("下架公告不应出现在公开列表");
    }
    if (list.data[0].id !== normalId) {
      throw new Error("剩余公告应正常展示");
    }

    const detailRes = await apiGet(`/api/v1/announcements/${pinnedId}`);
    if (detailRes.status !== 404) {
      throw new Error(`下架公告详情应 404，实际 ${detailRes.status}`);
    }

    // 管理列表仍可见（含已下架）
    const adminList = await apiGet("/api/v1/admin/announcements", adminToken);
    const adminData = adminList.body as {
      data: Array<{ id: string; is_active: boolean }>;
    };
    const found = adminData.data.find((a) => a.id === pinnedId);
    if (!found || found.is_active !== false) {
      throw new Error("管理列表应包含已下架公告");
    }
    console.log("  ✓ 下架 → 公开消失 + 管理可见");
  },
);

e2eTest("[e2e/announcements] 4. SSE 广播 announcement:updated", async () => {
  if (!isE2E) return;
  // 并行：连接 SSE 读取事件 + 触发公告更新
  const eventPromise = readSSEEvents(
    `${BASE_URL}/api/v1/announcements/events`,
    adminToken,
    1,
    15000,
  );
  // 等待连接建立后触发更新（重新发布置顶公告）
  await new Promise((r) => setTimeout(r, 1500));
  await apiPut(
    `/api/v1/admin/announcements/${pinnedId}`,
    { is_active: true, is_pinned: true },
    adminToken,
  );
  const events = await eventPromise;
  if (!events.includes("announcement:updated")) {
    throw new Error(
      `未收到 announcement:updated，实际事件: ${events.join(", ")}`,
    );
  }
  console.log("  ✓ SSE announcement:updated 广播");
});

e2eTest("[e2e/announcements] Cleanup: 删除公告", async () => {
  if (!isE2E) return;
  if (pinnedId) {
    await apiDelete(`/api/v1/admin/announcements/${pinnedId}`, adminToken);
  }
  if (normalId) {
    await apiDelete(`/api/v1/admin/announcements/${normalId}`, adminToken);
  }
  console.log("  ✓ 公告清理完成");
});
