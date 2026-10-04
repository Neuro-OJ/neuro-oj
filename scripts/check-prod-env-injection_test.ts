import { assertEquals } from "jsr:@std/assert@^1";
import {
  checkProdEnvInjection,
  findInjectionGaps,
} from "./check-prod-env-injection.ts";

/** 仓库根目录：基于本文件位置解析，避免依赖 cwd。 */
const REPO_ROOT = new URL("..", import.meta.url).pathname;

const COMPOSE = [
  "x-core-env: &core-env",
  "  JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}",
  "  FOO: ${FOO:-}",
].join("\n");

Deno.test("check-prod-env-injection: 声明但未注入（含注释示例行）判违规", () => {
  const example = [
    "JWT_SECRET=change-me",
    "# FOO=1",
    "# BAR_BAZ=",
    "# 中文说明行 不应被解析",
  ].join("\n");
  assertEquals(findInjectionGaps(example, COMPOSE, {}), [
    "BAR_BAZ：.env.prod.example 已声明，但 compose 未注入任何服务",
  ]);
});

Deno.test("check-prod-env-injection: 白名单放行，陈旧条目判违规", () => {
  const example = ["JWT_SECRET=x", "# FOO=1", "CLI_ONLY=1"].join("\n");
  assertEquals(
    findInjectionGaps(example, COMPOSE, { CLI_ONLY: "cli 读取" }),
    [],
  );
  assertEquals(
    findInjectionGaps(example, COMPOSE, {
      CLI_ONLY: "cli 读取",
      GONE: "已删除",
      FOO: "其实已注入",
    }),
    [
      "FOO：已被 compose 插值注入，请从白名单移除",
      "GONE：白名单条目已不在 .env.prod.example 中，请移除",
    ],
  );
});

Deno.test("check-prod-env-injection: 零输入守卫", () => {
  assertEquals(findInjectionGaps("", COMPOSE, {}), [
    "未解析到任何变量：门禁可能已失效",
  ]);
});

Deno.test("check-prod-env-injection: 仓库现状一致（防回退）", async () => {
  assertEquals(await checkProdEnvInjection(REPO_ROOT), []);
});
