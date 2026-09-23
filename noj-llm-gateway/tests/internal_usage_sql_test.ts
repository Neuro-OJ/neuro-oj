/**
 * `/internal/usage` 的 SQL 形态回归测试（2026-09-23 复审）。
 *
 * ## 背景（CI 实测回归）
 *
 * 该端点在一次"参数化 LIMIT/OFFSET"的改动中引入了两个缺陷，导致
 * `GET /api/v1/admin/gateway/llm/usage` 返回 503
 * （E2E `llm_gateway.test.ts` 的 7.1 / 7.3 因此失败）：
 *
 * 1. **OFFSET 占位符漏了字面量 `$`**：模板字面量写成
 *    `` OFFSET ${params.length + 2} ``，渲染结果是 `LIMIT $2 OFFSET 3` ——
 *    绑定数组多出一个没人引用的参数，PG 报
 *    `42P18 could not determine data type of parameter $3`；
 * 2. **绑定值传字符串**：postgres.js 对字符串参数按 unknown 发送，
 *    在 `LIMIT/OFFSET` 位置无法推断类型（同样 42P18）。
 *
 * 这两点都是"SQL 文本 + 绑定数组"层面的错误，用真实 PG 才能暴露；本文件用**注入
 * 的 fake db 捕获 SQL 与绑定值**做快速断言（无需 PG），并与 `real_api_test.ts`
 * 的真实 PG 用例互补。
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { createInternalRouter } from "../src/routes/internal.ts";
import type { Db } from "../src/db.ts";
import type { GatewayConfig } from "../src/config.ts";

interface Captured {
  query: string;
  params: unknown[];
}

/** 构造一个只服务 `/internal/usage` 的 fake db。 */
function makeCaptureDb(captured: Captured[]): Db {
  const db = Object.assign(
    (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      captured.push({ query, params: [] });
      return Promise.resolve([]);
    },
    {
      unsafe: (query: string, params: unknown) => {
        captured.push({ query, params: [...(params as unknown[])] });
        return Promise.resolve([]);
      },
    },
  );
  return db as unknown as Db;
}

const testConfig = {
  serviceToken: "test-service-token",
  storeKey: "test-store-key",
} as unknown as GatewayConfig;

/** 发起一次 `/internal/usage` 请求并返回捕获到的 SQL。 */
async function callUsage(query: string): Promise<Captured> {
  const captured: Captured[] = [];
  const app = createInternalRouter({
    config: testConfig,
    db: makeCaptureDb(captured),
  });
  const res = await app.request(`/internal/usage${query}`, {
    headers: { authorization: `Bearer ${testConfig.serviceToken}` },
  });
  assertEquals(res.status, 200);
  assertEquals(
    captured.length,
    1,
    `应恰好执行 1 条 SQL，实得 ${captured.length}`,
  );
  return captured[0]!;
}

Deno.test("internal/usage: 占位符序号连续且与绑定值一一对应（无筛选）", async () => {
  const { query, params } = await callUsage("?limit=100&page=1");
  // LIMIT/OFFSET 都必须是 `$n` 形式（此前 OFFSET 漏了 `$`，渲染成 `OFFSET 0`）
  assertStringIncludes(query, "LIMIT $1");
  assertStringIncludes(query, "OFFSET $2");
  assertEquals(params.length, 2, `绑定值数量应与占位符一致，query=${query}`);
  // 值必须是**数字**（字符串会让 postgres.js 发 unknown → 42P18）
  assertEquals(typeof params[0], "number");
  assertEquals(typeof params[1], "number");
});

Deno.test("internal/usage: 有筛选时占位符序号不跳号", async () => {
  const { query, params } = await callUsage(
    "?submission_id=s1&limit=20&page=3",
  );
  assertStringIncludes(query, "submission_id = $1");
  assertStringIncludes(query, "LIMIT $2");
  assertStringIncludes(query, "OFFSET $3");
  assertEquals(params.length, 3);
  assertEquals(params[1], 20);
  assertEquals(params[2], 40, "page=3, limit=20 → offset=40");
});

Deno.test("internal/usage: 每个 $n 都出现在 SQL 中且不超出绑定数量", async () => {
  for (
    const q of [
      "?limit=100&page=1",
      "?submission_id=s1&limit=20&page=2",
      "?user_id=u1&problem_id=p1&status=ok&limit=5&page=9",
    ]
  ) {
    const { query, params } = await callUsage(q);
    // SQL 中出现的全部 `$n`（含 `$n::type` 形式）
    const refs = [...query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const max = Math.max(...refs);
    assertEquals(
      max,
      params.length,
      `最大占位符序号应等于绑定值数量（query=${query}, params=${params.length}）`,
    );
    // 序号必须从 1 连续到 max（跳号意味着某个绑定值没被引用 → 42P18）
    assertEquals(
      [...new Set(refs)].sort((a, b) => a - b),
      Array.from({ length: max }, (_, i) => i + 1),
      `占位符序号必须连续（query=${query}）`,
    );
  }
});

Deno.test("internal/usage: 超大 page 被夹取到上界且仍是数字参数", async () => {
  const { query, params } = await callUsage("?limit=100&page=1e30");
  assertStringIncludes(query, "LIMIT $1");
  assertStringIncludes(query, "OFFSET $2");
  assertEquals(typeof params[1], "number");
  // 上界夹取：offset 不应是 Infinity/NaN（否则 PG 仍会报错）
  assertEquals(Number.isFinite(params[1] as number), true);
  assertEquals(Number.isFinite(params[0] as number), true);
});
