/// <reference lib="dom" />
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import postgres from "npm:postgres@3.4.5";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { getAdminToken, TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  UI_URL,
  withBrowserJourney,
} from "./browser.ts";
import { readEvaluationGate } from "../../fixtures/evaluation-gate.ts";
import {
  copyLlmGovernanceProblem,
  createLlmGovernanceFixture,
  createLlmGovernanceGate,
  deleteLlmGovernanceGate,
  finishLlmGovernance,
  type LlmAccount,
  llmFixtureApi,
  type LlmGovernanceCopy,
  type LlmGovernanceGate,
  llmGovernanceUsage,
  type LlmSchool,
  releaseLlmGovernanceGate,
  submitLlmGovernance,
  waitForLlmGovernanceArrival,
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
    const [label, value] of [["Provider 名称", name], [
      "Provider Base URL",
      Deno.env.get("E2E_LLM_MOCK_URL") || "http://noj-e2e-llm-mock:8002/v1",
    ], ["Provider API Key", "isolated-e2e-mock-key"]]
  ) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
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
    () =>
      dialog.getByRole("button", { name: "保存 Provider", exact: true })
        .click(),
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

/** 释放并删除屏障；两个动作分别记录，避免一个失败掩盖另一个。 */
async function cleanupLlmGovernanceGate(
  gate: LlmGovernanceGate,
): Promise<void> {
  const errors: string[] = [];
  try {
    await releaseLlmGovernanceGate(gate);
  } catch (error) {
    errors.push(
      `释放屏障失败：${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    await deleteLlmGovernanceGate(gate);
  } catch (error) {
    errors.push(
      `删除屏障失败：${error instanceof Error ? error.message : error}`,
    );
  }
  if (errors.length) {
    throw new AggregateError(errors, `评测屏障清理失败：${errors.join("；")}`);
  }
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
    const dbUrl = Deno.env.get("E2E_LLM_GOVERNANCE_DATABASE_URL") ||
      Deno.env.get("DATABASE_URL");
    if (!dbUrl) throw new Error("需要隔离测试数据库以只读核对受理快照");
    // 第 1 步的前置：屏障必须先于评测任务存在。evaluator 启动后立刻 wait，
    // gate 不存在会直接 404 失败，而不是静默跳过。放在 sql 之前：协调服务不可用时
    // 直接失败，不会留下未关闭的连接池。
    const gate = await createLlmGovernanceGate(suffix);
    const sql = postgres(dbUrl, { max: 1 });
    let passed = false;
    try {
      await withBrowserJourney("workspace-llm-governance", async (journey) => {
        const browserA = await journey.newSession("school-a"),
          browserB = await journey.newSession("school-b");
        // A 上下文里的第二个页面，保留原来的 stale revision 语义。
        const stale = await browserA.context.newPage();
        let cleanupError: Error | undefined;
        try {
          const f = await createLlmGovernanceFixture(suffix, gate);
          const [a, b] = f.schools;
          await login(browserA.page, a.owner);
          await login(browserB.page, b.owner);
          const modelA = `llmgov-a-${suffix}`,
            modelB = `llmgov-b-${suffix}`,
            currentA = `${modelA}-current`,
            nextA = `${modelA}-next`;
          let providerA = "", providerB = "";
          const copies: Record<string, LlmGovernanceCopy> = {};
          let idA = "", idB = "", attemptId = "";
          assertEquals(
            await t.step(
              "1. 唯一屏障写入 evaluator 夹具，固定休眠已删除",
              async () => {
                const status = await readEvaluationGate(
                  gate.placement,
                  gate.id,
                );
                assertEquals(status.arrivals, 0);
                assertEquals(status.released, false);
                assertEquals(status.cancelled, false);
                // 夹具写进 evaluate.py 的是容器网络地址与 gate 标识；
                // 原来的 time.sleep(20) 必须彻底消失。
                assertEquals(f.evaluatorScript.includes("time.sleep"), false);
                assertEquals(
                  f.evaluatorScript.includes(gate.placement.evaluatorUrl),
                  true,
                );
                assertEquals(f.evaluatorScript.includes(gate.id), true);
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "2. 两普通owner在Web创建独立Provider、RPM/TPM并测试真实连接",
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
                await createAlias(
                  browserA.page,
                  a,
                  `Provider A ${suffix}`,
                  modelA,
                );
                await createAlias(
                  browserB.page,
                  b,
                  `Provider B ${suffix}`,
                  modelB,
                );
                const admin = await getAdminToken();
                for (const school of [a, b]) {
                  copies[school.id] = await copyLlmGovernanceProblem(
                    school,
                    f.ref,
                    admin,
                  );
                }
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "3. 同域两tab旧revision409，原模型输入与旧依据保留",
              async () => {
                await gotoPage(stale, `/d/${a.slug}/llm`);
                await stale.getByRole("button", {
                  name: "编辑别名",
                  exact: true,
                })
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
                    stale.getByRole("button", {
                      name: "保存别名",
                      exact: true,
                    })
                      .click(),
                  409,
                );
                assertEquals(conflict.request.headers()["if-match"], "1");
                await expect(
                  stale.getByRole("textbox", {
                    name: "别名实际模型",
                    exact: true,
                  }),
                ).toHaveValue(`${modelA}-stale-input`);
                // Core 将 Gateway 的冲突映射为稳定的用户可读错误；revision
                // 细节仍由请求/响应和后续状态查询核对，不依赖内部原始文案。
                await expect(
                  stale.getByText("LLM 资源已修改，请重新读取", {
                    exact: true,
                  }),
                ).toBeVisible();
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
              "4. 提交A、B并等到一个evaluator到达屏障，核对两条在途尝试与A冻结快照",
              async () => {
                const copyA = copies[a.id], copyB = copies[b.id];
                idA = await submitLlmGovernance(
                  a,
                  f.student,
                  copyA.ref,
                  copyA.versionId,
                );
                idB = await submitLlmGovernance(
                  b,
                  f.student,
                  copyB.ref,
                  copyB.versionId,
                );
                // 只等一个：Judge 并发 1 时第二个 evaluator 要等第一个结束才启动，
                // 等两个会死锁。屏障上限 45 秒，短于 evaluator 的 60 秒时限。
                const arrived = await waitForLlmGovernanceArrival(gate, 1);
                assertEquals(
                  arrived.arrivals >= 1,
                  true,
                  "必须至少一个 evaluator 真实到达屏障",
                );
                assertEquals(arrived.released, false);
                assertEquals(arrived.cancelled, false);
                const [attempt] =
                  await sql`SELECT ea.id,ea.task_snapshot,s.domain_id,ea.state FROM evaluation_attempts ea JOIN submissions s ON s.id=ea.submission_id WHERE s.id=${idA} ORDER BY ea.sequence DESC LIMIT 1`;
                const [attemptB] =
                  await sql`SELECT ea.id,ea.state FROM evaluation_attempts ea JOIN submissions s ON s.id=ea.submission_id WHERE s.id=${idB} ORDER BY ea.sequence DESC LIMIT 1`;
                assertEquals(attempt !== undefined, true, "A 的尝试必须已受理");
                assertEquals(
                  attemptB !== undefined,
                  true,
                  "B 的尝试必须已受理",
                );
                assertEquals(attempt.domain_id, a.id);
                assertEquals(
                  ["queued", "judging"].includes(attempt.state),
                  true,
                  "屏障期间原尝试必须仍在途",
                );
                assertEquals(
                  ["queued", "judging"].includes(attemptB.state),
                  true,
                  "屏障期间 B 的尝试也必须仍在途",
                );
                assertEquals(
                  attempt.task_snapshot.llm_execution.domain_id,
                  a.id,
                );
                assertEquals(
                  attempt.task_snapshot.llm_execution.provider_id,
                  providerA,
                );
                assertEquals(attempt.task_snapshot.llm_execution.models, [{
                  alias: "fast",
                  model: currentA,
                }]);
                attemptId = attempt.id;
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "5. 经原UI修改A模型别名，尝试仍在途",
              async () => {
                await editAlias(browserA.page, a, nextA);
                const [row] =
                  await sql`SELECT state FROM evaluation_attempts WHERE id=${attemptId}`;
                assertEquals(
                  ["queued", "judging"].includes(row.state),
                  true,
                  "改模型期间原尝试必须仍在途（屏障未提前释放）",
                );
                const alias = await llmFixtureApi<
                  { data: Array<{ model: string }> }
                >("GET", `/domains/${a.slug}/llm/model-aliases`, a.owner.token);
                assertEquals(alias.data[0].model, nextA);
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "6. 释放屏障，两次真实评测完成并核对原模型、域归属与用量",
              async () => {
                const released = await releaseLlmGovernanceGate(gate);
                assertEquals(released.released, true);
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
                  assertEquals(rows[0].problem_id, copies[school.id].problemId);
                  assertEquals(
                    rows[0].problem_version_id,
                    copies[school.id].versionId,
                  );
                  if (school.id === a.id) {
                    assertEquals(rows[0].attempt_id, attemptId);
                  }
                }
                const crossed = await llmFixtureApi<{ data: unknown[] }>(
                  "GET",
                  `/domains/${b.slug}/llm/usage?submission_id=${idA}`,
                  b.owner.token,
                );
                assertEquals(crossed.data, []);
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "7. 再提交A：已释放屏障立即通过，新尝试用新模型",
              async () => {
                const copyA = copies[a.id];
                const before = await readEvaluationGate(
                  gate.placement,
                  gate.id,
                );
                const fresh = await submitLlmGovernance(
                  a,
                  f.student,
                  copyA.ref,
                  copyA.versionId,
                );
                await finishLlmGovernance(a, f.student, fresh);
                assertEquals(
                  (await llmGovernanceUsage(a, fresh))[0].model,
                  nextA,
                );
                const [freshAttempt] =
                  await sql`SELECT task_snapshot FROM evaluation_attempts WHERE submission_id=${fresh} ORDER BY sequence DESC LIMIT 1`;
                assertEquals(
                  freshAttempt.task_snapshot.llm_execution.models,
                  [{ alias: "fast", model: nextA }],
                );
                // 新 evaluator 必须真实经过屏障：计数增加且释放状态保持。
                const after = await readEvaluationGate(gate.placement, gate.id);
                assertEquals(after.released, true);
                assertEquals(
                  after.arrivals > before.arrivals,
                  true,
                  "新 evaluator 必须真实到达已释放的屏障",
                );
              },
            ),
            true,
          );
          assertEquals(
            await t.step(
              "8. 保留冻结快照、Mock上游收到正确模型，用量页按题展示",
              async () => {
                const copyA = copies[a.id], copyB = copies[b.id];
                const [original] =
                  await sql`SELECT task_snapshot FROM evaluation_attempts WHERE id=${attemptId}`;
                assertEquals(original.task_snapshot.llm_execution.models, [{
                  alias: "fast",
                  model: currentA,
                }]);
                const mockUrl = Deno.env.get("E2E_LLM_MOCK_INSPECT_URL");
                if (!mockUrl) {
                  throw new Error("需要专用 mock 的只读模型记录入口");
                }
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
                  const [page, model, slug, problemId] of [[
                    browserA.page,
                    nextA,
                    a.slug,
                    copyA.problemId,
                  ], [
                    browserB.page,
                    modelB,
                    b.slug,
                    copyB.problemId,
                  ]] as const
                ) {
                  await gotoPage(page, `/d/${slug}/settings/llm/usage`);
                  await page.getByRole("textbox", {
                    name: "按题筛选用量",
                    exact: true,
                  }).fill(problemId);
                  await page.getByRole("button", {
                    name: "刷新用量",
                    exact: true,
                  })
                    .click();
                  await expect(page.getByText(new RegExp(`${model}.*8 Token`)))
                    .toBeVisible();
                }
              },
            ),
            true,
          );
          passed = true;
        } finally {
          // 第 9 步：无论 UI 步骤成功还是抛错，都要立刻放行 evaluator 并删除 gate，
          // 不能让评测容器一直阻塞到屏障超时。
          try {
            const stepPassed = await t.step(
              "9. 释放并删除屏障，清理失败必须显式报告",
              () => cleanupLlmGovernanceGate(gate),
            );
            if (!stepPassed) {
              cleanupError = new Error("评测屏障清理失败（详见第 9 步输出）");
            }
          } catch (error) {
            cleanupError = error instanceof Error
              ? error
              : new Error(String(error));
          }
          try {
            await stale.close();
          } catch (error) {
            // 收尾失败不能覆盖已经发生的业务失败，只记录下来一并报告。
            cleanupError ??= error instanceof Error
              ? error
              : new Error(String(error));
          }
          if (cleanupError && !passed) {
            // 用例已经失败时只报告，避免覆盖原始失败原因。
            console.error(
              `评测屏障清理失败（用例已失败，保留原始错误）：${cleanupError.message}`,
            );
          }
        }
        // 清理失败且用例其余部分通过时必须让用例失败（不在 finally 里 throw，
        // 否则会掩盖原始异常并触发 no-unsafe-finally）。
        if (cleanupError && passed) throw cleanupError;
      });
    } finally {
      await sql.end();
    }
  },
});
