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

import {
  assertClassContains,
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
} from "./browser.ts";

// 使用 E2E 种子题 P1001 的稳定标识（display_id=1001）作为搜索词，
// 不依赖“动态规划”等外部种子数据，测试更稳定。
const QUERY = "1001";

Deno.test("[ui/browser] 统一搜索：命令面板显示分组结果", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  const session = await launchBrowser();
  let failed = true;
  try {
    await gotoPage(session.page, "/");
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
    // 默认 E2E 种子无法稳定产生多页，因此不在浏览器 E2E 中断言分页。
    const problemResult = session.page.locator('[role="option"]').first();
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
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "search");
  }
});
