/// <reference lib="dom" />
/** 设置、邀请和观察页面的浏览器任务验收，API只准备独立域。 */
import { assertEquals } from "jsr:@std/assert@1";
import { expect } from "npm:playwright@1.62.1/test";
import { api, getAdminToken } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
} from "./browser.ts";

Deno.test({
  name:
    "[ui/settings-experience] 设置分页、权限等待、邀请码、提交筛选与队列切换",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = await getAdminToken();
    const slug = `ui-settings-${Date.now().toString(36)}`;
    const created = await api("POST", "/api/v1/domains", {
      token,
      body: { slug, name: "设置与邀请浏览器验收", preset: "education" },
    });
    assertEquals(created.status, 201, JSON.stringify(created.body));
    const session = await launchBrowser();
    const { page } = session;
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failed = true;
    try {
      await gotoPage(page, "/login");
      await page.getByPlaceholder("请输入用户名或邮箱").fill("e2e_admin");
      await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字")
        .fill(Deno.env.get("E2E_ADMIN_PASS") || "E2eAdminChangedPass1");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      const consent = page.getByRole("button", {
        name: "我已知悉并同意",
        exact: true,
      });
      if (await consent.isVisible()) await consent.click();

      // 延迟域上下文响应，等待期间不能把尚未解析的权限显示成拒绝。
      let release!: () => void;
      const gate = new Promise<void>((resolve) => release = resolve);
      const contextUrl = `**/api/v1/domains/${slug}`;
      await page.route(contextUrl, async (route) => {
        await gate;
        await route.continue();
      });
      const requested = page.waitForRequest((request) =>
        new URL(request.url()).pathname === `/api/v1/domains/${slug}`
      );
      const navigation = gotoPage(page, `/d/${slug}/settings`);
      await requested;
      await expect(page.getByText("你没有管理此域设置的权限", { exact: true }))
        .toBeHidden();
      release();
      await navigation;
      await page.unroute(contextUrl);
      await expect(page.getByRole("heading", { name: "基本信息", exact: true }))
        .toBeVisible();
      const description = page.getByRole("textbox", {
        name: "空间简介",
        exact: true,
      });
      await description.fill("网络错误后仍应保留的未保存简介");
      await page.route(contextUrl, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "浏览器验收：临时不可用" }),
        }));
      await page.getByRole("button", { name: "重新读取设置", exact: true })
        .click();
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await expect(
        page.getByText("背景刷新失败，当前展示本地缓存，写入已临时禁用", {
          exact: true,
        }),
      )
        .toBeVisible();
      await expect(description).toHaveValue("网络错误后仍应保留的未保存简介");
      await expect(page.getByRole("button", { name: "保存设置", exact: true }))
        .toBeDisabled();
      await expect(
        page.getByText("此空间已归档，当前仅可读取历史", { exact: true }),
      ).toBeHidden();
      await page.unroute(contextUrl);
      await page.getByRole("button", { name: "重新读取设置", exact: true })
        .click();
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await expect(page.getByRole("button", { name: "保存设置", exact: true }))
        .toBeEnabled();
      const settingsNav = page.getByRole("navigation", {
        name: "域设置",
        exact: true,
      });
      const links = await settingsNav.getByRole("link").evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href"))
      );
      assertEquals(links.some((href) => href?.includes("#")), false);
      await settingsNav.getByRole("link", { name: "邀请", exact: false })
        .click();
      await page.waitForURL(`**/d/${slug}/settings/invitations`);
      await page.getByRole("button", { name: /一次性邀请/ }).click();
      const invitationResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname ===
          `/api/v1/domains/${slug}/invitations` &&
        response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "生成邀请", exact: true }).click();
      const invitation = await invitationResponse;
      assertEquals(invitation.status(), 201);
      const body = await invitation.json();
      assertEquals(body.data.mode, "once");
      await expect(page.getByRole("textbox", { name: "生成的邀请短码" }))
        .toHaveValue(body.data.code);
      await gotoPage(page, "/join");
      await page.getByRole("textbox", { name: "邀请码输入", exact: true }).fill(
        body.data.code,
      );
      await page.getByRole("button", { name: "查询邀请", exact: true }).click();
      await expect(page.getByText("一次性邀请（限 1 人）", { exact: true }))
        .toBeVisible();

      await gotoPage(page, `/d/${slug}/submissions`);
      const username = page.getByPlaceholder("用户名（留空查全部）");
      await expect(username).toHaveValue("e2e_admin");
      await username.fill("");
      await page.getByRole("button", { name: "筛选", exact: true }).click();
      await page.waitForURL((url) =>
        url.searchParams.has("username") &&
        url.searchParams.get("username") === ""
      );
      await page.reload();
      await expect(username).toHaveValue("");

      await gotoPage(page, `/d/${slug}/queue`);
      await page.getByRole("button", { name: "实例", exact: true }).click();
      await page.waitForURL((url) =>
        url.searchParams.get("scope") === "instance"
      );
      await expect(
        page.getByText("明细仅显示你有权查看的任务", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "当前域", exact: true }).click();
      await expect(
        page.getByText("明细仅显示你有权查看的任务", { exact: true }),
      ).toBeHidden();

      await gotoPage(page, "/admin/instance/access");
      await expect(page.getByRole("button", { name: "保存政策", exact: true }))
        .toBeVisible();
      await page.getByRole("combobox", { name: "实例访问范围", exact: true })
        .focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toBeHidden();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("combobox", { name: "账号注册模式", exact: true }),
      )
        .toBeFocused();
      await page.getByRole("link", { name: "空间创建", exact: true }).click();
      await page.waitForURL("**/admin/instance/creation");
      await expect(page.getByRole("button", { name: "保存政策", exact: true }))
        .toBeVisible();
      assertEquals(errors, []);
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "settings-experience");
    }
  },
});
