/// <reference lib="dom" />
/**
 * 浏览器 E2E 共享辅助（issue #427 / 搜索统一 E2E / 测试提速 P4）。
 *
 * 生命周期约定：每个顶层 journey 只启动一个 Chromium，每个角色或独立场景一个
 * BrowserContext（各自独立的 Cookie/storage/trace）；session 收尾只关 context，
 * journey 的 finally 才关 Browser。多角色旅程因此只付一次进程启动成本，
 * 角色之间仍然完全隔离：A 登录/退出不影响 B。
 */

export const BROWSER_E2E = Deno.env.get("NOJ_RUN_BROWSER_E2E") === "1";
export const UI_URL = Deno.env.get("E2E_UI_URL") || "http://localhost:3000";
export const ARTIFACT_DIR = "test-results/ui-browser";

type Browser = import("npm:playwright@1.62.1").Browser;
type BrowserContext = import("npm:playwright@1.62.1").BrowserContext;
type Page = import("npm:playwright@1.62.1").Page;
type Locator = import("npm:playwright@1.62.1").Locator;

const VIEWPORT = { width: 1440, height: 900 } as const;

/** 进程级运行标识：同一 deno test 进程的诊断产物共享 run 前缀。 */
const DEFAULT_RUN_ID = `${Date.now().toString(36)}-${
  crypto.randomUUID().slice(0, 4)
}`;

/** 一个角色/场景的浏览器上下文；teardown 只关闭 context，不关闭 Browser。 */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** 角色或场景标签，用于失败诊断产物命名。 */
  actorLabel: string;
}

/** journey 内可用的夹具 API。 */
export interface BrowserJourneyFixture {
  /** 新建隔离上下文（独立 Cookie/storage/trace）并返回其首个页面。 */
  newSession(actorLabel: string): Promise<BrowserSession>;
  /** 提前关闭单个 session（例如匿名上下文）；journey 收尾不再重复关闭。 */
  closeSession(session: BrowserSession): Promise<void>;
}

/**
 * journey 生命周期需要的页面能力子集。
 *
 * 真实 Playwright `Page` 满足该结构；单元测试注入 fake 即可验证清理路径，
 * 不需要启动浏览器。
 */
export interface JourneyPage {
  on(event: "pageerror", handler: (error: Error) => void): unknown;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}

export interface JourneyTracing {
  start(
    options: { screenshots: boolean; snapshots: boolean; sources: boolean },
  ): Promise<void>;
  stop(options?: { path?: string }): Promise<void>;
}

export interface JourneyContext {
  tracing: JourneyTracing;
  newPage(): Promise<JourneyPage>;
  close(): Promise<void>;
}

export interface JourneyBrowser {
  newContext(
    options: { viewport: { width: number; height: number } },
  ): Promise<JourneyContext>;
  close(): Promise<void>;
}

/** 浏览器工厂；默认启动 headless Chromium，单元测试可注入 fake。 */
export type BrowserLauncher = () => Promise<JourneyBrowser>;

export interface BrowserJourneyOptions {
  /** 覆盖浏览器工厂（单元测试注入 fake）。 */
  launcher?: BrowserLauncher;
  /** 失败诊断产物目录，默认 {@link ARTIFACT_DIR}。 */
  artifactDir?: string;
  /** 覆盖运行标识，默认进程级 {@link DEFAULT_RUN_ID}。 */
  runId?: string;
}

const launchChromium: BrowserLauncher = async () => {
  const { chromium } = await import("npm:playwright@1.62.1");
  const browser = await chromium.launch({ headless: true });
  // Playwright 的 Page/BrowserContext 是超集，这里只需要生命周期所需子集。
  return browser as unknown as JourneyBrowser;
};

interface SessionRecord {
  actorLabel: string;
  context: BrowserContext;
  page?: Page;
}

/** 文件名安全化：保留字母/数字/点/横线/下划线，其余折叠为单个横线。 */
function artifactToken(value: string): string {
  const token = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return token === "" ? "unnamed" : token;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在一个共享 Chromium 上执行完整浏览器 journey。
 *
 * 失败语义：
 * - 业务步骤抛错 → 为每个 session 写 trace + 截图，关闭全部 context 与 Browser，
 *   然后抛出原始错误（保留断言差异可读性）；收尾错误逐条上报到日志。
 * - 业务步骤成功但收尾失败 → 抛出 AggregateError，不静默吞掉清理故障。
 * - 第二个 context 创建失败 → 已登记的 context 与 Browser 仍会被关闭。
 */
export async function withBrowserJourney(
  label: string,
  fn: (fixture: BrowserJourneyFixture) => Promise<void>,
  options: BrowserJourneyOptions = {},
): Promise<void> {
  const journey = artifactToken(label);
  const runId = artifactToken(options.runId ?? DEFAULT_RUN_ID);
  const artifactDir = options.artifactDir ?? ARTIFACT_DIR;
  const launcher = options.launcher ?? launchChromium;
  const browser = await launcher() as unknown as Browser;

  // 按创建顺序登记，收尾顺序固定，诊断产物可预期。
  const records: SessionRecord[] = [];
  const closedContexts = new Set<BrowserContext>();

  const fixture: BrowserJourneyFixture = {
    async newSession(actorLabel: string): Promise<BrowserSession> {
      const actor = artifactToken(actorLabel);
      const context = await browser.newContext({ viewport: { ...VIEWPORT } });
      // 先登记再启动 trace/页面：其中任一步失败，journey 收尾仍会关闭该 context。
      const record: SessionRecord = { actorLabel: actor, context };
      records.push(record);
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      const page = await context.newPage();
      record.page = page;
      page.on("pageerror", (error) => {
        console.error(`  [browser pageerror:${actor}] ${error.message}`);
      });
      return { context, page, actorLabel: actor };
    },
    async closeSession(session: BrowserSession): Promise<void> {
      if (closedContexts.has(session.context)) return;
      closedContexts.add(session.context);
      await session.context.close();
    },
  };

  const cleanupErrors: unknown[] = [];

  /** 失败诊断：trace 与截图各自独立，一个失败不掩盖另一个。 */
  async function writeDiagnostics(record: SessionRecord): Promise<void> {
    try {
      await Deno.mkdir(artifactDir, { recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    const base = `${runId}-${journey}-${record.actorLabel}`;
    try {
      await record.context.tracing.stop({
        path: `${artifactDir}/trace-${base}.zip`,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (record.page) {
      try {
        await record.page.screenshot({
          path: `${artifactDir}/failure-${base}.png`,
          fullPage: true,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  let bodyFailed = false;
  let bodyError: unknown;
  try {
    await fn(fixture);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  for (const record of records) {
    if (closedContexts.has(record.context)) continue;
    if (bodyFailed) {
      await writeDiagnostics(record);
    } else {
      try {
        await record.context.tracing.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await record.context.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await browser.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (bodyFailed) {
    console.log(
      `  → 失败诊断产物目录 ${artifactDir}/（run=${runId} journey=${journey}）`,
    );
    for (const error of cleanupErrors) {
      console.error(`  [teardown:${journey}] ${describeError(error)}`);
    }
    throw bodyError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `浏览器旅程 ${journey} 收尾失败（${cleanupErrors.length} 项）`,
    );
  }
}

export async function gotoPage(page: Page, path: string): Promise<void> {
  await page.goto(`${UI_URL}${path}`, { waitUntil: "domcontentloaded" });
  // SSR 的按钮可见时，异步页面仍可能尚未绑定事件；等待 Nuxt 完成水合后再操作。
  await page.waitForFunction(() => {
    const root = document.querySelector("#__nuxt") as
      | Element & {
        __vue_app__?: { $nuxt?: { isHydrating: boolean } };
      }
      | null;
    return root?.__vue_app__?.$nuxt?.isHydrating === false;
  });
}

export async function assertClassContains(
  element: Locator,
  className: string,
  _label: string,
  timeout = 15_000,
): Promise<void> {
  // 惰性加载断言库：生命周期模块被零依赖单测导入时不触发 Playwright 加载。
  const { expect } = await import("npm:playwright@1.62.1/test");
  await expect(element).toContainClass(className, { timeout });
}
