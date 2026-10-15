/// <reference lib="dom" />
/** 实例与两域运营内容：管理页面实际发布，公开入口与隔离用真实 API 核对。 */
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { api, BASE_URL, getAdminToken } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
} from "./browser.ts";
import { inputModeFixture as fixture } from "./_workspace-input-mode-fixtures.ts";

Deno.test({
  name: "workspace-domain-content: 原版域设置发布公告轮播、实例合并与跨域隔离",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const suffix = Date.now().toString(36),
      a = `content-a-${suffix}`,
      b = `content-b-${suffix}`;
    const token = await getAdminToken();
    for (const [slug, preset] of [[a, "community"], [b, "team"]]) {
      await fixture("POST", "/domains", token, { slug, name: slug, preset });
    }
    const global = await fixture<{ data: { id: string } }>(
      "POST",
      "/admin/system/announcements",
      token,
      {
        title: `实例公告 ${suffix}`,
        content: "所有域共享通知",
        banner_text: `实例横幅 ${suffix}`,
      },
    );
    const session = await launchBrowser(), page = session.page;
    let failed = true;
    try {
      await gotoPage(page, "/login");
      await page.getByPlaceholder("请输入用户名或邮箱").fill(
        Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com",
      );
      await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
        "E2eAdminChangedPass1",
      );
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await gotoPage(page, `/d/${a}`);
      const consent = page.getByRole("button", {
        name: "我已知悉并同意",
        exact: true,
      });
      if (await consent.isVisible()) await consent.click();
      await page.getByRole("button", { name: "用户菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: "域设置", exact: true }).click();
      await page.waitForURL(`**/d/${a}/settings`);
      await page.getByRole("navigation", { name: "域设置", exact: true })
        .getByRole("link", { name: "公告管理", exact: true }).click();
      await page.getByRole("button", { name: "新建公告", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "新建公告",
        exact: true,
      });
      await dialog.getByRole("textbox", { name: "公告标题", exact: true }).fill(
        `本域公告 ${suffix}`,
      );
      await dialog.locator("textarea").fill(
        "本域 Markdown 正文，保留原管理控件。",
      );
      await dialog.getByPlaceholder(
        "导航栏下方横幅显示的文字；留空则此公告不出横幅",
      ).fill(`本域横幅 ${suffix}`);
      const [created] = await Promise.all([
        page.waitForResponse((r) =>
          r.url().endsWith(`/domains/${a}/settings/announcements`) &&
          r.request().method() === "POST"
        ),
        dialog.getByRole("button", { name: "立即发布", exact: true }).click(),
      ]);
      assertEquals(created.status(), 201, await created.text());
      const notice = (await created.json()).data as { id: string };
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("cell", { name: `本域公告 ${suffix}`, exact: true }),
      ).toBeVisible();
      await page.getByRole("navigation", { name: "域设置", exact: true })
        .getByRole("link", { name: "轮播管理", exact: true }).click();
      await page.getByRole("button", { name: "新建幻灯片", exact: true })
        .click();
      const slide = page.getByRole("dialog", {
        name: "新建幻灯片",
        exact: true,
      });
      await slide.getByPlaceholder("幻灯片标题", { exact: true }).fill(
        `本域轮播 ${suffix}`,
      );
      const [saved] = await Promise.all([
        page.waitForResponse((r) =>
          r.url().endsWith(`/domains/${a}/settings/carousel/slides`) &&
          r.request().method() === "POST"
        ),
        slide.getByRole("button", { name: "立即创建", exact: true }).click(),
      ]);
      assertEquals(saved.status(), 201, await saved.text());
      await expect(slide).toBeHidden();
      await gotoPage(page, `/d/${a}`);
      await expect(page.getByText(`本域轮播 ${suffix}`, { exact: true }))
        .toBeVisible();
      await expect(
        page.getByRole("link", { name: new RegExp(`本域公告 ${suffix}`) }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: new RegExp(`实例公告 ${suffix}`) }),
      ).toBeVisible();
      const merged = await fixture<{ data: Array<{ id: string }> }>(
        "GET",
        `/domains/${a}/announcements`,
        token,
      );
      assertEquals(
        merged.data.findIndex((n) => n.id === global.data.id) <
          merged.data.findIndex((n) => n.id === notice.id),
        true,
      );
      const banner = await fixture<{ data: { id: string } }>(
        "GET",
        `/domains/${a}/announcements/banner`,
        token,
      );
      assertEquals(banner.data.id, global.data.id);
      assertEquals(
        (await api("GET", `/api/v1/domains/${b}/announcements/${notice.id}`, {
          token,
        })).status,
        404,
      );
      assertEquals(
        (await api("GET", `/api/v1/announcements/${notice.id}`)).status,
        404,
      );
      assertEquals(
        (await api("GET", `/api/v1/domains/${b}/announcements`)).status,
        404,
      );
      // 私有域上传的图片仍由当前域授权入口读取，不能经其他域或实例 URL 公开。
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      const form = new FormData();
      form.set("file", new File([png], "banner.png", { type: "image/png" }));
      const uploaded = await fetch(
        `${BASE_URL}/api/v1/domains/${b}/settings/carousel/images`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        },
      );
      assertEquals(uploaded.status, 201);
      const image = (await uploaded.json()).data.image_storage_url as string;
      const imageSlide = await fixture<{ data: { id: string } }>(
        "POST",
        `/domains/${b}/settings/carousel/slides`,
        token,
        { kind: "image", image_storage_url: image },
      );
      const imagePath = `/carousel/slides/${imageSlide.data.id}/image`;
      const bytes = await fetch(`${BASE_URL}/api/v1/domains/${b}${imagePath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(bytes.status, 200);
      assertEquals(new Uint8Array(await bytes.arrayBuffer()), png);
      assertEquals(
        (await api("GET", `/api/v1/domains/${b}${imagePath}`)).status,
        404,
      );
      assertEquals(
        (await api("GET", `/api/v1/domains/${a}${imagePath}`, { token }))
          .status,
        404,
      );
      assertEquals((await api("GET", `/api/v1${imagePath}`)).status, 404);
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoPage(page, `/d/${a}/settings`);
      await expect(
        page.getByRole("combobox", { name: "域设置分组", exact: true }),
      ).toBeVisible();
      assertEquals(
        await page.evaluate(() =>
          document.documentElement.scrollWidth > innerWidth
        ),
        false,
      );
      failed = false;
    } finally {
      await api(
        "DELETE",
        `/api/v1/admin/system/announcements/${global.data.id}`,
        { token },
      );
      await teardownBrowser(session, failed, "workspace-domain-content");
    }
  },
});
