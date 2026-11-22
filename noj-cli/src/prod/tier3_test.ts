import { assertEquals } from "@std/assert";
import { buildComposeArgs, renderDryRun } from "./tier3.ts";

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

Deno.test("buildComposeArgs: noDeps 在 --rm 之后插入 --no-deps", () => {
    const args = buildComposeArgs({
        composeFile: "/opt/docker-compose.prod.yml",
        envFile: "/opt/.env.prod",
        service: "core",
        command: ["maintain", "enter", "--json"],
        noDeps: true,
    });
    const rm = args.indexOf("--rm");
    assertEquals(args[rm + 1], "--no-deps");
    const entry = args.indexOf("--entrypoint");
    assertEquals(args[entry + 1], "/app/bin/noj");
    const service = args.indexOf("core");
    assertEquals(args.slice(service + 1), ["maintain", "enter", "--json"]);
    // 不传 noDeps 时不出现该旗标（既有 Tier 3 命令行为不变）
    assertEquals(
        buildComposeArgs({
            composeFile: "/opt/docker-compose.prod.yml",
            envFile: "/opt/.env.prod",
            service: "core",
            command: ["db", "migrate"],
        }).includes("--no-deps"),
        false,
    );
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
