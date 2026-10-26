/// <reference lib="dom" />
/** 题包直接建题必须使用路径域，并以返回的草稿 revision 发布。 */
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { Buffer } from "node:buffer";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { api as request, getAdminToken, TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import {
  inputModeAccount,
  inputModeFixture as api,
  joinInputModeDomain,
} from "./_workspace-input-mode-fixtures.ts";

Deno.test({
  name: "workspace-bundle-import: 普通域负责人从题包创建草稿与显式发布",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const suffix = crypto.randomUUID().slice(0, 8), slug = `bundle-${suffix}`;
    const admin = await getAdminToken(),
      owner = await inputModeAccount(`bundle_${suffix}`);
    const domain = await api<{ data: { id: string } }>(
      "POST",
      "/domains",
      admin,
      {
        slug,
        name: slug,
        preset: "team",
      },
    );
    await joinInputModeDomain(slug, admin, owner);
    await api("POST", `/domains/${slug}/transfer`, admin, {
      user_id: owner.id,
    });
    const session = await launchBrowser();
    let failed = true;
    try {
      const page = session.page;
      await gotoPage(page, "/login");
      await page.getByPlaceholder("请输入用户名或邮箱").fill(owner.email);
      await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
        TEST_PASSWORD,
      );
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await gotoPage(page, "/workspaces");
      const me = await (await page.request.get(`${UI_URL}/api/v1/auth/me`))
        .json();
      assertEquals(me.data.is_admin, false);
      if (collectPendingConsents(me.data.legal).length) {
        await page.getByRole("button", { name: "我已知悉并同意", exact: true })
          .click();
        await expect(page.getByRole("dialog", { name: "政策更新通知" }))
          .toBeHidden();
      }
      for (const publish of [false, true]) {
        const title = `题包 ${suffix} ${publish ? "发布" : "草稿"}`;
        const bytes = zipSync({
          "problem.json": strToU8(JSON.stringify({
            format_version: 2,
            title,
            difficulty: "easy",
            is_objective: true,
          })),
          "statement.md": strToU8(`# ${title}`),
          "questions.json": strToU8(JSON.stringify([{
            type: "single",
            prompt: "1+1=?",
            options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
            answer: ["A"],
            explanation: "1+1=2",
          }])),
        });
        await gotoPage(page, `/d/${slug}/problems/new?import=1`);
        await expect(page.getByRole("heading", { name: "上传题目包" }))
          .toBeVisible();
        await page.getByLabel("导入后立即发布", { exact: false }).setChecked(
          publish,
        );
        const imported = page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/v1/domains/${slug}/problems/import-bundle`
        );
        await page.locator('input[type="file"]').setInputFiles({
          name: "problem.zip",
          mimeType: "application/zip",
          buffer: Buffer.from(bytes),
        });
        const response = await imported;
        assertEquals(response.status(), 201);
        const saved = (await response.json()).data;
        await page.waitForURL(`${UI_URL}/d/${slug}/editor/${saved.number}`);
        const draft = await api<{ content: { title: string } }>(
          "GET",
          `/domains/${slug}/problems/${saved.number}/draft`,
          owner.token,
        );
        assertEquals(draft.content.title, title);
        const versions = await request(
          "GET",
          `/api/v1/domains/${slug}/problems/${saved.number}/versions`,
          { token: owner.token },
        );
        assertEquals(versions.status, publish ? 200 : 404);
        if (publish) {
          assertEquals((versions.body as { items: unknown[] }).items.length, 1);
        }
        const list = await api<
          {
            items: Array<
              { reference: { problem_id: string; source_domain_id: string } }
            >;
          }
        >(
          "GET",
          `/domains/${slug}/problem-drafts`,
          owner.token,
        );
        assertEquals(
          list.items.some((item) =>
            item.reference.problem_id === saved.problem_id &&
            item.reference.source_domain_id === domain.data.id
          ),
          true,
        );
      }
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "domain-bundle-import");
    }
  },
});
