import { assertEquals } from "@std/assert";
import { CONTAINER_ROUTES } from "../commands.ts";
import { parseContainerCommand } from "./container.ts";

Deno.test("Tier 3 路由覆盖 issue 要求的全部命令", () => {
    // issue 验收：覆盖 db migrate / init system / bootstrap first-admin /
    // problems build|import / search reindex
    const flat = CONTAINER_ROUTES.map((r) => r.prefix.join(" ")).join(" | ");
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

Deno.test("P1d: maintain 被识别为 Tier 3 且以 --no-deps 运行", () => {
    for (const sub of ["enter", "status", "wait", "exit"]) {
        const match = parseContainerCommand(["maintain", sub]);
        assertEquals(match.matched, true, `maintain ${sub} 必须命中 Tier 3`);
        assertEquals(match.service, "core");
        assertEquals(match.noDeps, true);
    }
    // 裸 maintain 也要命中（help/用法路径不能依赖子命令）
    assertEquals(parseContainerCommand(["maintain"]).matched, true);
    // 既有 Tier 3 命令保持默认行为（会启动 depends_on）
    assertEquals(parseContainerCommand(["db", "migrate"]).noDeps, false);
});
