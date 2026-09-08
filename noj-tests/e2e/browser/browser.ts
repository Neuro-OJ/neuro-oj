/**
 * 浏览器 E2E 共享辅助（issue #427 / 搜索统一 E2E）。
 *
 * 封装 Playwright 启动、失败诊断产物、跳转与 class 断言，
 * 避免多个 browser E2E 文件重复维护 launch/teardown。
 */

import { expect } from "npm:playwright@1.62.1/test";

export const BROWSER_E2E = Deno.env.get("NOJ_RUN_BROWSER_E2E") === "1";
export const UI_URL = Deno.env.get("E2E_UI_URL") || "http://localhost:3000";
export const ARTIFACT_DIR = "test-results/ui-browser";

type Browser = import("npm:playwright@1.62.1").Browser;
type BrowserContext = import("npm:playwright@1.62.1").BrowserContext;
type Page = import("npm:playwright@1.62.1").Page;
type Locator = import("npm:playwright@1.62.1").Locator;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(): Promise<BrowserSession> {
  const { chromium } = await import("npm:playwright@1.62.1");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    console.error(`  [browser pageerror] ${err.message}`);
  });
  return { browser, context, page };
}

export async function teardownBrowser(
  session: BrowserSession,
  failed: boolean,
  label: string,
): Promise<void> {
  const { browser, context, page } = session;
  try {
    if (failed) {
      await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
      await context.tracing.stop({
        path: `${ARTIFACT_DIR}/trace-${label}-${Date.now()}.zip`,
      });
      await page?.screenshot({
        path: `${ARTIFACT_DIR}/failure-${label}-${Date.now()}.png`,
        fullPage: true,
      });
      console.log(`  → 失败诊断产物已保存到 ${ARTIFACT_DIR}/`);
    } else {
      await context.tracing.stop();
    }
  } catch (e) {
    console.error(
      `  [teardown] 诊断产物保存失败: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    await browser.close();
  }
}

export async function gotoPage(page: Page, path: string): Promise<void> {
  await page.goto(`${UI_URL}${path}`, { waitUntil: "domcontentloaded" });
}

export async function assertClassContains(
  element: Locator,
  className: string,
  _label: string,
  timeout = 15_000,
): Promise<void> {
  await expect(element).toContainClass(className, { timeout });
}
