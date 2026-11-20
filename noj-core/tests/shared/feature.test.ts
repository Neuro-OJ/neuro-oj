import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import type { AuthEnv } from "../../src/shared/http/hono-env.ts";
import { createApp } from "../../src/app.ts";
import {
  collectFeatureTasks,
  defineFeature,
} from "../../src/shared/feature.ts";
import { createBackgroundHandlers } from "../../src/modules/application/background-handlers.ts";
import { TASK_TYPES } from "../../src/modules/runtime/tasks/contracts.ts";
import type { TaskHandler } from "../../src/modules/runtime/tasks/contracts.ts";

const noopHandler: TaskHandler = () => Promise.resolve();

Deno.test("feature: 功能名必须是小写 kebab-case", () => {
  assertThrows(() => defineFeature({ name: "Trainings" }), TypeError);
  assertThrows(() => defineFeature({ name: "my_feature" }), TypeError);
  assertThrows(() => defineFeature({ name: "-x" }), TypeError);
  assertEquals(
    defineFeature({ name: "knowledge-graph" }).name,
    "knowledge-graph",
  );
});

Deno.test("feature: 任务类型必须以功能名为前缀", () => {
  assertThrows(
    () =>
      defineFeature({ name: "trainings", tasks: { "other.run": noopHandler } }),
    TypeError,
    "必须以",
  );
  const ok = defineFeature({
    name: "trainings",
    tasks: { "trainings.recompute": noopHandler },
  });
  assert(Object.isFrozen(ok));
});

Deno.test("feature: 汇总任务时拒绝重复功能、重复任务与内置类型冲突", () => {
  const a = defineFeature({ name: "a", tasks: { "a.run": noopHandler } });
  assertThrows(
    () => collectFeatureTasks([a, defineFeature({ name: "a" })], TASK_TYPES),
    TypeError,
    "重复",
  );
  // 内置类型 "search.index" 只能被名为 search 的功能撞上
  const search = defineFeature({
    name: "search",
    tasks: { "search.index": noopHandler },
  });
  assertThrows(
    () => collectFeatureTasks([search], TASK_TYPES),
    TypeError,
    "内置任务类型冲突",
  );
  assertEquals(Object.keys(collectFeatureTasks([a], TASK_TYPES)), ["a.run"]);
});

Deno.test("feature: 后台处理器表同时包含内置任务与功能任务", () => {
  const probe = defineFeature({
    name: "feature-probe",
    tasks: { "feature-probe.run": noopHandler },
  });
  const handlers = createBackgroundHandlers([probe]) as Record<
    string,
    unknown
  >;
  for (const taskType of TASK_TYPES) {
    assertEquals(typeof handlers[taskType], "function", taskType);
  }
  assertEquals(handlers["feature-probe.run"], noopHandler);
});

Deno.test("feature: createApp 挂载功能路由到 /api/v1 并执行观测注册", () => {
  const router = new Hono<AuthEnv>().get(
    "/feature-probe/ping",
    (c) => c.text("pong"),
  );
  let registered = false;
  const probe = defineFeature({
    name: "feature-probe",
    router,
    observability: () => {
      registered = true;
    },
  });
  const app = createApp({ features: [probe] });
  assert(registered, "观测注册未执行");
  assert(
    app.routes.some((r) =>
      r.method === "GET" && r.path === "/api/v1/feature-probe/ping"
    ),
    "功能路由未挂载到 /api/v1",
  );
});
