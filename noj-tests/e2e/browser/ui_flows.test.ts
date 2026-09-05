/**
 * UI 浏览器关键流程 E2E（issue #427）。
 *
 * 通过 Playwright 真实操作浏览器，覆盖 API E2E 无法触达的页面交互：
 *   1. 注册 → 跳转邮箱验证页（registered=1&sent=1，依赖 register.vue 的 sent 作用域）
 *   2. 登录 → 退出（UserMenu → 登出 → 确认弹窗）
 *   3. 代码提交到评测结果（编辑器输入 → 提交评测 → 侧栏出现得分）
 *   4. 核心失败反馈（错误答案提交 → 已完成且非满分）
 *
 * 运行前置（完整栈，同 noj-tests E2E）：
 *   - noj-core（E2E_BASE_URL，默认 :8099）+ judge worker + 种子题 P1001
 *   - noj-ui 已构建并监听 E2E_UI_URL（默认 :3000），NUXT_API_BASE 指向 noj-core
 *   - Playwright 浏览器：`deno run -A npm:playwright install chromium`
 *
 * 启用：NOJ_RUN_BROWSER_E2E=1 deno task test:browser
 * Fork PR 无需任何生产凭据（issue #427 验收项）。
 */

import { CODE_SAMPLES, isJudgeAvailable, TEST_PASSWORD } from "../helper.ts";

const BROWSER_E2E = Deno.env.get("NOJ_RUN_BROWSER_E2E") === "1";
const UI_URL = Deno.env.get("E2E_UI_URL") || "http://localhost:3000";
const ARTIFACT_DIR = "test-results/ui-browser";

// ── 测试数据 ──────────────────────────────────────
const ts = Date.now().toString(36);
const USERNAME = `ui_browser_${ts}`;
const EMAIL = `${USERNAME}@test.com`;

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

/** 在编辑器中输入代码并提交评测（Monaco：点击聚焦后整段插入文本） */
async function submitCodeViaUI(code: string): Promise<void> {
  const p = await goto("/editor/P1001");
  // 编辑器页需要登录态；未登录会被 auth 中间件重定向
  await p.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  await p.locator(".monaco-editor").first().click();
  await p.keyboard.insertText(code);
  // 等待 Monaco → Vue 的 code 同步防抖
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: "提交评测", exact: true }).click();
}

/** 读取侧栏「最近」卡片的得分文本；无终态得分（等待/评测中/无记录）时返回 null */
async function currentScoreText(): Promise<string | null> {
  const p = mustPage();
  const span = p.locator("span.font-mono", { hasText: /\d+\s*分/ }).first();
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

Deno.test("[ui/browser] 3/4 代码提交 → 评测结果（满分）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    if (!(await isJudgeAvailable())) {
      console.log("  ⏭ skip：judge worker 不可用");
      failed = false;
      return;
    }
    await loginViaUI(USERNAME, TEST_PASSWORD);
    await submitCodeViaUI(CODE_SAMPLES.accepted);
    const score = await waitForNewVerdict(null);
    if (!score.includes("100")) {
      throw new Error(`期望满分（100 分），实际「${score}」`);
    }
    failed = false;
  } finally {
    await teardown(failed);
  }
});

Deno.test("[ui/browser] 4/4 核心失败反馈（错误答案非满分）", async () => {
  if (!BROWSER_E2E) return;
  let failed = true;
  try {
    await launch();
    if (!(await isJudgeAvailable())) {
      console.log("  ⏭ skip：judge worker 不可用");
      failed = false;
      return;
    }
    await loginViaUI(USERNAME, TEST_PASSWORD);
    // 先读取上一条（3/4 满分卡片的分数），等待新结论覆盖
    await goto("/editor/P1001");
    const prev = await currentScoreText();
    await submitCodeViaUI(CODE_SAMPLES.wrongAnswer);
    const score = await waitForNewVerdict(prev);
    if (score.includes("100")) {
      throw new Error(`错误答案不应满分，实际「${score}」`);
    }
    failed = false;
  } finally {
    await teardown(failed);
  }
});
