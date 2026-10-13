/// <reference lib="dom" />
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import postgres from "npm:postgres@3.4.5";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import {
  createLlmGovernanceFixture,
  finishLlmGovernance,
  type LlmAccount,
  llmFixtureApi,
  llmGovernanceUsage,
  type LlmSchool,
  submitLlmGovernance,
} from "./_workspace-llm-governance-fixture.ts";
type Page = import("npm:playwright@1.62.1").Page;

async function login(page: Page, actor: LlmAccount) {
  await gotoPage(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(actor.username);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    TEST_PASSWORD,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await gotoPage(page, "/workspaces");
  const response = await page.request.get(`${UI_URL}/api/v1/auth/me`),
    me = await response.json();
  assertEquals(response.status(), 200);
  assertEquals(me.data.id, actor.id);
  assertEquals(me.data.is_admin, false);
  if (collectPendingConsents(me.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
}
async function write(
  page: Page,
  school: LlmSchool,
  method: string,
  suffix: string,
  action: () => Promise<unknown>,
  status = 200,
) {
  const pathname = `/api/v1/domains/${school.slug}/llm/${suffix}`;
  const waiting = page.waitForResponse((r) =>
    new URL(r.url()).pathname === pathname && r.request().method() === method
  );
  await action();
  const response = await waiting, body = await response.json();
  assertEquals(
    response.status(),
    status,
    `${method} ${pathname}: ${JSON.stringify(body)}`,
  );
  return { body, request: response.request() };
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function createProvider(
  page: Page,
  school: LlmSchool,
  name: string,
  model: string,
) {
  await gotoPage(page, `/d/${school.slug}/llm`);
  await page.getByRole("button", { name: "新增 Provider", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "新增 Provider",
    exact: true,
  });
  for (
    const [label, value] of [["名称", name], [
      "Base URL",
      Deno.env.get("E2E_LLM_MOCK_URL") || "http://noj-e2e-llm-mock:8002/v1",
    ], ["API Key", "isolated-e2e-mock-key"]]
  ) {
    await dialog.getByText(label, { exact: true }).locator("..").locator(
      "input",
    ).fill(value);
  }
  await dialog.getByRole("spinbutton", {
    name: "Provider RPM 上限",
    exact: true,
  }).fill("60");
  await dialog.getByRole("spinbutton", {
    name: "Provider TPM 上限",
    exact: true,
  }).fill("1000000");
  const created = await write(
    page,
    school,
    "POST",
    "providers",
    () => dialog.getByRole("button", { name: "保存", exact: true }).click(),
    201,
  );
  assertEquals(created.request.headers()["if-match"], "0");
  assertEquals(created.body.data.domain_id, school.id);
  assertEquals(created.body.data.rpm_limit, 60);
  assertEquals(created.body.data.tpm_limit, 1000000);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  const testDialog = page.getByRole("dialog", {
    name: "测试本域 Provider 连接",
  });
  await testDialog.getByRole("textbox", {
    name: "Provider 测试模型",
    exact: true,
  }).fill(model);
  const tested = await write(
    page,
    school,
    "POST",
    `providers/${created.body.data.id}/test`,
    () =>
      testDialog.getByRole("button", { name: "运行连接测试", exact: true })
        .click(),
  );
  assertEquals(tested.body.data.status, "ok");
  assertEquals(tested.body.data.model, model);
  await expect(testDialog.getByText(/连接成功，耗时/)).toBeVisible();
  await testDialog.getByRole("button", { name: "Close", exact: true }).click();
  return created.body.data.id as string;
}
async function createAlias(
  page: Page,
  school: LlmSchool,
  providerName: string,
  model: string,
) {
  await page.getByRole("textbox", { name: "模型能力别名", exact: true }).fill(
    "fast",
  );
  await select(page, "别名 Provider", providerName);
  await page.getByRole("textbox", { name: "别名实际模型", exact: true }).fill(
    model,
  );
  await page.getByRole("textbox", { name: "别名能力说明", exact: true }).fill(
    "浏览器验收能力",
  );
  const result = await write(
    page,
    school,
    "PUT",
    "model-aliases/fast",
    () => page.getByRole("button", { name: "新增别名", exact: true }).click(),
  );
  assertEquals(result.request.headers()["if-match"], "0");
  return result.body.data;
}
async function editAlias(
  page: Page,
  school: LlmSchool,
  model: string,
  status = 200,
) {
  await page.getByRole("button", { name: "编辑别名", exact: true }).click();
  await page.getByRole("textbox", { name: "别名实际模型", exact: true }).fill(
    model,
  );
  return await write(
    page,
    school,
    "PUT",
    "model-aliases/fast",
    () => page.getByRole("button", { name: "保存别名", exact: true }).click(),
    status,
  );
}

Deno.test({
  name:
    "[ui/workspace-llm-governance] 普通owner治理、别名CAS与两学校真实调用和冻结归属",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const f = await createLlmGovernanceFixture(suffix), [a, b] = f.schools;
    const browserA = await launchBrowser(), browserB = await launchBrowser();
    const stale = await browserA.context.newPage();
    let failed = true;
    const dbUrl = Deno.env.get("E2E_LLM_GOVERNANCE_DATABASE_URL") ||
      Deno.env.get("DATABASE_URL");
    if (!dbUrl) throw new Error("需要隔离测试数据库以只读核对受理快照");
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await login(browserA.page, a.owner);
      await login(browserB.page, b.owner);
      const modelA = `llmgov-a-${suffix}`,
        modelB = `llmgov-b-${suffix}`,
        currentA = `${modelA}-current`,
        nextA = `${modelA}-next`;
      let providerA = "", providerB = "";
      assertEquals(
        await t.step(
          "两普通owner在Web创建独立Provider、RPM/TPM并测试真实连接",
          async () => {
            providerA = await createProvider(
              browserA.page,
              a,
              `Provider A ${suffix}`,
              modelA,
            );
            providerB = await createProvider(
              browserB.page,
              b,
              `Provider B ${suffix}`,
              modelB,
            );
            assertNotEquals(providerA, providerB);
            await createAlias(browserA.page, a, `Provider A ${suffix}`, modelA);
            await createAlias(browserB.page, b, `Provider B ${suffix}`, modelB);
          },
        ),
        true,
      );
      assertEquals(
        await t.step(
          "同域两tab旧revision409，原模型输入与旧依据保留",
          async () => {
            await gotoPage(stale, `/d/${a.slug}/llm`);
            await stale.getByRole("button", { name: "编辑别名", exact: true })
              .click();
            await stale.getByRole("textbox", {
              name: "别名实际模型",
              exact: true,
            }).fill(`${modelA}-stale-input`);
            const saved = await editAlias(browserA.page, a, currentA);
            assertEquals(saved.request.headers()["if-match"], "1");
            const conflict = await write(
              stale,
              a,
              "PUT",
              "model-aliases/fast",
              () =>
                stale.getByRole("button", { name: "保存别名", exact: true })
                  .click(),
              409,
            );
            assertEquals(conflict.request.headers()["if-match"], "1");
            await expect(
              stale.getByRole("textbox", { name: "别名实际模型", exact: true }),
            ).toHaveValue(`${modelA}-stale-input`);
            await expect(stale.getByText(/revision 已变化/)).toBeVisible();
            const state = await llmFixtureApi<
              { data: Array<{ model: string; domain_id: string }> }
            >("GET", `/domains/${a.slug}/llm/model-aliases`, a.owner.token);
            assertEquals(state.data[0].model, currentA);
            assertEquals(state.data[0].domain_id, a.id);
          },
        ),
        true,
      );
      assertEquals(
        await t.step(
          "Judge→Gateway实际调用使用受理域快照，后续别名变更只影响新尝试",
          async () => {
            const idA = await submitLlmGovernance(
                a,
                f.student,
                f.ref,
                f.versionId,
              ),
              idB = await submitLlmGovernance(b, f.student, f.ref, f.versionId);
            const [attempt] =
              await sql`SELECT ea.id,ea.task_snapshot,s.domain_id,ea.state FROM evaluation_attempts ea JOIN submissions s ON s.id=ea.submission_id WHERE s.id=${idA} ORDER BY ea.sequence DESC LIMIT 1`;
            assertEquals(attempt.domain_id, a.id);
            assertEquals(
              ["queued", "judging"].includes(attempt.state),
              true,
              "更新模型前原尝试必须仍在途",
            );
            assertEquals(attempt.task_snapshot.llm_execution.domain_id, a.id);
            assertEquals(
              attempt.task_snapshot.llm_execution.provider_id,
              providerA,
            );
            assertEquals(attempt.task_snapshot.llm_execution.models, [{
              alias: "fast",
              model: currentA,
            }]);
            await editAlias(browserA.page, a, nextA);
            await Promise.all([
              finishLlmGovernance(a, f.student, idA),
              finishLlmGovernance(b, f.student, idB),
            ]);
            for (
              const [school, id, provider, model] of [[
                a,
                idA,
                providerA,
                currentA,
              ], [b, idB, providerB, modelB]] as const
            ) {
              const rows = await llmGovernanceUsage(school, id);
              assertEquals(rows.length, 1);
              assertEquals(rows[0].domain_id, school.id);
              assertEquals(rows[0].provider_id, provider);
              assertEquals(rows[0].model, model);
              assertEquals(rows[0].total_tokens, 8);
              assertEquals(rows[0].status, "ok");
              assertEquals(rows[0].problem_id, f.problemId);
              assertEquals(rows[0].problem_version_id, f.versionId);
              if (school.id === a.id) {
                assertEquals(rows[0].attempt_id, attempt.id);
              }
            }
            const crossed = await llmFixtureApi<{ data: unknown[] }>(
              "GET",
              `/domains/${b.slug}/llm/usage?submission_id=${idA}`,
              b.owner.token,
            );
            assertEquals(crossed.data, []);
            const fresh = await submitLlmGovernance(
              a,
              f.student,
              f.ref,
              f.versionId,
            );
            await finishLlmGovernance(a, f.student, fresh);
            assertEquals((await llmGovernanceUsage(a, fresh))[0].model, nextA);
            const [original] =
              await sql`SELECT task_snapshot FROM evaluation_attempts WHERE id=${attempt.id}`;
            assertEquals(original.task_snapshot.llm_execution.models, [{
              alias: "fast",
              model: currentA,
            }]);
            const mockUrl = Deno.env.get("E2E_LLM_MOCK_INSPECT_URL");
            if (!mockUrl) throw new Error("需要专用 mock 的只读模型记录入口");
            const mockResponse = await fetch(mockUrl);
            assertEquals(mockResponse.status, 200);
            const mock = await mockResponse.json() as {
              requests: Array<{ path: string; model: string }>;
            };
            assertEquals(
              mock.requests.filter((row) => row.model === currentA).length,
              1,
              "原尝试实际上游收到冻结模型",
            );
            assertEquals(
              mock.requests.filter((row) => row.model === nextA).length,
              1,
              "后续尝试实际上游收到新模型",
            );
            assertEquals(
              mock.requests.some((row) => row.model === modelB),
              true,
            );
            for (
              const [page, model] of [[browserA.page, nextA], [
                browserB.page,
                modelB,
              ]] as const
            ) {
              await page.getByRole("textbox", {
                name: "按题筛选用量",
                exact: true,
              }).fill(f.problemId);
              await page.getByRole("button", { name: "刷新用量", exact: true })
                .click();
              await expect(page.getByText(new RegExp(`${model}.*8 Token`)))
                .toBeVisible();
            }
          },
        ),
        true,
      );
      failed = false;
    } finally {
      await sql.end();
      await stale.close();
      await teardownBrowser(browserA, failed, `llm-governance-a-${suffix}`);
      await teardownBrowser(browserB, failed, `llm-governance-b-${suffix}`);
    }
  },
});
