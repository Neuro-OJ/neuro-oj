/// <reference lib="dom" />
/** main 新输入模式的真实浏览器→Core→Judge旅程；API只准备资源及核对结果。 */
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { getAdminToken, TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage as navigate,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import {
  inputModeAccount,
  inputModeFixture as fixture,
  inputModePolicy,
  inputModeProblem,
  inputModeVersionTwo,
  joinInputModeDomain,
  shareInputModeProblem,
} from "./_workspace-input-mode-fixtures.ts";
import type { InputModeProblem } from "./_workspace-input-mode-fixtures.ts";
type Page = import("npm:playwright@1.62.1").Page;
type Locator = import("npm:playwright@1.62.1").Locator;
interface Submission {
  id: string;
  domain_id: string;
  submitted_version_id: string;
  contest_id?: string;
  language: string;
  status: string;
  code: string;
  result: { score: number };
}
async function goto(page: Page, path: string) {
  await navigate(page, path);
  await page.waitForFunction(() =>
    Boolean(
      (document.querySelector("#__nuxt") as Element & { __vue_app__?: unknown })
        ?.__vue_app__,
    )
  );
}
async function login(page: Page, email: string) {
  await goto(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(email);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    TEST_PASSWORD,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await goto(page, "/workspaces");
  const response = await page.request.get(`${UI_URL}/api/v1/auth/me`),
    body = await response.json();
  assertEquals(response.status(), 200);
  if (collectPendingConsents(body.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
}
async function write(page: Page, path: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse((result) =>
    decodeURIComponent(new URL(result.url()).pathname) === `/api/v1${path}` &&
    result.request().method() === "POST"
  );
  await action();
  const result = await response, body = await result.json();
  assertEquals(result.status(), 201, JSON.stringify(body));
  return body as { data: { id: string } };
}
async function finished(
  slug: string,
  id: string,
  token: string,
): Promise<Submission> {
  let record: Submission | undefined;
  await expect.poll(async () => {
    record = (await fixture<{ data: Submission }>(
      "GET",
      `/domains/${slug}/submissions/${id}`,
      token,
    )).data;
    if (record.status === "error") {
      throw new Error(`实际Judge失败: ${JSON.stringify(record)}`);
    }
    return record.status;
  }, { timeout: 90000, intervals: [500, 1000] }).toBe("finished");
  return record!;
}
async function upload(page: Page, slug: string, problem: InputModeProblem) {
  await goto(page, `/d/${slug}/problems/${problem.reference}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "predictions.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("c1,1\nc2,0\n"),
  });
  return (await write(
    page,
    `/domains/${slug}/submissions`,
    () => page.getByRole("button", { name: "提交评测", exact: true }).click(),
  )).data.id;
}
function frame(page: Page) {
  return page.frameLocator('iframe[title="题目界面"]');
}
function historyRow(
  page: Page,
  slug: string,
  kind: "submissions" | "self-tests",
  id: string,
): Locator {
  return page.locator(`a[href="/d/${slug}/${kind}/${id}"]`).filter({
    hasText: "运行详情",
  }).locator("..");
}
Deno.test({
  name:
    "workspace-input-modes: 预测与界面真实Judge、SDK反馈、运行历史和跨域版本",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const suffix = `${Date.now().toString(36)}${
      Math.random().toString(36).slice(2, 6)
    }`;
    const source = `inputsrc-${suffix}`,
      a = `inputa-${suffix}`,
      b = `inputb-${suffix}`;
    const admin = await getAdminToken(),
      student = await inputModeAccount(suffix);
    const session = await launchBrowser(),
      second = await session.context.newPage();
    let failed = true,
      aId = "",
      bId = "",
      prediction: InputModeProblem,
      ui: InputModeProblem;
    let firstFormal = "", firstSelfTest = "";
    async function step(name: string, action: () => Promise<void>) {
      assertEquals(await t.step(name, action), true, name);
    }
    try {
      await step(
        "准备独立公开源题、两个成员域和普通学生，发布合法v2输入模式题包",
        async () => {
          for (
            const [slug, preset] of [[source, "community"], [a, "team"], [
              b,
              "team",
            ]] as const
          ) {
            const { data } = await fixture<{ data: { id: string } }>(
              "POST",
              "/domains",
              admin,
              { slug, name: slug, preset },
            );
            if (slug === a) aId = data.id;
            if (slug === b) bId = data.id;
          }
          await joinInputModeDomain(a, admin, student);
          await joinInputModeDomain(b, admin, student);
          prediction = await inputModeProblem(source, "prediction", admin);
          ui = await inputModeProblem(source, "ui", admin);
          await shareInputModeProblem(source, prediction, [a, b], admin);
          await shareInputModeProblem(source, ui, [a, b], admin);
          await inputModeVersionTwo(source, "prediction", prediction, admin);
          await inputModePolicy(a, prediction, admin, prediction.v1);
          await login(session.page, student.email);
        },
      );
      await step(
        "学校A固定V1与学校B跟随V2，实际Web上传同一预测文件分别得到50与100分",
        async () => {
          const firstId = await upload(session.page, a, prediction!);
          const first = await finished(a, firstId, student.token);
          assertEquals([
            first.domain_id,
            first.submitted_version_id,
            first.result.score,
          ], [aId, prediction!.v1, 5000]);
          await session.page.getByRole("link", {
            name: "查看评测",
            exact: true,
          }).click();
          await expect(session.page.getByText("50.0 分", { exact: true }))
            .toBeVisible();
          const secondId = await upload(second, b, prediction!);
          const next = await finished(b, secondId, student.token);
          assertEquals([
            next.domain_id,
            next.submitted_version_id,
            next.result.score,
          ], [bId, prediction!.v2, 10000]);
          await second.getByRole("link", { name: "查看评测", exact: true })
            .click();
          await expect(second.getByText("100.0 分", { exact: true }))
            .toBeVisible();
        },
      );
      await step(
        "iframe填写参数触发自测与正式提交，NOJ.onResult展示真实Judge汇总",
        async () => {
          await goto(session.page, `/d/${a}/problems/${ui!.reference}`);
          await frame(session.page).getByLabel("参数提示").fill("first");
          const selfTest = await write(
            session.page,
            `/domains/${a}/problems/${ui!.reference}/self-tests`,
            () =>
              frame(session.page).getByRole("button", { name: "界面自测" })
                .click(),
          );
          firstSelfTest = selfTest.data.id;
          await expect(frame(session.page).getByRole("status")).toContainText(
            "100 分",
            { timeout: 90000 },
          );
          const submitted = await write(
            session.page,
            `/domains/${a}/submissions`,
            () =>
              frame(session.page).getByRole("button", { name: "界面提交" })
                .click(),
          );
          firstFormal = submitted.data.id;
          const record = await finished(a, firstFormal, student.token);
          assertEquals([
            record.domain_id,
            record.submitted_version_id,
            record.language,
            record.result.score,
          ], [aId, ui!.v1, "ui", 10000]);
          assertEquals(JSON.parse(record.code), { prompt: "first" });
          await expect(frame(session.page).getByRole("status")).toContainText(
            "100 分",
            { timeout: 15000 },
          );
        },
      );
      await step(
        "再次正式运行40分后刷新，持久历史可对比、回滚、撤销且iframe控件同步",
        async () => {
          await frame(session.page).getByLabel("参数提示").fill("different");
          const submitted = await write(
            session.page,
            `/domains/${a}/submissions`,
            () =>
              frame(session.page).getByRole("button", { name: "界面提交" })
                .click(),
          );
          assertEquals(
            (await finished(a, submitted.data.id, student.token)).result.score,
            4000,
          );
          await expect(frame(session.page).getByRole("status")).toContainText(
            "40 分",
            { timeout: 15000 },
          );
          await goto(session.page, `/d/${a}/problems/${ui!.reference}`);
          await expect(frame(session.page).getByLabel("参数提示")).toHaveValue(
            "different",
          );
          await expect(historyRow(session.page, a, "self-tests", firstSelfTest))
            .toBeVisible();
          const row = historyRow(session.page, a, "submissions", firstFormal);
          await row.getByRole("button", { name: "对比参数" }).click();
          await expect(session.page.getByText(/-.*first/)).toBeVisible();
          await row.getByRole("button", { name: "回滚参数" }).click();
          await expect(frame(session.page).getByLabel("参数提示")).toHaveValue(
            "first",
          );
          await session.page.getByRole("button", { name: "撤销回滚" }).click();
          await expect(frame(session.page).getByLabel("参数提示")).toHaveValue(
            "different",
          );
        },
      );
      await step(
        "相同来源题与版本的两个学校标签页分别保存各自参数草稿",
        async () => {
          await frame(session.page).getByLabel("参数提示").fill(
            "school-a-draft",
          );
          await goto(second, `/d/${b}/problems/${ui!.reference}`);
          await frame(second).getByLabel("参数提示").fill("school-b-draft");
          await goto(session.page, `/d/${a}/problems/${ui!.reference}`);
          await goto(second, `/d/${b}/problems/${ui!.reference}`);
          await expect(frame(session.page).getByLabel("参数提示")).toHaveValue(
            "school-a-draft",
          );
          await expect(frame(second).getByLabel("参数提示")).toHaveValue(
            "school-b-draft",
          );
          await expect(
            session.page.getByText(
              `提交归属 ${a}，来源题号 ${ui!.reference}。`,
            ),
          ).toBeVisible();
        },
      );
      await step(
        "源题已发布V2时，比赛iframe与参数执行仍遵守固定V1",
        async () => {
          await inputModeVersionTwo(source, "ui", ui!, admin);
          await inputModePolicy(a, ui!, admin, ui!.v1);
          const now = Date.now();
          const contest = await fixture<{ data: { id: string } }>(
            "POST",
            `/domains/${a}/contests`,
            admin,
            {
              title: `界面固定版本 ${suffix}`,
              type: "kaggle",
              kind: "invite",
              password: `input-${suffix}`,
              is_public: false,
              start_time: new Date(now - 60000).toISOString(),
              end_time: new Date(now + 900000).toISOString(),
              problems: [{
                problem_id: ui!.id,
                label: "A",
                score: 10000,
                sort_order: 0,
              }],
            },
          );
          await fixture(
            "POST",
            `/domains/${a}/contests/${contest.data.id}/participants`,
            admin,
            { user_ids: [student.id] },
          );
          await inputModePolicy(a, ui!, admin, null);
          await goto(
            session.page,
            `/d/${a}/contests/${contest.data.id}/problems/A`,
          );
          await expect(
            frame(session.page).getByRole("heading", { name: "界面版本 V1" }),
          ).toBeVisible();
          await frame(session.page).getByLabel("参数提示").fill("first");
          const submitted = await write(
            session.page,
            `/domains/${a}/contests/${contest.data.id}/problems/A/submissions`,
            () =>
              frame(session.page).getByRole("button", { name: "界面提交" })
                .click(),
          );
          const record = await finished(a, submitted.data.id, student.token);
          assertEquals([
            record.contest_id,
            record.submitted_version_id,
            record.result.score,
          ], [contest.data.id, ui!.v1, 10000]);
          await expect(frame(session.page).getByRole("status")).toContainText(
            "100 分",
            { timeout: 15000 },
          );
        },
      );
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "workspace-input-modes");
    }
  },
});
