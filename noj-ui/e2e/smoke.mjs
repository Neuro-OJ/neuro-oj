/**
 * E2E 冒烟测试：完整提交流程（API 提交 + 页面结果验证）
 *
 * 前置条件：
 *   - noj-core (port 8000), noj-ui (port 3000), noj-judge 均在运行
 *   - 数据库已 seed，用户 e2e_test / test123456 已注册
 *
 * 验证路径：
 *   登录 → 通过 API 提交 A+B 代码 → 打开结果页 → 看到 Accepted
 */

import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const API = "http://localhost:8000";

async function waitForAccepted(page) {
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const content = await page.textContent("body").catch(() => "") ?? "";
    if (content.includes("答案正确")) return "Accepted";
    if (content.includes("答案错误")) return "WrongAnswer";
    if (content.includes("系统错误")) return "SystemError";
  }
  return "Timeout";
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  let passed = 0;
  let failed = 0;

  try {
    // ===== Step 1: 登录页面 =====
    console.log("[1/4] 登录...");
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const inputs = page.locator("input");
    await inputs.nth(0).fill("e2e_test");
    await inputs.nth(1).fill("test123456");
    await page.locator("button[type='submit']").click();
    await page.waitForURL("**/", { timeout: 10000 });
    console.log("  ✅ 登录成功");

    // ===== Step 2: 验证题目列表页 =====
    console.log("[2/4] 验证题目列表...");
    await page.goto(`${BASE}/problems`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=A+B Problem", { timeout: 10000 });
    console.log("  ✅ 题目列表有 A+B Problem");

    // ===== Step 3: 通过 API 提交代码 =====
    console.log("[3/4] API 提交代码...");

    // 登录获取 token（Node.js 侧 fetch，避免跨域问题）
    const loginResp = await fetch(`${API}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "e2e_test", password: "test123456" }),
    });
    const loginData = await loginResp.json();
    const token = loginData.data?.token;
    if (!token) throw new Error("获取 token 失败: " + JSON.stringify(loginData));

    // 提交代码
    const submitResp = await fetch(`${API}/api/v1/submissions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        problem_id: "1003",
        language: "python3",
        code: "import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)",
      }),
    });
    const submitData = await submitResp.json();
    const submissionId = submitData.data?.id;

    if (!submissionId) throw new Error("提交失败");
    console.log(`  ✅ 提交成功, id=${submissionId}`);

    // ===== Step 4: 查看结果页 =====
    console.log("[4/4] 等待评测结果...");
    await page.goto(`${BASE}/submissions/${submissionId}`, { waitUntil: "networkidle" });

    const result = await waitForAccepted(page);

    if (result === "Accepted") {
      console.log("  ✅ 评测通过: Accepted");
      passed++;
    } else {
      console.log(`  ❌ 结果: ${result}`);
      const body = await page.textContent("body").catch(() => "");
      console.log(`  page: ${body.substring(0, 300)}`);
      failed++;
    }

    await page.screenshot({ path: "/tmp/e2e-result.png", fullPage: true });
    console.log("  📸 截图: /tmp/e2e-result.png");

  } catch (err) {
    console.error(`\n❌ 异常:`, err instanceof Error ? err.message : String(err));
    await page.screenshot({ path: "/tmp/e2e-error.png", fullPage: true }).catch(() => {});
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
