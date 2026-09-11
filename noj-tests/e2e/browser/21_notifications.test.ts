/// <reference lib="dom" />
/**
 * 社区通知点击行为浏览器 E2E。
 *
 * 回归两条缺陷：
 *   1. 「没有可跳转关联内容」的通知（这里用封禁通知构造）点击后曾回退到 `/community`
 *      首页，现在必须进入通知详情页 `/community/notifications/<id>`；
 *   2. 新增的 `GET /community/notifications/:id` 不得吞掉同前缀的字面量路由
 *      ——`/notifications/events`（SSE）与 `/notifications/unread-count` 必须仍是 200。
 *      该缺陷依赖 app.ts 的挂载顺序，只测端点不够，必须在页面上观察真实请求。
 *
 * 运行前置（完整栈）：noj-core + noj-ui + 种子 admin（e2e_admin@test.com）。
 * 启用：NOJ_RUN_BROWSER_E2E=1 deno task test:browser
 */

import {
  BROWSER_E2E,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import {
  api,
  apiGet,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";

type Page = import("npm:playwright@1.62.1").Page;

const ts = Date.now().toString(36);
/** 被封禁后收到封禁通知的普通用户 */
const BANNED_USER = {
  username: `notif_ban_${ts}`,
  email: `notif_ban_${ts}@test.com`,
  password: TEST_PASSWORD,
};

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector("#__nuxt")), {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
}

/**
 * 等待页面正文出现指定文本。
 *
 * 不能改用「等待标题出现」作为数据就绪信号：详情页的标题在所有状态下都渲染
 * （加载中/未找到/有数据），等它出现只代表组件挂载完成，此时 API 可能尚未返回，
 * 直接读 innerText 会读到「加载中…」——CI 上曾因此偶发失败。
 * 这里统一以**状态特有文本**作为同步点。
 */
async function waitForMainText(
  page: Page,
  text: string,
  timeout = 20_000,
): Promise<string> {
  const main = page.locator("#main");
  await page.waitForFunction(
    (needle) => {
      const el = document.querySelector("#main");
      return Boolean(el && (el.textContent ?? "").includes(needle));
    },
    text,
    { timeout },
  );
  return await main.innerText();
}

/**
 * 注册（幂等）测试用户。
 *
 * 优先用 `registerUser`：E2E 栈会消费邮箱验证令牌把账号置为已验证。
 * 本地 dev core 不暴露该令牌（仅 E2E 环境返回），此时退回「注册 + 直接登录」
 * ——本用例只读通知并接受管理员封禁，不依赖已验证邮箱。
 */
async function ensureUser(
  username: string,
  email: string,
  password: string,
): Promise<void> {
  try {
    await registerUser(username, email, password);
    return;
  } catch (e) {
    console.warn(
      `  [setup] registerUser 不可用，退回注册+登录：${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  await api("POST", "/api/v1/auth/register", {
    body: { username, email, password },
  });
  const login = await api("POST", "/api/v1/auth/login", {
    body: { login: email, password },
  });
  if (login.status !== 200) {
    throw new Error(
      `测试用户登录失败: ${login.status} ${JSON.stringify(login.body)}`,
    );
  }
}

async function loginViaUI(
  page: Page,
  login: string,
  password: string,
): Promise<void> {
  await page.goto(`${UI_URL}/login`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await page.getByPlaceholder("请输入用户名或邮箱").fill(login);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    password,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

/**
 * 造出一条「无关联内容」的通知：管理员封禁目标用户即写入 `ban` 通知
 * （ban 通知天生 post_id/comment_id 为 null），随后立即解封以便该用户登录。
 */
async function seedBanNotification(username: string): Promise<void> {
  const adminToken = await getAdminToken();
  const banned = await api(
    "PATCH",
    `/api/v1/admin/identity/users/${username}/ban`,
    {
      body: { reason: "E2E：构造封禁通知", scope: "platform" },
      token: adminToken,
    },
  );
  if (banned.status !== 200) {
    throw new Error(
      `封禁失败: ${banned.status} ${JSON.stringify(banned.body)}`,
    );
  }

  const history = await apiGet(
    `/api/v1/admin/identity/users/${username}/bans`,
    adminToken,
  );
  const active = (history.body as {
    data?: { updated_at: string; unbanned_at: string | null }[];
  })
    .data?.find((r) => !r.unbanned_at);
  if (!active) throw new Error("未找到生效中的封禁记录");

  // 解封需通过乐观锁：带上封禁记录的 updated_at
  const unbanned = await api(
    "PATCH",
    `/api/v1/admin/identity/users/${username}/unban`,
    { token: adminToken, headers: { "If-Match": `"${active.updated_at}"` } },
  );
  if (unbanned.status !== 200) {
    throw new Error(
      `解封失败: ${unbanned.status} ${JSON.stringify(unbanned.body)}`,
    );
  }
}

Deno.test("[ui/browser] 通知：封禁通知点击进入详情页，且字面量路由未被吞", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  await ensureUser(
    BANNED_USER.username,
    BANNED_USER.email,
    BANNED_USER.password,
  );
  await seedBanNotification(BANNED_USER.username);

  const session = await launchBrowser();
  let failed = true;
  try {
    const { page } = session;

    // 页面级 404 采集：`:id` 若吞掉 /notifications/events 或 unread-count，这里会看到 404
    const notFound: string[] = [];
    page.on("response", (r) => {
      if (r.status() === 404) {
        notFound.push(`${r.request().method()} ${r.url().replace(UI_URL, "")}`);
      }
    });

    await loginViaUI(page, BANNED_USER.email, BANNED_USER.password);
    await page.goto(`${UI_URL}/community/notifications`, {
      waitUntil: "domcontentloaded",
    });
    await waitForHydration(page);

    const card = page.locator("#main button").filter({ hasText: "封禁通知" })
      .first();
    await card.waitFor({ timeout: 15_000 });
    await card.click();
    await page.waitForTimeout(3_000);

    const path = new URL(page.url()).pathname;
    if (!/^\/community\/notifications\/[0-9a-f-]{36}$/.test(path)) {
      throw new Error(
        `封禁通知点击后应进入 /community/notifications/<id>，实际为 ${page.url()}`,
      );
    }

    // 详情页应展示封禁信息与「无关联内容」说明
    // （同样以状态特有文本同步：标题在加载态就已渲染）
    const text = await waitForMainText(page, "封禁理由");
    if (!text.includes("封禁理由")) {
      throw new Error(`详情页未展示封禁理由：${text.slice(0, 200)}`);
    }

    if (notFound.length > 0) {
      throw new Error(
        `页面出现 404 请求（字面量路由可能被 :id 吞掉）：${
          notFound.join(" | ")
        }`,
      );
    }
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "notifications");
  }
});

Deno.test("[ui/browser] 通知：详情页深链可达且未知 id 显示未找到", async () => {
  if (!BROWSER_E2E) {
    console.log("  ⏭ skip：NOJ_RUN_BROWSER_E2E 未启用");
    return;
  }
  await ensureUser(
    BANNED_USER.username,
    BANNED_USER.email,
    BANNED_USER.password,
  );

  const session = await launchBrowser();
  let failed = true;
  try {
    const { page } = session;

    // 采集该请求的**状态码**：CI 跑的是构建产物（.output/server），
    // 曾因代理把上游状态码重置为 200 而让本页永远停在空白/加载态。
    // 只断言文案会在「代理再次丢状态码」时以超时形式失败（难定位），
    // 这里直接断言 404，失败信息直指根因。
    let detailStatus: number | null = null;
    page.on("response", (r) => {
      if (
        r.url().includes(
          "/api/v1/community/notifications/00000000-0000-4000-8000-000000000000",
        )
      ) {
        detailStatus = r.status();
      }
    });

    await loginViaUI(page, BANNED_USER.email, BANNED_USER.password);

    // 直接打开详情 URL（深链）：必须是详情页而不是回退成列表页
    await page.goto(
      `${UI_URL}/community/notifications/00000000-0000-4000-8000-000000000000`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForHydration(page);
    // 以状态特有文本同步（标题在加载态也已渲染，不能作为就绪信号）
    const text = await waitForMainText(page, "通知不存在");
    if (!text.includes("通知不存在")) {
      throw new Error(`未知通知应显示未找到，实际内容：${text.slice(0, 200)}`);
    }
    if (detailStatus !== 404) {
      throw new Error(
        `未知通知的 API 状态码应为 404（上游 core 返回 404），实际 ${detailStatus}` +
          `——若为 200，说明 Nitro 代理丢失了上游状态码（见 server/api/[...slug].ts）`,
      );
    }
    failed = false;
  } finally {
    await teardownBrowser(session, failed, "notification-detail");
  }
});
