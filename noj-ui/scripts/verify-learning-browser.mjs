// 真实本机测试套件只读验收；账号口令由调用方传入，不准备或修改业务数据。
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
const base = Deno.env.get("E2E_UI_URL"),
  password = Deno.env.get("E2E_ADMIN_PASS");
if (
  !base || !password ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
) throw new Error("请提供本机 E2E_UI_URL 和 E2E_ADMIN_PASS");
const output = Deno.env.get("BROWSER_ARTIFACT_DIR") ??
  "/tmp/noj-learning-browser";
await Deno.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(),
  page = await context.newPage(),
  errors = [],
  evidence = [];
page.on("pageerror", (error) => errors.push(error.message));
async function ready() {
  await page.waitForFunction(() =>
    document.querySelector("#__nuxt")?.__vue_app__?.$nuxt?.isHydrating === false
  );
  await page.evaluate(() => document.fonts.ready);
}
async function capture(path, label, heading) {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const response = await page.goto(base + path);
    assert.equal(response.status(), 200, `${label} HTTP 状态`);
    await ready();
    await page.getByRole("heading", { name: heading, exact: true }).first()
      .waitFor();
    await page.waitForTimeout(650);
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
      true,
      `${label} ${width} 横向溢出`,
    );
    await page.screenshot({
      path: `${output}/${label}-${width}.png`,
      fullPage: true,
    });
    evidence.push({ label, width, path });
  }
}
async function read(path) {
  const response = await context.request.get(base + "/api/v1" + path);
  assert(response.ok(), `${path}: ${response.status()}`);
  return response.json();
}
try {
  await capture("/login", "login", "登录");
  assert.equal(
    await page.locator('input[aria-invalid="true"]').count(),
    0,
    "登录初始字段不应报错",
  );
  await page.getByPlaceholder("请输入用户名或邮箱").fill(
    Deno.env.get("E2E_ADMIN_USER") ?? "e2e_admin",
  );
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    password,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await ready();
  const consent = page.getByRole("button", {
    name: "我已知悉并同意",
    exact: true,
  });
  if (await consent.isVisible()) await consent.click();
  await capture("/d/main/problems", "problems", "题库");
  const trainings = await read("/domains/main/trainings?limit=20");
  const training = trainings.items.find((item) => item.title === "E2E 题单") ??
    trainings.items[0];
  assert(training, "需要既有题单夹具");
  await capture("/d/main/trainings/" + training.id, "training", training.title);
  assert.match(await page.locator("body").innerText(), /本页已完成/);
  await capture("/settings", "account", "账号设置");
  const bio = page.getByPlaceholder("用 Markdown 介绍自己...");
  const draft = (await bio.inputValue()) + "\n本机浏览器验证未保存输入";
  await bio.fill(draft);
  await page.getByRole("combobox", { name: "账号设置分组" }).click();
  await page.getByRole("option", { name: "密码与安全", exact: true }).click();
  await page.waitForURL("**/settings#settings-security");
  assert.equal(await bio.inputValue(), draft, "锚点跳转丢失未保存简介");
  await page.getByRole("heading", { name: "密码与安全", exact: true })
    .waitFor();
  const rooms = await read("/domains/coach-lab/classrooms");
  const room = rooms.data[0];
  assert(room, "需要既有课堂夹具");
  await capture("/d/coach-lab/classrooms/" + room.id, "classroom", room.name);
  const assignments = await read(
    "/domains/coach-lab/classrooms/" + room.id + "/assignments",
  );
  const assignment = assignments.data.find((item) => item.published_at);
  assert(assignment, "需要既有已发布作业夹具");
  await capture(
    "/d/coach-lab/assignments/" + assignment.id,
    "assignment",
    assignment.title,
  );
  const toggles = page.locator(
    'ul[aria-label="学生成绩摘要"] button[aria-expanded]',
  );
  assert(await toggles.count() > 0, "手机应有学生摘要");
  await toggles.first().focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggles.first().getAttribute("aria-expanded"), "true");
  assert.deepEqual(errors, [], "真实页面运行错误");
  console.log(
    JSON.stringify({
      screenshots: evidence.length,
      accountDraftPreserved: true,
      mobileSummary: true,
      errors,
    }),
  );
  await Deno.writeTextFile(
    output + "/results.json",
    JSON.stringify({ evidence, errors }, null, 2),
  );
} finally {
  await browser.close();
}
