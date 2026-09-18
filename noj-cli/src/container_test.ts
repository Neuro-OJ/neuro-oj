import { assertEquals } from "@std/assert";
import {
  buildComposeArgs,
  CONTAINER_COMMANDS,
  parseContainerCommand,
  renderDryRun,
} from "./container.ts";

Deno.test("CONTAINER_COMMANDS 覆盖 issue 要求的全部 Tier 3 命令", () => {
  // issue 验收：覆盖 db migrate / init system / bootstrap first-admin /
  // problems build|import / search reindex
  const flat = CONTAINER_COMMANDS.map((c) => c.join(" ")).join(" | ");
  for (
    const expected of [
      "db migrate",
      "init system",
      "bootstrap first-admin",
      "problems build",
      "problems import",
      "search reindex",
    ]
  ) {
    assertEquals(flat.includes(expected), true, `应覆盖 ${expected}`);
  }
});

Deno.test("parseContainerCommand: 识别 Tier 3 命令并保留透传参数", () => {
  const r = parseContainerCommand([
    "bootstrap",
    "first-admin",
    "--username",
    "alice",
    "--email",
    "a@b.c",
  ]);
  assertEquals(r.matched, true);
  assertEquals(r.service, "core");
  assertEquals(r.args, [
    "bootstrap",
    "first-admin",
    "--username",
    "alice",
    "--email",
    "a@b.c",
  ]);
});

Deno.test("parseContainerCommand: 非 Tier 3 顶层命令不匹配", () => {
  assertEquals(parseContainerCommand(["status"]).matched, false);
  assertEquals(parseContainerCommand([]).matched, false);
});

Deno.test("buildComposeArgs: 构造 docker compose run 且 stdin 可继承", () => {
  const args = buildComposeArgs({
    composeFile: "/opt/docker-compose.prod.yml",
    envFile: "/opt/.env.prod",
    service: "core",
    command: ["db", "migrate"],
  });
  assertEquals(args[0], "compose");
  assertEquals(args.includes("--env-file"), true);
  assertEquals(args.includes("/opt/.env.prod"), true);
  assertEquals(args.includes("-f"), true);
  assertEquals(args.includes("/opt/docker-compose.prod.yml"), true);
  assertEquals(args.includes("run"), true);
  assertEquals(args.includes("--rm"), true);
  // --entrypoint 必须是 /app/bin/noj（容器内 CLI），后接 service 再是子命令
  const entryIdx = args.indexOf("--entrypoint");
  assertEquals(args[entryIdx + 1], "/app/bin/noj");
  const serviceIdx = args.indexOf("core");
  assertEquals(args[serviceIdx + 1], "db");
  assertEquals(args[serviceIdx + 2], "migrate");
});

Deno.test("renderDryRun: 可读且可直接复制执行", () => {
  const args = buildComposeArgs({
    composeFile: "/opt/docker-compose.prod.yml",
    envFile: "/opt/.env.prod",
    service: "core",
    command: ["search", "reindex"],
  });
  const text = renderDryRun(args);
  assertEquals(text.startsWith("docker"), true);
  assertEquals(text.includes("search reindex"), true);
});

Deno.test("renderDryRun: 含空格/引号的值被安全引用", () => {
  const args = buildComposeArgs({
    composeFile: "/opt/my dir/docker-compose.prod.yml",
    envFile: "/opt/my dir/.env.prod",
    service: "core",
    command: ["db", "migrate"],
  });
  const text = renderDryRun(args);
  // 带空格的路径必须被引起来，否则用户复制后执行会断成两个参数
  assertEquals(text.includes('"/opt/my dir/docker-compose.prod.yml"'), true);
});
