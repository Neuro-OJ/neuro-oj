/// <reference lib="dom" />
/**
 * UI 浏览器关键流程 E2E（issue #427）。
 *
 * 通过 Playwright 真实操作浏览器，覆盖 API E2E 无法触达的页面交互：
 *   1. 注册 → 跳转邮箱验证页（registered=1&sent=1，依赖 register.vue 的 sent 作用域）
 *   2. 登录 → 退出（UserMenu → 登出 → 确认弹窗）
 *   3. 代码提交到评测结果（恢复草稿 → 提交评测 → 提交详情得分）
 *   4. 核心失败反馈（错误答案提交 → 已完成且非满分）
 *
 * 运行前置（完整栈，同 noj-tests E2E）：
 *   - noj-core（E2E_BASE_URL，默认 :8099）+ judge worker
 *   - noj-ui 已构建并监听 E2E_UI_URL（默认 :3000），NUXT_API_BASE 指向 noj-core
 *   - Playwright 浏览器：`deno run -A npm:playwright install chromium`
 *
 * 启用：NOJ_RUN_BROWSER_E2E=1 deno task test:browser
 * Fork PR 无需任何生产凭据（issue #427 验收项）。
 */

import {
  api,
  apiGet,
  BASE_URL,
  CODE_SAMPLES,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { domainAnswerKey } from "../../../noj-ui/utils/domain-problems.ts";

const BROWSER_E2E = Deno.env.get("NOJ_RUN_BROWSER_E2E") === "1";
const UI_URL = Deno.env.get("E2E_UI_URL") || "http://localhost:3000";
const ARTIFACT_DIR = "test-results/ui-browser";

// ── 测试数据 ──────────────────────────────────────
const ts = Date.now().toString(36);
const USERNAME = `ui_browser_${ts}`;
const EMAIL = `${USERNAME}@test.com`;
// 提交流程专用：#441 邮件就绪门槛要求已验证邮箱，经 API 注册并完成验证
const SUBMIT_USER = `ui_submit_${ts}`;
let submitToken = "";
let problemNumber = 0;

/** 当前 main 域编辑者导入独立 v2 题包并显式发布，种子题的比赛保密不影响此旅程。 */
async function prepareProblemFixture(): Promise<void> {
  const email = `ui_editor_${ts}@test.com`;
  const editor = await registerUser(`ui_editor_${ts}`, email, TEST_PASSWORD);
  const admin = await getAdminToken();
  const invitation = await api("POST", "/api/v1/domains/main/invitations", {
    token: admin,
    body: { email },
  });
  assertEquals(invitation.status, 201);
  const joined = await api("POST", "/api/v1/domain-invitations/accept", {
    token: editor,
    body: {
      token: (invitation.body as { data: { token: string } }).data.token,
    },
  });
  assertEquals(joined.status, 200);
  const identity = await apiGet("/api/v1/auth/me", editor);
  assertEquals(identity.status, 200);
  const userId = (identity.body as { data: { id: string } }).data.id;
  const granted = await api(
    "PUT",
    `/api/v1/domains/main/members/${userId}/roles`,
    {
      token: admin,
      body: { roles: ["editor"] },
    },
  );
  assertEquals(granted.status, 200);
  const bytes = zipSync({
    "problem.json": strToU8(JSON.stringify({
      format_version: 2,
      title: `uibrowser${ts} 独立加法题`,
      difficulty: "easy",
      judge_type: "dual",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          time_limit_ms: 10000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      },
    })),
    "statement.md": strToU8(
      "# A+B\nsolve(input_str) 接受两个整数，返回它们的和。满分10分。",
    ),
    "evaluate.py": strToU8(`from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    if runner.call("solve", "1 2") == "3":
        result.accept(score=10)
    else:
        result.wrong_answer(score=0)
finally:
    runner.close()
`),
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
    "browser.zip",
  );
  const imported = await fetch(
    `${BASE_URL}/api/v1/domains/main/problems/import-bundle`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${editor}` },
      body: form,
    },
  );
  const response = await imported.json();
  assertEquals(imported.status, 201, JSON.stringify(response));
  const problem = response.data as { number: number; draft_revision: number };
  problemNumber = problem.number;
  const published = await api(
    "POST",
    `/api/v1/domains/main/problems/${problem.number}/publish`,
    {
      token: editor,
      headers: { "If-Match": String(problem.draft_revision) },
      body: { change_note: "浏览器实际评测独立公开版本" },
    },
  );
  assertEquals(published.status, 200, JSON.stringify(published.body));
}

// ── 共享浏览器会话 ────────────────────────────────
let browser: import("npm:playwright@1.62.1").Browser | null = null;
let context: import("npm:playwright@1.62.1").BrowserContext | null = null;
let page: import("npm:playwright@1.62.1").Page | null = null;

async function launch(): Promise<void> {
  const { chromium } = await import("npm:playwright@1.62.1");
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  // 失败诊断产物：截图 + trace（issue #427「失败保留浏览器诊断产物」）
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  page = await context.newPage();
  page.on("pageerror", (err) => {
    console.error(`  [browser pageerror] ${err.message}`);
  });
}

async function teardown(failed: boolean): Promise<void> {
  if (!context || !browser) return;
  try {
    if (failed) {
      await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
      await context.tracing.stop({ path: `${ARTIFACT_DIR}/trace-${ts}.zip` });
      await page?.screenshot({
        path: `${ARTIFACT_DIR}/failure-${ts}.png`,
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
    browser = null;
    context = null;
    page = null;
  }
}

// ── 页面操作辅助 ──────────────────────────────────

function mustPage(): import("npm:playwright@1.62.1").Page {
  if (!page) throw new Error("browser 未启动");
  return page;
}

async function goto(
  path: string,
): Promise<import("npm:playwright@1.62.1").Page> {
  const p = mustPage();
  await p.goto(`${UI_URL}${path}`, { waitUntil: "domcontentloaded" });
  return p;
}

async function registerViaUI(
  username: string,
  email: string,
  password: string,
): Promise<void> {
  const p = await goto("/register");
  await p.getByPlaceholder("3-30 位字母、数字或下划线").fill(username);
  await p.getByPlaceholder("请输入邮箱地址").fill(email);
  await p.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(password);
  await p.getByPlaceholder("再次输入密码").fill(password);
  // PIPL 硬门槛：未勾选同意条款时注册按钮 disabled，须先勾选
  await p.getByRole("checkbox", { name: "同意服务条款与隐私政策" }).check();
  await p.getByRole("button", { name: "注册", exact: true }).click();
}

async function loginViaUI(username: string, password: string): Promise<void> {
  const p = await goto("/login");
  await p.getByPlaceholder("请输入用户名或邮箱").fill(username);
  await p.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(password);
  await p.getByRole("button", { name: "登录", exact: true }).click();
  // 登录成功后跳离 /login（首页或回跳目标）
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
  // 读取同一浏览器账号的当前法律状态；需要重新同意时操作真实弹窗，不绕过记录端点。
  const identity = await p.request.get(`${UI_URL}/api/v1/auth/me`);
  assertEquals(identity.status(), 200);
  const current = await identity.json() as {
    data: {
      legal?: Record<string, { needs_consent: boolean; is_material: boolean }>;
    };
  };
  if (
    Object.values(current.data.legal ?? {}).some((item) =>
      item.needs_consent && item.is_material
    )
  ) {
    const consent = p.getByRole("dialog", { name: "政策更新通知" });
    await consent.waitFor({ state: "visible", timeout: 15_000 });
    await consent.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await consent.waitFor({ state: "hidden", timeout: 15_000 });
  }
}

async function logoutViaUI(): Promise<void> {
  const p = mustPage();
  await p.locator('button[aria-label="用户菜单"]').click();
  await p.getByRole("menuitem", { name: "登出" }).click();
  // 统一 useDialog 确认弹窗
  await p.getByRole("button", { name: "确认登出" }).click();
  // 登出后回到未登录态（导航栏出现「登录」链接）
  await p.locator('a[href="/login"]').first().waitFor({ timeout: 15_000 });
}

/**
 * 预置代码草稿并打开编辑器提交。
 *
 * 不模拟键入/粘贴：Monaco auto-indent 会破坏 insertText 的缩进
 * （IndentationError → solution host 注册不到 solve 函数），headless 下
 * 剪贴板 API 又被权限拒绝，合成 paste 事件在 Chromium 中无法携带数据。
 * 改用当前账号、使用域、源题、版本和语言对应的编辑器草稿预置代码，
 * 恢复路径与真实用户「刷新后继续上次代码」完全一致。
 */
async function submitCodeViaUI(code: string): Promise<void> {
  const p = page!;
  const identity = await apiGet("/api/v1/auth/me", submitToken);
  const detail = await apiGet(
    `/api/v1/domains/main/problems/${problemNumber}`,
    submitToken,
  );
  if (identity.status !== 200 || detail.status !== 200) {
    throw new Error("无法读取当前作答身份或默认域题目");
  }
  const actor = (identity.body as { data: { id: string } }).data.id;
  const problem = detail.body as {
    reference: { problem_id: string };
    version_id: string;
    supported_languages: string[];
  };
  const key = domainAnswerKey(
    actor,
    "main",
    problem.reference.problem_id,
    problem.version_id,
    problem.supported_languages[0],
  );
  await p.addInitScript(
    ({ key, content }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ code: content, answers: {} }),
      );
    },
    { key: `noj:draft:${key}`, content: code },
  );
  await goto(`/d/main/problems/${problemNumber}`);
  // 编辑器就绪后提交（草稿在 onMounted 恢复为初始代码，优先于 starter 模板）
  await p.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  await p.getByRole("button", { name: "提交评测", exact: true }).click();
  await p.getByRole("link", { name: "查看评测", exact: true }).click();
  await p.waitForURL(/\/d\/main\/submissions\//);
}

/** 读取当前提交详情的得分；尚未获得终态时返回 null。 */
async function currentScoreText(): Promise<string | null> {
  const p = mustPage();
  const result = p.getByRole("heading", { name: "评测结果", exact: true });
  if (await result.count() === 0) return null;
  const span = result.locator("..").locator("span").filter({
    hasText: /^\d+(?:\.\d+)?\s*分$/,
  }).first();
  if ((await span.count()) === 0) return null;
  const text = (await span.textContent()) ?? "";
  return /\d+\s*分/.test(text) ? text.trim() : null;
}

/**
 * 等待一条"新的"评测结论：与 prevScore 不同的得分文本出现。
 * 侧栏一次只显示一张最近提交卡片；提交后卡片会先变为 等待评测/评测中（无得分），
 * 终态后显示「N 分」。轮询由前端完成，这里按 1s 间隔轮询 UI。
 */
async function waitForNewVerdict(
  prevScore: string | null,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await currentScoreText();
    if (text !== null && text !== prevScore) return text;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `等待评测结论超时（${timeoutMs}ms），prevScore=${prevScore ?? "无"}`,
  );
}

// ── 测试用例 ──────────────────────────────────────

Deno.test("[ui/browser] 前置：浏览器会话启动", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  let failed = true;
  try {
    await launch();
    const ui = await fetch(UI_URL);
    if (!ui.ok) throw new Error(`noj-ui 未就绪 (${UI_URL} → ${ui.status})`);
    await ui.body?.cancel();
    await prepareProblemFixture();
    failed = false;
  } finally {
    if (failed) await teardown(true);
  }
});

Deno.test("[ui/browser] 1/4 注册 → 跳转邮箱验证页（sent=1）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await registerViaUI(USERNAME, EMAIL, TEST_PASSWORD);
    const p = mustPage();
    // 注册成功后自动登录并跳转 verify-email，携带 registered=1&sent=1
    //（register.vue 的 sent 作用域修复正是本门禁的起点，见 issue #427）
    await p.waitForURL(/\/verify-email\?registered=1&sent=1/, {
      timeout: 20_000,
    });
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 2/4 登录 → 退出", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    await loginViaUI(USERNAME, TEST_PASSWORD);
    await logoutViaUI();
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 3/4 代码提交 → 评测结果（满分 10 分）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    // 门禁直接验证真实提交；judge 故障必须超时失败并保存诊断产物，不能跳过。
    submitToken = await registerUser(
      SUBMIT_USER,
      `${SUBMIT_USER}@test.com`,
      TEST_PASSWORD,
    );
    await loginViaUI(SUBMIT_USER, TEST_PASSWORD);
    await submitCodeViaUI(CODE_SAMPLES.accepted);
    const score = await waitForNewVerdict(null);
    // 独立题包满分 10 分，允许 UI 保留小数位。
    if (Number.parseFloat(score) !== 10) {
      throw new Error(`期望满分「10 分」，实际「${score}」`);
    }
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 4/4 核心失败反馈（错误答案非满分 10 分）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    submitToken = await registerUser(
      SUBMIT_USER,
      `${SUBMIT_USER}@test.com`,
      TEST_PASSWORD,
    );
    await loginViaUI(SUBMIT_USER, TEST_PASSWORD);
    // 先读取上一条（3/4 满分卡片的分数），等待新结论覆盖
    await goto(`/d/main/problems/${problemNumber}`);
    const prev = await currentScoreText();
    await submitCodeViaUI(CODE_SAMPLES.wrongAnswer);
    const score = await waitForNewVerdict(prev);
    if (Number.parseFloat(score) === 10) {
      throw new Error(`错误答案不应满分，实际「${score}」`);
    }
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 5/5 登录失败显示错误提示", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    const p = await goto("/login");
    await p.getByPlaceholder("请输入用户名或邮箱").fill("nonexistent@test.com");
    await p.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
      "WrongPass123",
    );
    await p.getByRole("button", { name: "登录", exact: true }).click();
    // 登录失败后 ToastBanner 以 role=status 展示错误
    await p.locator('[role="status"]').first().waitFor({ timeout: 10_000 });
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 6/6 不存在的题目呈现 404（不再退化为加载失败面板）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    const p = await goto("/editor/NOEXIST");
    // 2026-09-26：题目不存在（含"被公开赛保密而对当前用户不可见"，后端同返 404）
    // 统一呈现为 404 状态；非 404 的加载失败仍走 EditorWorkspace 的错误面板。
    await p.getByText("404", { exact: true }).waitFor({ timeout: 10_000 });
    await p.getByText("题目不存在").waitFor({ timeout: 10_000 });
    failed = false;
  } finally {
    await teardown(failed);
  }
});
