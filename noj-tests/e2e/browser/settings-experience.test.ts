/// <reference lib="dom" />
/** 设置、邀请和观察页面的浏览器任务验收，API只准备独立域。 */
import { assertEquals } from "jsr:@std/assert@1";
import { expect } from "npm:playwright@1.62.1/test";
import { api, getAdminToken } from "../helper.ts";
import {
  ARTIFACT_DIR,
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
      await expect(
        page.getByRole("button", { name: "保存基本设置", exact: true }),
      )
        .toBeDisabled();
      await expect(
        page.getByText("此空间已归档，当前仅可读取历史", { exact: true }),
      ).toBeHidden();
      await page.unroute(contextUrl);
      await page.getByRole("button", { name: "重新读取设置", exact: true })
        .click();
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "保存基本设置", exact: true }),
      )
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

      const queueRequests = new Map<string, number>();
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "GET" && path.endsWith("/queue")) {
          queueRequests.set(path, (queueRequests.get(path) ?? 0) + 1);
        }
      });
      const checkQueueRequests = async (path: string) => {
        await expect(page.getByText("更新时间:", { exact: false }))
          .toBeVisible();
        // 观察时间覆盖 2 秒降级轮询周期，确认健康 SSE 下没有启动请求风暴。
        await page.waitForTimeout(2500);
        const initial = queueRequests.get(path) ?? 0;
        assertEquals(initial >= 1 && initial <= 2, true, `${path}: ${initial}`);
        console.log(`  ${path} 初始队列请求数：${initial}`);
        await page.getByRole("button", { name: "刷新队列", exact: true })
          .click();
        await expect.poll(() => queueRequests.get(path)).toBe(initial + 1);
      };
      await gotoPage(page, "/d/main/queue");
      await checkQueueRequests("/api/v1/domains/main/queue");
      await page.getByRole("button", { name: "实例", exact: true }).click();
      await expect(page.getByRole("button", { name: "实例", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      await page.waitForURL((url) =>
        url.searchParams.get("scope") === "instance"
      );
      await expect(
        page.getByText("明细仅显示你有权查看的任务", { exact: true }),
      ).toBeVisible();
      await checkQueueRequests("/api/v1/instance/queue");
      await page.getByRole("button", { name: "当前域", exact: true }).click();
      await expect(page.getByRole("button", { name: "当前域", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
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
      await page.setViewportSize({ width: 390, height: 900 });
      await gotoPage(page, "/admin/instance/domains");
      await expect(page.getByRole("button", { name: "更多操作" }).first())
        .toBeVisible();
      assertEquals(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= innerWidth
        ),
        true,
      );

      // 对当前构建集中保留桌面/手机证据，不复用历史截图作为本轮验收。
      await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
      const capture = async (label: string) => {
        assertEquals(
          await page.evaluate(() =>
            document.documentElement.scrollWidth <= innerWidth
          ),
          true,
          `${label} 不应撑宽整个文档`,
        );
        await page.screenshot({
          path: `${ARTIFACT_DIR}/settings-polish-${label}.png`,
          fullPage: !label.startsWith("system"),
        });
      };
      await capture("directory-390");

      await gotoPage(page, `/d/${slug}/settings/invitations`);
      await expect(page.getByRole("button", { name: "生成邀请", exact: true }))
        .toBeVisible();
      await expect(
        page.getByRole("button", { name: "撤销", exact: true }).first(),
      ).toBeVisible();
      await capture("invitations-390");

      const limits = await api("GET", `/api/v1/domains/${slug}/limits`, {
        token,
      });
      assertEquals(limits.status, 200);
      const quota = limits.body as {
        data: { configured: Record<string, number | null>; revision: number };
      };
      const preciseBytes = 1073741825;
      const configured = await api("PATCH", `/api/v1/domains/${slug}/limits`, {
        token,
        headers: { "If-Match": String(quota.data.revision) },
        body: { ...quota.data.configured, storage_bytes: preciseBytes },
      });
      assertEquals(configured.status, 200, JSON.stringify(configured.body));
      await gotoPage(page, `/d/${slug}/settings/limits`);
      await expect(page.getByRole("button", { name: "保存配额", exact: true }))
        .toBeVisible();
      await capture("limits-390");
      const savedQuota = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/v1/domains/${slug}/limits` &&
        response.request().method() === "PATCH"
      );
      await page.getByRole("button", { name: "保存配额", exact: true }).click();
      const quotaResponse = await savedQuota;
      assertEquals(quotaResponse.status(), 200);
      assertEquals(
        quotaResponse.request().postDataJSON().storage_bytes,
        preciseBytes,
      );

      const systemResponse = await api("GET", "/api/v1/admin/system/settings", {
        token,
      });
      assertEquals(systemResponse.status, 200);
      const systemSettings = systemResponse.body as {
        data: {
          key: string;
          type: string;
          scope: string;
          is_secret: boolean;
          description: string;
        }[];
      };
      const editable = systemSettings.data.find((item) =>
        item.type === "string" && item.scope === "runtime" && !item.is_secret
      );
      assertEquals(!!editable, true, "夹具应包含可编辑的非敏感文本设置");

      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (
          const [label, path, ready] of [
            ["access", "/admin/instance/access", "保存政策"],
            ["system", "/admin/settings", "系统设置"],
          ]
        ) {
          await gotoPage(page, path);
          await expect(
            label === "system"
              ? page.getByRole("heading", { name: ready, exact: true })
              : page.getByRole("button", { name: ready, exact: true }),
          )
            .toBeVisible();
          if (label === "system" && editable) {
            const field = page.getByRole("textbox", {
              name: `${editable.description} (${editable.key})`,
              exact: true,
            });
            await expect(field).toBeVisible();
            const original = await field.inputValue();
            const draft = `${original}-unsaved-ui-check`;
            await field.fill(draft);
            await page.getByRole("button", {
              name: "重新读取配置",
              exact: true,
            }).click();
            await expect(page.getByRole("dialog")).toBeVisible();
            await page.getByRole("button", { name: "取消", exact: true })
              .click();
            await expect(field).toHaveValue(draft);
            await page.getByRole("button", {
              name: `放弃 ${editable.key} 的修改`,
              exact: true,
            }).click();
            await expect(field).toHaveValue(original);
            const idsUnique = await page.evaluate(() => {
              const ids = Array.from(
                document.querySelectorAll("[id]"),
                (node) => node.id,
              );
              return new Set(ids).size === ids.length;
            });
            assertEquals(idsUnique, true, "桌面与手机模板不能生成重复字段 id");
          }
          await capture(`${label}-${width}`);
        }
      }
      assertEquals(errors, []);
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "settings-experience");
    }
  },
});
