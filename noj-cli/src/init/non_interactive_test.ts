import { assertEquals } from "@std/assert";
import { nonInteractiveAdvice } from "./non_interactive.ts";

Deno.test("nonInteractiveAdvice: TTY 下允许交互，不返回提示", () => {
  assertEquals(nonInteractiveAdvice(true, false), null);
  assertEquals(nonInteractiveAdvice(true, true), null);
});

Deno.test("nonInteractiveAdvice: 非 TTY 提示无法完成并给出替代路径", () => {
  const advice = nonInteractiveAdvice(false, false);
  assertEquals(advice !== null, true);
  assertEquals(advice!.message.includes("非交互环境"), true);
  // 关键：必须告诉用户可行的替代路径，而不是给一个不可用的 --yes
  assertEquals(advice!.message.includes("预先手写 noj-deploy.json"), true);
  // 回归防线（评审修正）：不得再推荐 --yes —— 它并非已实现的非交互模式，
  // 照做会从「立即报错」变成无限循环刷屏。
  assertEquals(advice!.message.includes("--yes"), false);
});

Deno.test("nonInteractiveAdvice: 非 TTY 已有 --mode 仍拒绝（后续仍需交互）", () => {
  // 即便给了 mode，向导仍会问域名/端口/组件开关；因此不能放行。
  const advice = nonInteractiveAdvice(false, true);
  assertEquals(advice !== null, true);
  assertEquals(advice!.message.includes("仍需交互确认"), true);
  assertEquals(advice!.message.includes("--yes"), false);
});
