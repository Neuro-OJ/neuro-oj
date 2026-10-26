/// <reference lib="dom" />
/**
 * 统一搜索 UI E2E（Task 6）。
 *
 * 覆盖：
 * - 命令面板（SearchPalette）分组展示
 * - /search 全部 Tab 分组展示
 * - /search 单类型 Tab 激活态
 * - /search Tab 切换 URL 同步
 *
 * 运行前置（完整栈）：
 *   - noj-core（E2E_BASE_URL，默认 :8099）
 *   - noj-ui 已构建并监听 E2E_UI_URL（默认 :3000）
 *   - Playwright 浏览器：`deno run -A npm:playwright install chromium`
 *
 * 启用：NOJ_RUN_BROWSER_E2E=1 deno task test:browser
 */

import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import {
  api,
  BASE_URL,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";
import {
  assertClassContains,
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
} from "./browser.ts";

// 每轮创建独立公开题，避免其他 E2E 的进行中比赛使种子题依法保密。
const QUERY = `uisearch${Date.now().toString(36)}`;
const TITLE = `${QUERY} 独立公开搜索题`;
let problemNumber = 0;

async function prepareSearchFixture(): Promise<void> {
  const username = `search_editor_${Date.now().toString(36)}`;
  const email = `${username}@test.com`;
  const editor = await registerUser(username, email, TEST_PASSWORD);
  const admin = await getAdminToken();
  const invitation = await api("POST", "/api/v1/domains/main/invitations", {
    token: admin,
    body: { email },
  });
  assertEquals(invitation.status, 201);
  const joined = await api("POST", "/api/v1/domain-invitations/accept", {
    token: editor,
    body: {
      token: (invitation.body as { data: { token: string } }).data.token,
    },
  });
  assertEquals(joined.status, 200);
  const identity = await api("GET", "/api/v1/auth/me", { token: editor });
  assertEquals(identity.status, 200);
  const userId = (identity.body as { data: { id: string } }).data.id;
  const granted = await api(
    "PUT",
    `/api/v1/domains/main/members/${userId}/roles`,
    {
      token: admin,
      body: { roles: ["editor"] },
    },
  );
  assertEquals(granted.status, 200);
  const bytes = zipSync({
    "problem.json": strToU8(JSON.stringify({
      format_version: 2,
      title: TITLE,
      difficulty: "easy",
      judge_type: "dual",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 10000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      },
    })),
    "statement.md": strToU8("# 独立公开搜索题\n由当前域编辑者导入并显式发布。"),
    "evaluate.py": strToU8(
      "from noj_evaluator_sdk import result\nresult.accept(score=10)\n",
    ),
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
    "search.zip",
  );
  const imported = await fetch(
    `${BASE_URL}/api/v1/domains/main/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${editor}` },
      body: form,
    },
  );
  const response = await imported.json();
  assertEquals(imported.status, 201, JSON.stringify(response));
  const problem = response.data as {
    problem_id: string;
    number: number;
    draft_revision: number;
  };
  problemNumber = problem.number;
  const published = await api(
    "POST",
    `/api/v1/domains/main/problems/${problem.number}/publish`,
    {
      token: editor,
      headers: { "If-Match": String(problem.draft_revision) },
      body: { change_note: "浏览器搜索独立公开版本" },
    },
  );
  assertEquals(published.status, 200, JSON.stringify(published.body));
  // 等待正常持久事件更新索引，不直接刷新或写入搜索表。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const indexed = await api("GET", `/api/v1/search?q=${QUERY}&type=problem`);
    assertEquals(indexed.status, 200);
    const items =
      (indexed.body as { data: { items: { entity_id: string }[] } }).data.items;
    if (items.some((item) => item.entity_id === problem.problem_id)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`独立公开题 ${problem.number} 未在30秒内进入搜索索引`);
}

Deno.test("[ui/browser] 统一搜索：命令面板显示分组结果", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  const session = await launchBrowser();
  let failed = true;
  try {
    await prepareSearchFixture();
    await gotoPage(session.page, "/");
    await session.page.waitForFunction(() =>
      !!(document.querySelector("#__nuxt") as Element & {
        __vue_app__?: unknown;
      })?.__vue_app__
    );
    // 等待默认布局挂载完成后再触发全局 Ctrl+K
    await session.page.locator('button[aria-label*="搜索题目"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await session.page.keyboard.press("Control+K");
    const input = session.page.getByPlaceholder(/搜索题目/);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill(QUERY);
    // 分组标题“题目”比结果项更早出现；命令面板内无 Tab 按钮，因此首条即分组标题。
    const groupHeader = session.page
      .locator("div.text-xs.text-text-muted.font-medium", { hasText: /^题目$/ })
      .first();
    await groupHeader.waitFor({ state: "visible", timeout: 15_000 });
    await session.page.getByRole("option").filter({ hasText: TITLE }).waitFor({
      timeout: 15_000,
    });
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "search");
  }
});

Deno.test("[ui/browser] 统一搜索：/search 全部 Tab 显示分组", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  const session = await launchBrowser();
  let failed = true;
  try {
    await gotoPage(session.page, `/search?q=${QUERY}&type=all`);
    const allTab = session.page.getByRole("button", {
      name: "全部",
      exact: true,
    });
    await allTab.waitFor({ state: "visible", timeout: 15_000 });
    await assertClassContains(allTab, "border-signal", "「全部」Tab");
    // /search 页存在 Tab 按钮也包含“题目”文本，因此用分组标题的精确 class 定位。
    const groupHeader = session.page
      .locator("span.text-sm.font-medium.text-text", { hasText: /^题目$/ })
      .first();
    await groupHeader.waitFor({ state: "visible", timeout: 15_000 });
    await session.page.getByRole("option").filter({ hasText: TITLE }).waitFor({
      timeout: 15_000,
    });
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "search");
  }
});

Deno.test("[ui/browser] 统一搜索：单类型 Tab 并同步 URL", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  const session = await launchBrowser();
  let failed = true;
  try {
    await gotoPage(session.page, `/search?q=${QUERY}&type=problem`);
    const problemTab = session.page.getByRole("button", {
      name: "题目",
      exact: true,
    });
    await problemTab.waitFor({ state: "visible", timeout: 15_000 });
    await assertClassContains(problemTab, "border-signal", "「题目」Tab");

    // 等待单类型结果出现。分页行为由后端路由/服务测试覆盖；
    // 当前文件只有一份独立题目，因此不在浏览器 E2E 中断言多页。
    const problemResult = session.page.getByRole("option").filter({
      hasText: TITLE,
    });
    await problemResult.waitFor({ state: "visible", timeout: 15_000 });

    // URL 同步：切换到“全部”后，地址栏 type 应更新为 all。
    await session.page.getByRole("button", { name: "全部", exact: true })
      .click();
    await session.page.waitForURL(
      (u) =>
        u.pathname === "/search" &&
        u.searchParams.get("q") === QUERY &&
        u.searchParams.get("type") === "all",
      { timeout: 15_000 },
    );
    const allTab = session.page.getByRole("button", {
      name: "全部",
      exact: true,
    });
    await assertClassContains(allTab, "border-signal", "切换后的「全部」Tab");
    await session.page.getByRole("option").filter({ hasText: TITLE }).click();
    await session.page.waitForURL(
      (url) => url.pathname === `/d/main/problems/${problemNumber}`,
      {
        timeout: 15_000,
      },
    );
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "search");
  }
});
