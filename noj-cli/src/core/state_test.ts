import { assertEquals } from "@std/assert";
import type { DeployState } from "./state.ts";
import { downIsNoOp, prodState, transition, upIsNoOp } from "./state.ts";

/** 状态机全部合法状态，用于遍历。 */
const ALL_STATES: readonly DeployState[] = [
  "uninitialized",
  "stopped",
  "running",
  "partial",
  "error",
];

// ---------- transition：逐字移植自 src/state/machine.ts ----------

Deno.test("transition: init 从任意状态进入 stopped，changed=true，措辞一致", () => {
  for (const s of ALL_STATES) {
    const r = transition(s, "init");
    assertEquals(r.state, "stopped", "init from " + s);
    assertEquals(r.changed, true, "init from " + s);
    assertEquals(r.message, "状态从 " + s + " 转换为 stopped");
  }
});

Deno.test("transition: up 在 running 时 no-op（状态不变、changed=false、固定提示语）", () => {
  const r = transition("running", "up");
  assertEquals(r.state, "running");
  assertEquals(r.changed, false);
  assertEquals(r.message, "已处于 running，无需重复启动");
});

Deno.test("transition: up 从非 running 状态进入 running，changed=true", () => {
  for (const s of ["uninitialized", "stopped", "partial", "error"] as const) {
    const r = transition(s, "up");
    assertEquals(r.state, "running", "up from " + s);
    assertEquals(r.changed, true, "up from " + s);
    assertEquals(r.message, "状态从 " + s + " 转换为 running");
  }
});

Deno.test("transition: down 在 stopped 时 no-op（固定提示语）", () => {
  const r = transition("stopped", "down");
  assertEquals(r.state, "stopped");
  assertEquals(r.changed, false);
  assertEquals(r.message, "已处于 stopped，无需重复关闭");
});

Deno.test("transition: down 从非 stopped 状态进入 stopped，changed=true", () => {
  for (const s of ["uninitialized", "running", "partial", "error"] as const) {
    const r = transition(s, "down");
    assertEquals(r.state, "stopped", "down from " + s);
    assertEquals(r.changed, true, "down from " + s);
    assertEquals(r.message, "状态从 " + s + " 转换为 stopped");
  }
});

Deno.test("transition: restart 从任意状态进入 running，changed=true", () => {
  for (const s of ALL_STATES) {
    const r = transition(s, "restart");
    assertEquals(r.state, "running", "restart from " + s);
    assertEquals(r.changed, true, "restart from " + s);
    assertEquals(r.message, "状态从 " + s + " 转换为 running");
  }
});

Deno.test("transition: reset 从任意状态进入 stopped，changed=true", () => {
  for (const s of ALL_STATES) {
    const r = transition(s, "reset");
    assertEquals(r.state, "stopped", "reset from " + s);
    assertEquals(r.changed, true, "reset from " + s);
    assertEquals(r.message, "状态从 " + s + " 转换为 stopped");
  }
});

Deno.test("upIsNoOp / downIsNoOp 与 transition.changed 同步", () => {
  for (const s of ALL_STATES) {
    assertEquals(upIsNoOp(s), !transition(s, "up").changed, "upIsNoOp " + s);
    assertEquals(
      downIsNoOp(s),
      !transition(s, "down").changed,
      "downIsNoOp " + s,
    );
  }
  assertEquals(upIsNoOp("running"), true);
  assertEquals(upIsNoOp("partial"), false);
  assertEquals(downIsNoOp("stopped"), true);
  assertEquals(downIsNoOp("error"), false);
});

// ---------- prodState：从 docker compose ps 表格输出推断状态 ----------

/** compose v2 表头（STATUS 在第 6 列）。 */
const V2_HEADER =
  "NAME                IMAGE               COMMAND             SERVICE             CREATED             STATUS                       PORTS";

Deno.test("prodState: 空输出与纯空白 → stopped", () => {
  assertEquals(prodState(""), "stopped");
  assertEquals(prodState("\n"), "stopped");
  assertEquals(prodState("\n\n  \n"), "stopped");
});

Deno.test("prodState: 只有表头没有容器行 → stopped", () => {
  assertEquals(prodState(V2_HEADER + "\n"), "stopped");
  assertEquals(prodState(V2_HEADER), "stopped");
});

Deno.test("prodState: 全部 Up（含 healthy/unhealthy）→ running", () => {
  const out = [
    V2_HEADER,
    'noj-core-1          noj-core            "/app/noj-core"    core                2 hours ago         Up 2 hours (healthy)         0.0.0.0:8080->8080/tcp',
    'noj-ui-1            noj-ui              "/app/noj-ui"      ui                  2 hours ago         Up 2 hours (unhealthy)       0.0.0.0:3000->3000/tcp',
    "",
  ].join("\n");
  assertEquals(prodState(out), "running");
});

Deno.test("prodState: 全部 Exited → stopped", () => {
  const out = [
    V2_HEADER,
    'noj-core-1          noj-core            "/app/noj-core"    core                5 minutes ago       Exited (0) 5 minutes ago     0.0.0.0:8080->8080/tcp',
    'noj-db-1            postgres:16         "postgres"         db                  5 minutes ago       Exited (1) 4 minutes ago     0.0.0.0:5432->5432/tcp',
  ].join("\n");
  assertEquals(prodState(out), "stopped");
});

Deno.test("prodState: Up 与 Exited 混合 → partial", () => {
  const out = [
    V2_HEADER,
    'noj-core-1          noj-core            "/app/noj-core"    core                5 minutes ago       Up 5 minutes (healthy)       0.0.0.0:8080->8080/tcp',
    'noj-db-1            postgres:16         "postgres"         db                  5 minutes ago       Exited (1) 4 minutes ago     0.0.0.0:5432->5432/tcp',
  ].join("\n");
  assertEquals(prodState(out), "partial");
});

Deno.test("prodState: Up 与 Created 混合 → partial；仅 Created → stopped", () => {
  const created =
    'noj-db-1            postgres:16         "postgres"         db                  5 minutes ago       Created                      0.0.0.0:5432->5432/tcp';
  const up =
    'noj-core-1          noj-core            "/app/noj-core"    core                5 minutes ago       Up 5 minutes (healthy)       0.0.0.0:8080->8080/tcp';
  assertEquals(prodState([V2_HEADER, created, up].join("\n")), "partial");
  assertEquals(prodState([V2_HEADER, created].join("\n")), "stopped");
});

Deno.test("prodState: 仅 Restarting → stopped；Restarting 与 Up 混合 → partial", () => {
  const restarting =
    'noj-db-1            postgres:16         "postgres"         db                  30 seconds ago      Restarting (1) 5 seconds ago 0.0.0.0:5432->5432/tcp';
  const up =
    'noj-core-1          noj-core            "/app/noj-core"    core                5 minutes ago       Up 5 minutes (healthy)       0.0.0.0:8080->8080/tcp';
  assertEquals(prodState([V2_HEADER, restarting].join("\n")), "stopped");
  assertEquals(prodState([V2_HEADER, restarting, up].join("\n")), "partial");
});

Deno.test("prodState: 前置 WARN 行以及表头后夹杂 WARN 行都被忽略", () => {
  const out = [
    'WARN[0000] The "POSTGRES_PASSWORD" variable is not set. Defaulting to a blank string.',
    V2_HEADER,
    'noj-core-1          noj-core            "/app/noj-core"    core                2 hours ago         Up 2 hours (healthy)         0.0.0.0:8080->8080/tcp',
    "WARN[0000] Found orphan containers for this project.",
    'noj-ui-1            noj-ui              "/app/noj-ui"      ui                  2 hours ago         Up 2 hours                   0.0.0.0:3000->3000/tcp',
  ].join("\n");
  assertEquals(prodState(out), "running");
  // 只有 WARN 行没有表头也没有容器 → stopped
  assertEquals(
    prodState('WARN[0000] The "X" variable is not set.\n'),
    "stopped",
  );
});

Deno.test("prodState: 兼容 docker-compose v1 的 State 表头与分隔线", () => {
  const out = [
    "      Name                    Command               State           Ports",
    "------------------------------------------------------------------------------------",
    "neurooj_core_1    deno run main.ts        Up              0.0.0.0:8080->8080/tcp",
  ].join("\n");
  assertEquals(prodState(out), "running");
});

Deno.test("prodState: 识别 v1 的 Exit 0 状态（非 Up 即非运行）", () => {
  const out = [
    "      Name                    Command               State           Ports",
    "------------------------------------------------------------------------------------",
    "neurooj_core_1    deno run main.ts        Up              0.0.0.0:8080->8080/tcp",
    "neurooj_db_1      postgres                Exit 0          0.0.0.0:5432->5432/tcp",
  ].join("\n");
  assertEquals(prodState(out), "partial");
});

Deno.test("prodState: STATUS 列不在固定下标（重排列顺序）仍能识别", () => {
  const out = [
    "SERVICE             STATUS                NAME",
    "core                Up 2 hours (healthy)  noj-core-1",
    "db                  Exited (0) 1 hour ago noj-db-1",
  ].join("\n");
  assertEquals(prodState(out), "partial");
});

Deno.test("prodState: 行内列错位/缺列（单空格分隔）时回退到整行匹配", () => {
  const out = [
    V2_HEADER,
    'noj-core-1          noj-core            "/app/noj-core"    core                2 hours ago         Up 2 hours (healthy)         0.0.0.0:8080->8080/tcp',
    'noj-db-1 postgres "postgres" db 1 minute ago Exited (1) 1 minute ago 5432',
  ].join("\n");
  assertEquals(prodState(out), "partial");
});

Deno.test("prodState: 兼容 tab 分隔与 CRLF 行尾", () => {
  const tabbed = "NAME\tIMAGE\tSTATUS\tPORTS\nx-1\timg\tUp 1 minute\t8080\n";
  assertEquals(prodState(tabbed), "running");
  const crlf = V2_HEADER + "\r\n" +
    'noj-core-1          noj-core            "/app/noj-core"    core                2 hours ago         Up 2 hours (healthy)         0.0.0.0:8080->8080/tcp\r\n';
  assertEquals(prodState(crlf), "running");
});

Deno.test("prodState: STATUS 为最后一列（无 PORTS）时仍能识别", () => {
  const out = [
    "NAME                COMMAND             SERVICE             CREATED             STATUS",
    'noj-core-1          "/app/noj-core"    core                2 hours ago         Up 2 hours (healthy)',
    'noj-db-1            "postgres"         db                  2 hours ago         Exited (0) 2 hours ago',
  ].join("\n");
  assertEquals(prodState(out), "partial");
});
Deno.test("prodState: 完全没有表头时仍按整行状态词判定", () => {
  assertEquals(
    prodState("noj-core-1  img  Up 3 minutes\nnoj-db-1  img  Up 3 minutes\n"),
    "running",
  );
  assertEquals(
    prodState("noj-core-1  img  Exited (0) 1 minute ago\n"),
    "stopped",
  );
});

Deno.test("prodState: 容器行短于 STATUS 列时回退整行匹配（缺列容错）", () => {
  const out = [
    "NAME                IMAGE               COMMAND             SERVICE             CREATED             STATUS",
    "noj-core-1  img  Up 3 minutes",
  ].join("\n");
  assertEquals(prodState(out), "running");
});

Deno.test("prodState: 大小写/停靠容器名含 Up 子串不误判（词边界）", () => {
  // 容器名 group-up-1 与 upstream 不含独立词 Up，STATUS 列为 Exited → 非运行
  const out = [
    "NAME                IMAGE               COMMAND             SERVICE             CREATED             STATUS",
    'group-up-1          img                 "x"                upstream            1 minute ago        Exited (0) 1 minute ago',
  ].join("\n");
  assertEquals(prodState(out), "stopped");
});
