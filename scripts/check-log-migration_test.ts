import { assertEquals } from "jsr:@std/assert@^1";
import { findViolations, scanSource } from "./check-log-migration.ts";

Deno.test("scanSource: 识别 logger.* 调用与级别", () => {
  const sites = scanSource(
    `logger.info("普通消息", { a: 1 });\nlogger.warn(\`\${label}启动\`);`,
    "t.ts",
  );
  assertEquals(sites.length, 2);
  assertEquals(sites[0]!.level, "info");
  assertEquals(sites[0]!.kind, "string");
  assertEquals(sites[1]!.level, "warn");
  assertEquals(sites[1]!.kind, "template");
});

Deno.test("findViolations: 残留 JS 模板插值被拒绝", () => {
  const sites = scanSource("logger.info(`${label}启动`);", "t.ts");
  const v = findViolations(sites);
  assertEquals(v.length, 1);
  assertEquals(v[0]!.message.includes("模板字符串"), true, v[0]!.message);
});

Deno.test("findViolations: 占位符无对应属性被拒绝", () => {
  const sites = scanSource(`logger.info("入队 {sid}", { other: 1 });`, "t.ts");
  const v = findViolations(sites);
  assertEquals(v.length, 1);
  assertEquals(v[0]!.message.includes("sid"), true, v[0]!.message);
});

Deno.test("findViolations: 占位符与属性匹配则通过", () => {
  const sites = scanSource(`logger.info("入队 {sid}", { sid });`, "t.ts");
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("findViolations: 字面花括号未转义被拒绝", () => {
  const sites = scanSource(`logger.info("集合 {a, b} 非法", {});`, "t.ts");
  // {a, b} 会被 LogTape 当占位符消费；属性里没有 a / b
  assertEquals(findViolations(sites).length >= 1, true);
});

Deno.test("findViolations: {{ }} 转义合法", () => {
  const sites = scanSource(`logger.info("集合 {{a, b}} 非法");`, "t.ts");
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("findViolations: getLogger 数组形式的调用点也被扫描", () => {
  const sites = scanSource(
    `const log = getLogger(["noj","x"]);\nlog.info("m {a}", { a: 1 });`,
    "t.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("scanSource: 跨多行调用能取到属性键", () => {
  const sites = scanSource(
    `logger.error(\n  "失败 {a}",\n  {\n    a: 1,\n    b: 2,\n  },\n);`,
    "t.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]!.propertyKeys, ["a", "b"]);
  assertEquals(findViolations(sites).length, 0);
});
