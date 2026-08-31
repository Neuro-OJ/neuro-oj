import { assertEquals } from "@std/assert";
import type { DeployConfig } from "../config/types.ts";
import { downIsNoOp, nextState, upIsNoOp, writeState } from "./state.ts";

function cfg(state: DeployConfig["state"]): DeployConfig {
  return {
    schema_version: 1,
    type: "dev",
    state,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {},
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "localhost",
      upstream_port: 8080,
    },
  };
}

Deno.test("nextState: up 在 running 时 no-op，其余进入 running", () => {
  assertEquals(nextState(cfg("running"), "up").changed, false);
  assertEquals(nextState(cfg("stopped"), "up").state, "running");
  assertEquals(nextState(cfg("partial"), "up").state, "running");
});

Deno.test("nextState: down 在 stopped 时 no-op，其余进入 stopped", () => {
  assertEquals(nextState(cfg("stopped"), "down").changed, false);
  assertEquals(nextState(cfg("running"), "down").state, "stopped");
});

Deno.test("upIsNoOp / downIsNoOp", () => {
  assertEquals(upIsNoOp(cfg("running")), true);
  assertEquals(upIsNoOp(cfg("stopped")), false);
  assertEquals(downIsNoOp(cfg("stopped")), true);
  assertEquals(downIsNoOp(cfg("running")), false);
});

Deno.test("writeState: 设置状态并更新 updated_at 后调用 save", async () => {
  const c = cfg("stopped");
  let saved: DeployConfig | undefined;
  await writeState(c, "running", (x) => {
    saved = x;
    return Promise.resolve();
  });
  assertEquals(c.state, "running");
  assertEquals(new Date(c.updated_at).toISOString(), c.updated_at);
  assertEquals(saved?.state, "running");
});
