/// <reference lib="dom" />
/** 域内搜索真实浏览器验收：快捷入口、兼容链接与 URL 状态。 */

import { expect } from "npm:playwright@1.62.1/test";
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import {
  api,
  BASE_URL,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage,
  launchBrowser,
  teardownBrowser,
} from "./browser.ts";

// 每轮创建独立公开题，避免其他 E2E 的进行中比赛使种子题依法保密。
const QUERY = `uisearch${Date.now().toString(36)}`;
const TITLE = `${QUERY} 独立公开搜索题`;
let problemNumber = 0;

async function prepareSearchFixture(): Promise<void> {
  const username = `search_editor_${Date.now().toString(36)}`;
  const email = `${username}@test.com`;
  const editor = await registerUser(username, email, TEST_PASSWORD);
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
  const identity = await api("GET", "/api/v1/auth/me", { token: editor });
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
      title: TITLE,
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
    "statement.md": strToU8("# 独立公开搜索题\n由当前域编辑者导入并显式发布。"),
    "evaluate.py": strToU8(
      "from noj_evaluator_sdk import result\nresult.accept(score=10)\n",
    ),
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
    "search.zip",
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
  const problem = response.data as {
    problem_id: string;
    number: number;
    draft_revision: number;
  };
  problemNumber = problem.number;
  const published = await api(
    "POST",
    `/api/v1/domains/main/problems/${problem.number}/publish`,
    {
      token: editor,
      headers: { "If-Match": String(problem.draft_revision) },
      body: { change_note: "浏览器搜索独立公开版本" },
    },
  );
  assertEquals(published.status, 200, JSON.stringify(published.body));
  // 等待正常持久事件更新索引，不直接刷新或写入搜索表。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const indexed = await api(
      "GET",
      `/api/v1/domains/main/search?q=${QUERY}&type=problem`,
    );
    assertEquals(indexed.status, 200);
    const items =
      (indexed.body as { data: { items: { entity_id: string }[] } }).data.items;
    if (items.some((item) => item.entity_id === problem.problem_id)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`独立公开题 ${problem.number} 未在30秒内进入搜索索引`);
}

Deno.test({
  name: "[ui/browser] 域搜索：根入口与快捷键进入明确域，题目结果可访问",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await launchBrowser();
    let failed = true;
    try {
      await prepareSearchFixture();
      await gotoPage(session.page, "/");
      await session.page.waitForURL((url) => url.pathname === "/d/main");
      await session.page.waitForFunction(() =>
        Boolean(
          (document.querySelector("#__nuxt") as Element & {
            __vue_app__?: unknown;
          })?.__vue_app__,
        )
      );
      await session.page.getByRole("link", { name: "搜索当前域", exact: true })
        .waitFor();
      await session.page.keyboard.press("Control+K");
      await session.page.waitForURL((url) => url.pathname === "/d/main/search");
      await session.page.getByRole("textbox", { name: "域内搜索关键词" }).fill(
        QUERY,
      );
      await session.page.getByRole("button", { name: "搜索", exact: true })
        .click();
      const result = session.page.getByRole("link", {
        name: new RegExp(TITLE),
      });
      await expect(result).toBeVisible();
      await result.click();
      await session.page.waitForURL((url) =>
        url.pathname === `/d/main/problems/${problemNumber}`
      );
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "domain-search-shortcut");
    }
  },
});
Deno.test({
  name: "[ui/browser] 域搜索：旧全局链接固定默认域，刷新保留查询",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await launchBrowser();
    let failed = true;
    try {
      await gotoPage(session.page, `/search?q=${QUERY}&type=problem`);
      await session.page.waitForURL((url) => url.pathname === "/d/main/search");
      await expect(session.page.getByRole("link", { name: new RegExp(TITLE) }))
        .toBeVisible();
      await session.page.reload();
      await expect(
        session.page.getByRole("textbox", { name: "域内搜索关键词" }),
      ).toHaveValue(QUERY);
      await expect(
        session.page.getByRole("button", { name: "全部", exact: true }),
      ).toHaveCount(0);
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "domain-search-legacy");
    }
  },
});
Deno.test({
  name: "[ui/browser] 域搜索：类型切换与返回恢复URL，结果保留当前域",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await launchBrowser();
    let failed = true;
    try {
      await gotoPage(session.page, `/d/main/search?q=${QUERY}&type=problem`);
      await expect(session.page.getByRole("link", { name: new RegExp(TITLE) }))
        .toBeVisible();
      await session.page.getByRole("combobox", { name: "搜索类型" }).click();
      await session.page.getByRole("option", { name: "比赛", exact: true })
        .click();
      await session.page.waitForURL((url) =>
        url.pathname === "/d/main/search" &&
        url.searchParams.get("type") === "contest" &&
        url.searchParams.get("q") === QUERY
      );
      await session.page.goBack();
      await expect(session.page.getByRole("link", { name: new RegExp(TITLE) }))
        .toHaveAttribute("href", `/d/main/problems/${problemNumber}`);
      failed = false;
    } finally {
      await teardownBrowser(session, failed, "domain-search-url");
    }
  },
});
