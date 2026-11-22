/**
 * 升级自动排空（P1d）单测：默认实现的 compose 参数/JSON 解析 + 编排 helper。
 *
 * 全部注入 fake：不起容器、不触网、不写真实部署目录。
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CmdResult, CommandRunner } from "../../runtime/command.ts";
import {
  createDrainLifecycle,
  DEFAULT_DRAIN_TIMEOUT_SECS,
  drainAfterUpgrade,
  drainBeforeUpgrade,
  type DrainContext,
  type DrainLifecycle,
  type DrainResult,
  type DrainSinks,
  type DrainTarget,
} from "./drain.ts";

/** 目标配置（结构子集，路径仅用于断言）。 */
const TARGET: DrainTarget = {
  composeOptions: {
    composeFile: "/opt/neuro-oj/docker-compose.prod.yml",
    envFile: "/opt/neuro-oj/.env.prod",
  },
  envFile: "/opt/neuro-oj/.env.prod",
};

/** 造一个记录调用的 fake runner；`result` 为每次调用指定输出。 */
function makeRunner(
  result: Partial<CmdResult> = {},
): { runner: CommandRunner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    runner: {
      run(cmd, args) {
        calls.push({ cmd, args: [...args] });
        return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
      },
      spawn() {
        throw new Error("drain 测试不应 spawn");
      },
    },
  };
}

/** 捕获人类输出。 */
function makeSinks(): { sinks: DrainSinks; out: string[] } {
  const out: string[] = [];
  return {
    out,
    sinks: {
      io: {
        stdout: (text) => void out.push(text),
        stderr: (text) => void out.push(text),
        jsonMode: false,
      },
    },
  };
}

/** 造一个按子命令返回结果的 fake drain；并记录调用顺序。 */
function fakeDrain(
  results: Partial<Record<"enter" | "wait" | "exit", DrainResult>> = {},
): {
  drain: DrainLifecycle;
  calls: string[];
  contexts: DrainContext[];
} {
  const calls: string[] = [];
  const contexts: DrainContext[] = [];
  const ok: DrainResult = { ok: true, code: null, error: null };
  const make =
    (kind: "enter" | "wait" | "exit") =>
    (context: DrainContext): Promise<DrainResult> => {
      calls.push(kind);
      contexts.push(context);
      return Promise.resolve(results[kind] ?? ok);
    };
  return {
    calls,
    contexts,
    drain: { enter: make("enter"), wait: make("wait"), exit: make("exit") },
  };
}

const ENV_FILE = "/opt/neuro-oj/.env.prod";
const COMPOSE_FILE = "/opt/neuro-oj/docker-compose.prod.yml";

Deno.test("createDrainLifecycle: enter 构造 --no-deps 容器命令并解析成功 JSON", async () => {
  const { runner, calls } = makeRunner({
    stdout: JSON.stringify({
      ok: true,
      data: { maintenance: true, changed: true },
    }),
  });
  const result = await createDrainLifecycle({ runner }).enter({
    compose: TARGET.composeOptions,
    timeoutSecs: DEFAULT_DRAIN_TIMEOUT_SECS,
  });
  assertEquals(result.ok, true);
  assertEquals(result.code, null);
  assertEquals(result.data?.maintenance, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.cmd, "docker");
  assertEquals(calls[0]!.args, [
    "compose",
    "--env-file",
    ENV_FILE,
    "-f",
    COMPOSE_FILE,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "/app/bin/noj",
    "core",
    "maintain",
    "enter",
    "--json",
  ]);
});

Deno.test("createDrainLifecycle: wait 透传 --timeout/--interval", async () => {
  const { runner, calls } = makeRunner({
    stdout: JSON.stringify({ ok: true, data: { drained: true } }),
  });
  const result = await createDrainLifecycle({ runner }).wait({
    compose: TARGET.composeOptions,
    timeoutSecs: 42,
  });
  assertEquals(result.ok, true);
  const args = calls[0]!.args;
  const waitAt = args.indexOf("wait");
  assert(waitAt >= 0);
  assertEquals(args.slice(waitAt + 1), [
    "--timeout",
    "42",
    "--interval",
    "5",
    "--json",
  ]);
});

Deno.test("createDrainLifecycle: dockerBin 可覆盖（NOJ_DEPLOY_DOCKER_BIN）", async () => {
  const { runner, calls } = makeRunner({
    stdout: JSON.stringify({ ok: true }),
  });
  await createDrainLifecycle({ runner, dockerBin: "docker-prod" }).exit({
    compose: TARGET.composeOptions,
    timeoutSecs: 1,
  });
  assertEquals(calls[0]!.cmd, "docker-prod");
});

Deno.test("createDrainLifecycle: 失败 JSON 保留 code/error（drain_unavailable）", async () => {
  const { runner } = makeRunner({
    code: 1,
    stdout: JSON.stringify({
      ok: false,
      code: "drain_unavailable",
      error: "未配置 NOJ_INTERNAL_SERVICE_TOKEN",
    }),
  });
  const result = await createDrainLifecycle({ runner }).enter({
    compose: TARGET.composeOptions,
    timeoutSecs: DEFAULT_DRAIN_TIMEOUT_SECS,
  });
  assertEquals(result.ok, false);
  assertEquals(result.code, "drain_unavailable");
  assertStringIncludes(result.error ?? "", "NOJ_INTERNAL_SERVICE_TOKEN");
});

Deno.test("createDrainLifecycle: 未知 code 归一为 http_error", async () => {
  const { runner } = makeRunner({
    code: 1,
    stdout: JSON.stringify({ ok: false, code: "weird_code", error: "boom" }),
  });
  const result = await createDrainLifecycle({ runner }).enter({
    compose: TARGET.composeOptions,
    timeoutSecs: 1,
  });
  assertEquals(result.code, "http_error");
  assertEquals(result.error, "boom");
});

Deno.test("createDrainLifecycle: JSON 前有杂音也能解析出唯一文档", async () => {
  const doc = JSON.stringify({ ok: true, data: { drained: true } });
  const { runner } = makeRunner({
    stdout: "warning: something\n" + doc + "\n",
  });
  const result = await createDrainLifecycle({ runner }).wait({
    compose: TARGET.composeOptions,
    timeoutSecs: 5,
  });
  assertEquals(result.ok, true);
  assertEquals(result.data?.drained, true);
});

Deno.test("createDrainLifecycle: 非 JSON 输出 → network_error（附 stderr）", async () => {
  const { runner } = makeRunner({
    code: 1,
    stdout: "not json at all",
    stderr: "Error response from daemon: no such image",
  });
  const result = await createDrainLifecycle({ runner }).enter({
    compose: TARGET.composeOptions,
    timeoutSecs: 1,
  });
  assertEquals(result.ok, false);
  assertEquals(result.code, "network_error");
  assertStringIncludes(result.error ?? "", "维护命令未返回 JSON");
  assertStringIncludes(result.error ?? "", "no such image");
});

Deno.test("createDrainLifecycle: runner 抛错（docker 不存在）→ network_error", async () => {
  const runner: CommandRunner = {
    run() {
      return Promise.reject(new Error("spawn docker ENOENT"));
    },
    spawn() {
      throw new Error("drain 测试不应 spawn");
    },
  };
  const result = await createDrainLifecycle({ runner }).enter({
    compose: TARGET.composeOptions,
    timeoutSecs: 1,
  });
  assertEquals(result.code, "network_error");
  assertStringIncludes(result.error ?? "", "无法执行维护命令");
});

// ── 编排 helper：drainBeforeUpgrade / drainAfterUpgrade ──────────────

Deno.test("drainBeforeUpgrade: 未注入 drain 或 --skip-drain → 零调用", async () => {
  const { sinks, out } = makeSinks();
  assertEquals(await drainBeforeUpgrade({}, TARGET, sinks), null);
  const fake = fakeDrain();
  assertEquals(
    await drainBeforeUpgrade(
      { drain: fake.drain, skipDrain: true },
      TARGET,
      sinks,
    ),
    null,
  );
  assertEquals(fake.calls, []);
  assertEquals(out, []);
});

Deno.test("drainBeforeUpgrade: enter → wait 顺序、使用 --drain-timeout", async () => {
  const fake = fakeDrain();
  const { sinks, out } = makeSinks();
  const result = await drainBeforeUpgrade(
    { drain: fake.drain, drainTimeoutSecs: 60 },
    TARGET,
    sinks,
  );
  assertEquals(result, null);
  assertEquals(fake.calls, ["enter", "wait"]);
  assertEquals(fake.contexts[0]!.timeoutSecs, 60);
  assertEquals(fake.contexts[0]!.compose.envFile, ENV_FILE);
  assertStringIncludes(out.join(""), "排空完成");
});

Deno.test("drainBeforeUpgrade: wait 失败 → 中止并尽力 exit，文案含建议", async () => {
  const fake = fakeDrain({
    wait: { ok: false, code: "timeout", error: "等待超时" },
  });
  const { sinks } = makeSinks();
  const error = await drainBeforeUpgrade({ drain: fake.drain }, TARGET, sinks);
  assert(error !== null);
  assertStringIncludes(error!, "等待排空失败");
  assertStringIncludes(error!, "timeout");
  assertStringIncludes(error!, "maintain status");
  assertEquals(fake.calls, ["enter", "wait", "exit"]);
});

Deno.test("drainBeforeUpgrade: enter 失败 → 中止并尽力 exit", async () => {
  const fake = fakeDrain({
    enter: { ok: false, code: "unauthorized", error: "401" },
  });
  const { sinks } = makeSinks();
  const error = await drainBeforeUpgrade({ drain: fake.drain }, TARGET, sinks);
  assert(error !== null);
  assertStringIncludes(error!, "进入维护模式失败");
  assertStringIncludes(error!, "NOJ_INTERNAL_SERVICE_TOKEN");
  assertEquals(fake.calls, ["enter", "exit"]);
});

Deno.test("drainBeforeUpgrade: 旧 Core endpoint_unavailable → 告警并继续（不 wait）", async () => {
  const fake = fakeDrain({
    enter: { ok: false, code: "endpoint_unavailable", error: "404" },
  });
  const { sinks, out } = makeSinks();
  const result = await drainBeforeUpgrade({ drain: fake.drain }, TARGET, sinks);
  assertEquals(result, null, "旧 Core 过渡期必须继续升级");
  assertEquals(fake.calls, ["enter"]);
  assertStringIncludes(out.join(""), "旧版本");
});

Deno.test("drainBeforeUpgrade: 注入实现抛错不得击穿升级序列", async () => {
  const drain: DrainLifecycle = {
    enter: () => Promise.reject(new Error("boom")),
    wait: () => Promise.resolve({ ok: true, code: null, error: null }),
    exit: () => Promise.resolve({ ok: true, code: null, error: null }),
  };
  const { sinks } = makeSinks();
  const error = await drainBeforeUpgrade({ drain }, TARGET, sinks);
  assert(error !== null);
  assertStringIncludes(error!, "boom");
});

Deno.test("drainAfterUpgrade: 未注入/跳过 → 零调用；成功时报告恢复写请求", async () => {
  const { sinks } = makeSinks();
  assertEquals(await drainAfterUpgrade({}, TARGET, sinks), null);
  const fake = fakeDrain();
  assertEquals(
    await drainAfterUpgrade(
      { drain: fake.drain, skipDrain: true },
      TARGET,
      sinks,
    ),
    null,
  );
  assertEquals(fake.calls, []);
});

Deno.test("drainAfterUpgrade: exit 失败 → 显式半完成并提示人工 maintain exit", async () => {
  const fake = fakeDrain({
    exit: { ok: false, code: "http_error", error: "500" },
  });
  const { sinks } = makeSinks();
  const error = await drainAfterUpgrade({ drain: fake.drain }, TARGET, sinks);
  assert(error !== null);
  // 文案不得假设"服务已启动"（waitForStack 失败路径同样复用），只陈述风险与恢复命令
  assertStringIncludes(error!, "维护模式");
  assertStringIncludes(error!, "noj-cli maintain exit");
});

Deno.test("drainAfterUpgrade: 旧 Core endpoint_unavailable → 跳过不报错", async () => {
  const fake = fakeDrain({
    exit: { ok: false, code: "endpoint_unavailable", error: "405" },
  });
  const { sinks, out } = makeSinks();
  const error = await drainAfterUpgrade({ drain: fake.drain }, TARGET, sinks);
  assertEquals(error, null);
  assertStringIncludes(out.join(""), "旧版本");
});
