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
    "/opt/.env.prod": "file",
    "/opt/docker-compose.prod.yml": "file",
  });
  // T23：显式值现在只接受 prod（stack 模式已删除）
  const r = detectProfile({ explicit: "prod", start: "/opt", ...fs });
  assertEquals(r.profile, "prod");
  assertEquals(r.source, "explicit");
});

Deno.test("detectProfile: 生产安装目录判定为 prod", () => {
  const fs = fakeFs({
    "/opt/.env.prod": "file",
    "/opt/docker-compose.prod.yml": "file",
  });
  const r = detectProfile({ start: "/opt", ...fs });
  assertEquals(r.profile, "prod");
  assertEquals(r.source, "detected");
});

Deno.test("detectProfile: 仅有 production.sh、缺 .env.prod 时不判为 prod（洞 1 回归）", () => {
  // scripts/deploy/production.sh 在纯 TS 重写后会被删除。若仍以它作特征文件，
  // 真实生产目录（.env.prod + docker-compose.prod.yml）会探测失败并按设计报错，
  // 即「自锁」。此用例锁定新语义：production.sh 不再是生产目录特征。
  const fs = fakeFs({
    "/legacy/scripts/deploy/production.sh": "file",
    "/legacy/docker-compose.prod.yml": "file",
  });
  const r = detectProfile({ start: "/legacy", ...fs });
  assertEquals(r.profile, null);
  assertEquals(r.source, "none");
  assertEquals(r.error !== undefined, true, "必须报错而非猜默认值");
});

Deno.test("T23: 含 noj-deploy.json 不再被识别（该模态已删除）", () => {
  // 反向断言：旧模态的特征文件不得再让探测成功——否则一个只含 noj-deploy.json
  // 的目录会被判定为"可用"，而 CLI 已没有任何命令能消费它。
  const fs = fakeFs({ "/work/noj-deploy.json": "file" });
  const r = detectProfile({ start: "/work", ...fs });
  assertEquals(r.profile, null);
  assertEquals(r.source, "none");
  assertEquals(r.error !== undefined, true);
});

Deno.test("detectProfile: 都不命中时报错，不猜默认", () => {
  const r = detectProfile({ start: "/empty", ...fakeFs({}) });
  assertEquals(r.profile, null);
  assertEquals(r.source, "none");
  assertEquals(r.error !== undefined, true);
});

Deno.test("detectProfile: 向上查找到祖先目录", () => {
  // T23：改用生产安装目录特征（原先用 noj-deploy.json 模拟 stack）
  const fs = fakeFs({
    "/root/.env.prod": "file",
    "/root/docker-compose.prod.yml": "file",
  });
  const r = detectProfile({ start: "/root/a/b/c", ...fs });
  assertEquals(r.profile, "prod");
});

Deno.test("detectProfile: 非法 --profile 值直接报错", () => {
  const r = detectProfile({ explicit: "bogus", start: "/x", ...fakeFs({}) });
  assertEquals(r.profile, null);
  assertEquals(r.source, "invalid");
  assertEquals(r.error?.includes("prod"), true);
  // T23：错误信息不该再列出已删除的 stack 作为可选项
  assertEquals(r.error?.includes("stack"), false);
});

Deno.test("detectProfile: 显式 profile 不要求目录存在对应文件", () => {
  // 显式指定即用户已作出决定，不应因目录探测失败而拒绝
  const r = detectProfile({ explicit: "prod", start: "/x", ...fakeFs({}) });
  assertEquals(r.profile, "prod");
});

Deno.test("T23: PROFILE_NAMES 只剩 prod（单模态）", () => {
  assertEquals([...PROFILE_NAMES], ["prod"]);
});
