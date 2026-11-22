/**
 * 浏览器 journey 生命周期单元测试。
 *
 * 通过注入 fake launcher 验证清理路径：一个 journey 只启动一次 Browser、每个
 * 角色独立 context、任一步失败都关闭 context 与 Browser、失败诊断产物按
 * run/journey/actor 命名、清理错误不被吞掉。不需要真实 Chromium。
 */
import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  type BrowserJourneyFixture,
  type JourneyBrowser,
  type JourneyContext,
  type JourneyPage,
  type JourneyTracing,
  withBrowserJourney,
} from "../../e2e/browser/browser.ts";

interface TraceCall {
  kind: "start" | "stop";
  path?: string;
}

class FakeTracing implements JourneyTracing {
  calls: TraceCall[] = [];
  startError: Error | null = null;

  start(): Promise<void> {
    this.calls.push({ kind: "start" });
    return this.startError
      ? Promise.reject(this.startError)
      : Promise.resolve();
  }

  stop(options?: { path?: string }): Promise<void> {
    this.calls.push({ kind: "stop", path: options?.path });
    return Promise.resolve();
  }

  get stopPaths(): Array<string | undefined> {
    return this.calls.filter((call) => call.kind === "stop").map((call) =>
      call.path
    );
  }
}

class FakePage implements JourneyPage {
  events: string[] = [];
  screenshots: string[] = [];
  screenshotError: Error | null = null;

  on(event: "pageerror", _handler: (error: Error) => void): unknown {
    this.events.push(event);
    return this;
  }

  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown> {
    if (this.screenshotError) return Promise.reject(this.screenshotError);
    this.screenshots.push(options.path);
    return Promise.resolve(undefined);
  }
}

class FakeContext implements JourneyContext {
  tracing = new FakeTracing();
  page = new FakePage();
  closed = 0;
  closeError: Error | null = null;

  newPage(): Promise<JourneyPage> {
    return Promise.resolve(this.page);
  }

  close(): Promise<void> {
    if (this.closeError) return Promise.reject(this.closeError);
    this.closed += 1;
    return Promise.resolve();
  }
}

class FakeBrowser implements JourneyBrowser {
  contexts: FakeContext[] = [];
  launches = 0;
  closed = 0;
  closeError: Error | null = null;
  /** 第 N 个（1 起）newContext 调用直接失败。 */
  failContextAt = 0;
  /** 新建 context 的 tracing.start 失败。 */
  failTracingStart = false;

  newContext(): Promise<JourneyContext> {
    const index = this.contexts.length + 1;
    if (this.failContextAt === index) {
      return Promise.reject(new Error(`第 ${index} 个 context 创建失败`));
    }
    const context = new FakeContext();
    if (this.failTracingStart) {
      context.tracing.startError = new Error("tracing 启动失败");
    }
    this.contexts.push(context);
    return Promise.resolve(context);
  }

  close(): Promise<void> {
    if (this.closeError) return Promise.reject(this.closeError);
    this.closed += 1;
    return Promise.resolve();
  }
}

function launcherFor(browser: FakeBrowser): () => Promise<JourneyBrowser> {
  return () => {
    browser.launches += 1;
    return Promise.resolve(browser);
  };
}

const ARTIFACT_DIR = "/tmp/noj-browser-journey-test-artifacts";

/** 捕获 journey 收尾期间的控制台输出，避免单测噪音并断言上报内容。 */
async function captureConsole(
  action: () => Promise<void>,
): Promise<{ errors: string[]; logs: string[]; error?: unknown }> {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    await action();
    return { errors, logs };
  } catch (error) {
    return { errors, logs, error };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

Deno.test("withBrowserJourney: 多角色只启动一次 Browser，每个角色独立 context", async () => {
  const browser = new FakeBrowser();
  let a: JourneyContext | null = null;
  let b: JourneyContext | null = null;
  await withBrowserJourney(
    "four-roles",
    async (journey: BrowserJourneyFixture) => {
      const coach = await journey.newSession("coach");
      const learner = await journey.newSession("learner");
      a = coach.context;
      b = learner.context;
      assertEquals(coach.actorLabel, "coach");
      assertEquals((coach.page as unknown as FakePage).events, ["pageerror"]);
    },
    {
      launcher: launcherFor(browser),
      artifactDir: ARTIFACT_DIR,
      runId: "run1",
    },
  );
  assertEquals(browser.launches, 1);
  assertNotStrictEquals(a, b);
  assertEquals(browser.contexts.length, 2);
  assertEquals(browser.contexts.map((context) => context.closed), [1, 1]);
  assertEquals(browser.closed, 1);
  // 成功路径不写失败产物：tracing.stop 不带 path
  assertEquals(
    browser.contexts.map((context) => context.tracing.stopPaths),
    [[undefined], [undefined]],
  );
});

Deno.test("withBrowserJourney: 第二个 context 创建失败仍关闭已有 context 与 Browser", async () => {
  const browser = new FakeBrowser();
  browser.failContextAt = 2;
  const { error } = await captureConsole(() =>
    withBrowserJourney(
      "second-context",
      async (journey) => {
        await journey.newSession("coach");
        await journey.newSession("learner");
      },
      {
        launcher: launcherFor(browser),
        artifactDir: ARTIFACT_DIR,
        runId: "run2",
      },
    )
  );
  assertEquals((error as Error).message, "第 2 个 context 创建失败");
  assertEquals(browser.contexts.length, 1);
  assertEquals(browser.contexts[0].closed, 1);
  assertEquals(browser.closed, 1);
  // 失败诊断覆盖已登记的 actor
  assertEquals(browser.contexts[0].tracing.stopPaths, [
    `${ARTIFACT_DIR}/trace-run2-second-context-coach.zip`,
  ]);
});

Deno.test("withBrowserJourney: tracing 启动失败也清理 context 与 Browser", async () => {
  const browser = new FakeBrowser();
  browser.failTracingStart = true;
  const { error } = await captureConsole(() =>
    withBrowserJourney(
      "trace-start",
      async (journey) => {
        await journey.newSession("coach");
      },
      {
        launcher: launcherFor(browser),
        artifactDir: ARTIFACT_DIR,
        runId: "run3",
      },
    )
  );
  assertEquals((error as Error).message, "tracing 启动失败");
  assertEquals(browser.contexts[0].closed, 1);
  assertEquals(browser.closed, 1);
});

Deno.test("withBrowserJourney: 失败时每个 actor 都保存 trace 与截图", async () => {
  const browser = new FakeBrowser();
  const { error } = await captureConsole(() =>
    withBrowserJourney(
      "classroom matrix",
      async (journey) => {
        await journey.newSession("coach");
        await journey.newSession("learner");
        throw new Error("业务步骤失败");
      },
      {
        launcher: launcherFor(browser),
        artifactDir: ARTIFACT_DIR,
        runId: "run 4",
      },
    )
  );
  assertEquals((error as Error).message, "业务步骤失败");
  // 标签中的空格折叠为横线，文件名可预期
  assertEquals(browser.contexts[0].tracing.stopPaths, [
    `${ARTIFACT_DIR}/trace-run-4-classroom-matrix-coach.zip`,
  ]);
  assertEquals(browser.contexts[1].tracing.stopPaths, [
    `${ARTIFACT_DIR}/trace-run-4-classroom-matrix-learner.zip`,
  ]);
  assertEquals(browser.contexts[0].page.screenshots, [
    `${ARTIFACT_DIR}/failure-run-4-classroom-matrix-coach.png`,
  ]);
  assertEquals(browser.contexts[1].page.screenshots, [
    `${ARTIFACT_DIR}/failure-run-4-classroom-matrix-learner.png`,
  ]);
  assertEquals(browser.contexts.map((context) => context.closed), [1, 1]);
  assertEquals(browser.closed, 1);
});

Deno.test("withBrowserJourney: 截图失败不影响 trace 与其他 context 清理", async () => {
  const browser = new FakeBrowser();
  const { error, errors } = await captureConsole(() =>
    withBrowserJourney(
      "screenshot-failure",
      async (journey) => {
        const first = await journey.newSession("coach");
        await journey.newSession("learner");
        (first.page as unknown as FakePage).screenshotError = new Error(
          "截图失败",
        );
        throw new Error("业务步骤失败");
      },
      {
        launcher: launcherFor(browser),
        artifactDir: ARTIFACT_DIR,
        runId: "run5",
      },
    )
  );
  assertEquals((error as Error).message, "业务步骤失败");
  assertEquals(browser.contexts[0].tracing.stopPaths, [
    `${ARTIFACT_DIR}/trace-run5-screenshot-failure-coach.zip`,
  ]);
  assertEquals(browser.contexts[1].page.screenshots, [
    `${ARTIFACT_DIR}/failure-run5-screenshot-failure-learner.png`,
  ]);
  assertEquals(errors.some((line) => line.includes("截图失败")), true);
  assertEquals(browser.contexts.map((context) => context.closed), [1, 1]);
  assertEquals(browser.closed, 1);
});

Deno.test("withBrowserJourney: 成功路径的清理错误以 AggregateError 上报", async () => {
  const browser = new FakeBrowser();
  await assertRejects(
    () =>
      withBrowserJourney(
        "cleanup-failure",
        async (journey) => {
          await journey.newSession("coach");
          browser.contexts[0].closeError = new Error("context 关闭失败");
        },
        {
          launcher: launcherFor(browser),
          artifactDir: ARTIFACT_DIR,
          runId: "run6",
        },
      ),
    AggregateError,
    "收尾失败",
  );
  assertEquals(browser.closed, 1);
});

Deno.test("withBrowserJourney: Browser 关闭失败在成功路径被上报", async () => {
  const browser = new FakeBrowser();
  browser.closeError = new Error("browser 关闭失败");
  await assertRejects(
    () =>
      withBrowserJourney(
        "browser-close-failure",
        async (journey) => {
          await journey.newSession("coach");
        },
        {
          launcher: launcherFor(browser),
          artifactDir: ARTIFACT_DIR,
          runId: "run7",
        },
      ),
    AggregateError,
    "收尾失败",
  );
});

Deno.test("withBrowserJourney: 业务失败时保留原始错误并日志上报清理错误", async () => {
  const browser = new FakeBrowser();
  const { error, errors } = await captureConsole(() =>
    withBrowserJourney(
      "body-and-cleanup",
      async (journey) => {
        await journey.newSession("coach");
        browser.contexts[0].closeError = new Error("context 关闭失败");
        throw new Error("业务步骤失败");
      },
      {
        launcher: launcherFor(browser),
        artifactDir: ARTIFACT_DIR,
        runId: "run8",
      },
    )
  );
  // 原始断言错误优先，便于阅读差异
  assertEquals((error as Error).message, "业务步骤失败");
  assertEquals(
    errors.some((line) =>
      line.includes("body-and-cleanup") &&
      line.includes("context 关闭失败")
    ),
    true,
  );
  assertEquals(browser.closed, 1);
});

Deno.test("withBrowserJourney: closeSession 提前关闭的 context 收尾不重复关闭", async () => {
  const browser = new FakeBrowser();
  await withBrowserJourney(
    "anonymous-close",
    async (journey) => {
      const anonymous = await journey.newSession("anonymous");
      await journey.closeSession(anonymous);
      // 幂等：重复关闭不抛错，也不产生第二次 close
      await journey.closeSession(anonymous);
      assertEquals(anonymous.actorLabel, "anonymous");
    },
    {
      launcher: launcherFor(browser),
      artifactDir: ARTIFACT_DIR,
      runId: "run9",
    },
  );
  assertEquals(browser.contexts[0].closed, 1);
  assertEquals(browser.contexts[0].tracing.stopPaths, []);
  assertEquals(browser.closed, 1);
});
