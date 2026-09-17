import { assertEquals } from "@std/assert";
import { detectProfile, PROFILE_NAMES } from "./profile.ts";

/** 构造一个可注入的探测环境（避免测试触碰真实文件系统）。 */
function fakeFs(files: Record<string, "file" | "dir">) {
  return {
    exists(path: string): boolean {
      return files[path] !== undefined;
    },
    isFile(path: string): boolean {
      return files[path] === "file";
    },
  };
}

Deno.test("detectProfile: 显式 --profile 优先于一切探测", () => {
  const fs = fakeFs({
    "/opt/scripts/deploy/production.sh": "file",
    "/opt/docker-compose.prod.yml": "file",
  });
  const r = detectProfile({ explicit: "stack", start: "/opt", ...fs });
  assertEquals(r.profile, "stack");
  assertEquals(r.source, "explicit");
});

Deno.test("detectProfile: 生产安装目录判定为 prod", () => {
  const fs = fakeFs({
    "/opt/scripts/deploy/production.sh": "file",
    "/opt/docker-compose.prod.yml": "file",
  });
  const r = detectProfile({ start: "/opt", ...fs });
  assertEquals(r.profile, "prod");
  assertEquals(r.source, "detected");
});

Deno.test("detectProfile: 含 noj-deploy.json 判定为 stack", () => {
  const fs = fakeFs({ "/work/noj-deploy.json": "file" });
  const r = detectProfile({ start: "/work", ...fs });
  assertEquals(r.profile, "stack");
  assertEquals(r.source, "detected");
});

Deno.test("detectProfile: 两者同时命中时报错，不静默取默认", () => {
  // issue 明确要求：猜错模式可能作用到错误的目标，必须报错。
  const fs = fakeFs({
    "/mixed/scripts/deploy/production.sh": "file",
    "/mixed/docker-compose.prod.yml": "file",
    "/mixed/noj-deploy.json": "file",
  });
  const r = detectProfile({ start: "/mixed", ...fs });
  assertEquals(r.profile, null);
  assertEquals(r.source, "ambiguous");
  assertEquals(
    r.error?.includes("--profile") ?? false,
    true,
    "错误信息应给出下一步操作建议",
  );
});

Deno.test("detectProfile: 都不命中时报错，不猜默认", () => {
  const r = detectProfile({ start: "/empty", ...fakeFs({}) });
  assertEquals(r.profile, null);
  assertEquals(r.source, "none");
  assertEquals(r.error !== undefined, true);
});

Deno.test("detectProfile: 向上查找到祖先目录", () => {
  const fs = fakeFs({ "/root/noj-deploy.json": "file" });
  const r = detectProfile({ start: "/root/a/b/c", ...fs });
  assertEquals(r.profile, "stack");
});

Deno.test("detectProfile: 非法 --profile 值直接报错", () => {
  const r = detectProfile({ explicit: "bogus", start: "/x", ...fakeFs({}) });
  assertEquals(r.profile, null);
  assertEquals(r.source, "invalid");
  assertEquals(r.error?.includes("prod"), true);
  assertEquals(r.error?.includes("stack"), true);
});

Deno.test("detectProfile: 显式 profile 不要求目录存在对应文件", () => {
  // 显式指定即用户已作出决定，不应因目录探测失败而拒绝
  const r = detectProfile({ explicit: "prod", start: "/x", ...fakeFs({}) });
  assertEquals(r.profile, "prod");
});

Deno.test("PROFILE_NAMES 固定为 prod/stack", () => {
  assertEquals([...PROFILE_NAMES].sort(), ["prod", "stack"]);
});
