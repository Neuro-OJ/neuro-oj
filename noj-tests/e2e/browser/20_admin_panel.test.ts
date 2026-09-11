/// <reference lib="dom" />
/**
 * 管理后台浏览器 E2E（回归：管理员刷新 /admin/* 被踢回登录页 + 面板恒显示无数据）。
 *
 * 覆盖三条只在真实浏览器中才暴露的缺陷：
 *   1. 整页加载/刷新 `/admin/*` 时，SSR 阶段的路由守卫必须拿到真实登录态，
 *      不得把已登录管理员 302 到 /login；
 *   2. 表格必须渲染 API 返回的数据行（`AdminTable` 曾用 Nuxt UI v2 的 `:rows`，
 *      v4 只认 `data`，导致 12 个管理页面「API 有数据但显示无数据」）；
 *   3. 单元格渲染不得因可空字段（如审计日志的 `admin_id=null`）抛错——
 *      单元格异常会连带卸载整张表，表现为同样的「有数据却空白」。
 *
 * 运行前置（完整栈）：
 *   - noj-core（E2E_BASE_URL）+ 种子 admin（e2e_admin@test.com）
 *   - noj-ui 已构建并监听 E2E_UI_URL（默认 :3000），NUXT_API_BASE 指向 noj-core
 *   - Playwright 浏览器：`deno run -A npm:playwright install chromium`
 *
 * 启用：NOJ_RUN_BROWSER_E2E=1 deno task test:browser
 */

import {
  BROWSER_E2E,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import { getAdminToken } from "../helper.ts";

type Page = import("npm:playwright@1.62.1").Page;

const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
/** getAdminToken() 会把 admin 密码归一化为该值（含强制改密流程） */
const ADMIN_PASSWORD = "E2eAdminChangedPass1";

/** 等待 Nuxt 应用挂载完成：dev 服务器下 domcontentloaded 常早于水合，过早交互会丢事件 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector("#__nuxt")), {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
}

async function loginViaUI(
  page: Page,
  login: string,
  password: string,
): Promise<void> {
  await page.goto(`${UI_URL}/login`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.getByPlaceholder("请输入用户名或邮箱").fill(login);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    password,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

/** 采集页面未捕获异常（单元格渲染抛错会表现为 uncaught TypeError） */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** 表格数据行（UTable 空态渲染的 "No data" 行不算数据） */
function dataRows(page: Page) {
  return page.locator("main tbody tr").filter({ hasNotText: "No data" });
}

/** 打开管理页并等待表格出现数据行；返回数据行数 */
async function openAdminTable(
  page: Page,
  path: string,
  heading: string,
): Promise<number> {
  await page.goto(`${UI_URL}${path}`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.getByRole("heading", { name: heading }).waitFor({
    timeout: 15_000,
  });
  await dataRows(page).first().waitFor({ timeout: 15_000 });
  return await dataRows(page).count();
}

Deno.test("[ui/browser] 管理后台：刷新 /admin/* 保持登录且列表渲染数据", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  // 归一化 admin 密码（首次走强制改密），使 UI 登录可用
  await getAdminToken();

  const session = await launchBrowser();
  let failed = true;
  try {
    const { page } = session;
    const pageErrors = collectPageErrors(page);
    await loginViaUI(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // ── 1. 整页加载进入管理后台：应停留在 /admin/users 且表格有数据 ──
    const rows = await openAdminTable(page, "/admin/users", "用户管理");
    if (new URL(page.url()).pathname !== "/admin/users") {
      throw new Error(`进入 /admin/users 后被重定向到 ${page.url()}`);
    }
    if (rows < 1) {
      throw new Error(`用户表格没有数据行（rows=${rows}）`);
    }

    // ── 2. 整页刷新（bug 复现路径）：不得跳回登录页，且刷新后仍有数据行 ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    if (new URL(page.url()).pathname !== "/admin/users") {
      throw new Error(`刷新 /admin/users 后被重定向到 ${page.url()}`);
    }
    await page.getByRole("heading", { name: "用户管理" }).waitFor({
      timeout: 15_000,
    });
    await dataRows(page).first().waitFor({ timeout: 15_000 });
    if ((await dataRows(page).count()) < 1) {
      throw new Error("刷新 /admin/users 后表格没有数据行");
    }

    // ── 3. 另一个走 AdminTable 的面板（角色管理）同样必须有数据 ──
    const roleRows = await openAdminTable(page, "/admin/roles", "角色管理");
    if (roleRows < 1) {
      throw new Error(`角色表格没有数据行（rows=${roleRows}）`);
    }

    if (pageErrors.length > 0) {
      throw new Error(`页面出现未捕获异常：${pageErrors.join(" | ")}`);
    }
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "admin-panel");
  }
});

Deno.test("[ui/browser] 管理后台：审计日志渲染含 null 管理员的行", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  await getAdminToken();

  const session = await launchBrowser();
  let failed = true;
  try {
    const { page } = session;
    const pageErrors = collectPageErrors(page);
    await loginViaUI(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 审计日志存在 admin_id=null 的系统事件；单元格曾对其 .slice() 抛错并卸载整张表
    const rows = await openAdminTable(page, "/admin/audit-logs", "审计日志");
    if (rows < 1) {
      throw new Error(`审计日志表格没有数据行（rows=${rows}）`);
    }
    if (pageErrors.length > 0) {
      throw new Error(`审计日志页出现未捕获异常：${pageErrors.join(" | ")}`);
    }
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "admin-audit-logs");
  }
});
