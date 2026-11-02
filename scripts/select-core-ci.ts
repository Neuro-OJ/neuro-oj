/**
 * CI 影响范围选择器（P5-B）。
 *
 * 输入是 PR 的**实际变更路径**（含删除/重命名前后路径），输出 Core 任务与
 * E2E 任务的最小充分集合。选择规则全部来自 `dev-docs/engineering/module-boundaries.json`：
 *
 * - Core 测试文件变更 → 所属模块测试 + 固定契约检查；
 * - Core 生产模块变更 → 所属模块 + 反向依赖闭包（可合并 base 依赖）+ Browser/cross-domain；
 * - shared/schema/迁移/启动器/模块映射/无法归属 → 全量 Core；
 * - E2E 模块映射由元数据给出；application/http/runtime 与通用基础设施 → 全部 API E2E；
 * - 锁文件、测试基础设施、共享夹具 → 全量相关模块/E2E；
 * - 解析失败或无法解释的路径 → 扩大到全量并写明原因，绝不输出空选择。
 *
 * 出口同时兼容 GitHub Actions（写 `GITHUB_OUTPUT`）与本地调试（打印 JSON）。
 */
import {
  CI_SELECTION,
  E2E_API_DOMAINS,
  E2E_CI_MAPPING,
  isTestFilePath,
  matchesGlob,
  MODULE_DEPENDENCIES,
  moduleForCorePath,
  reverseDependencyClosure,
} from "./module-test-metadata.ts";

/** 变更类型（`git diff --name-status` 的语义）。 */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** 一条变更：重命名带前后路径，其余只有 `path`。 */
export interface ChangedPath {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
}

/** 单条路径的分类结果。 */
export interface PathClassification {
  kind:
    | "core-full"
    | "core-module"
    | "e2e-domain"
    | "e2e-infra"
    | "browser"
    | "cross-domain"
    | "logic-only"
    | "global"
    | "docs"
    | "ignored"
    | "unknown";
  module?: string;
  /** 只有测试文件变更：不触发 E2E，只跑该模块测试。 */
  testOnly?: boolean;
  domain?: string;
}

/** E2E 选择结果。 */
export interface E2eSelection {
  /** 需要执行的 API E2E 域。 */
  domains: string[];
  /** 是否选中全部 API E2E 域。 */
  allApi: boolean;
  browser: boolean;
  crossDomain: boolean;
}

/** Core + E2E 的完整选择结果。 */
export interface CoreSelection {
  /** 是否需要执行全量 Core 回归。 */
  coreFull: boolean;
  /** 直接变更的模块。 */
  directModules: string[];
  /** 直接变更模块 + 反向依赖闭包。 */
  modules: string[];
  /** 固定契约检查（任何 Core 变更都执行）。 */
  contracts: string[];
  e2e: E2eSelection;
  /** 人类可读的选择理由（写入 job summary / 日志）。 */
  reasons: string[];
}

/** 选择器输入选项。 */
export interface SelectionOptions {
  /** 强制全量（main push / 手动触发）。 */
  full?: boolean;
  /** base 版本的依赖图；与 head 合并，避免 PR 删除依赖时漏选。 */
  baseDependencies?: Record<string, string[]>;
}

/** 固定契约检查：Core 任何变更都必须通过的基础门禁。 */
export const FIXED_CONTRACTS = [
  "cd noj-core && deno task test:logic",
  "cd noj-core && deno task check:contracts",
] as const;

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * 把单条路径分类。顺序即优先级，避免文档后缀或模块根互相覆盖。
 *
 * @param path - 仓库相对路径
 */
export function classifyChangedPath(path: string): PathClassification {
  const selection = CI_SELECTION;
  if (matchesPrefix(path, selection.ignoredPrefixes)) {
    return { kind: "ignored" };
  }
  if (selection.coreFullFiles.includes(path)) {
    return { kind: "core-full" };
  }
  if (
    selection.docSuffixes.some((suffix) => path.endsWith(suffix)) ||
    matchesPrefix(path, selection.docPrefixes)
  ) {
    return { kind: "docs" };
  }
  if (path.startsWith("noj-tests/")) {
    if (matchesPrefix(path, selection.logicOnlyPrefixes)) {
      return { kind: "logic-only" };
    }
    const e2e = /^noj-tests\/e2e\/([^/]+)(?:\/|$)/.exec(path);
    if (e2e) {
      const domain = e2e[1]!;
      if (domain === "browser") return { kind: "browser" };
      if (domain === "cross-domain") return { kind: "cross-domain" };
      if (E2E_API_DOMAINS.includes(domain)) {
        return { kind: "e2e-domain", domain };
      }
      return { kind: "e2e-infra" };
    }
    if (
      matchesPrefix(path, selection.e2eInfraPrefixes) ||
      selection.e2eInfraFiles.includes(path) ||
      selection.e2eInfraGlobs.some((glob) => matchesGlob(path, glob))
    ) {
      return { kind: "e2e-infra" };
    }
    return { kind: "unknown" };
  }
  if (path.startsWith("noj-core/") || path.startsWith("src/")) {
    if (matchesPrefix(path, selection.coreFullPrefixes)) {
      return { kind: "core-full" };
    }
    const module = moduleForCorePath(path);
    if (module) {
      return { kind: "core-module", module, testOnly: isTestFilePath(path) };
    }
    return { kind: "unknown" };
  }
  if (
    path.startsWith(".github/") || path.startsWith("scripts/") ||
    selection.coreFullPrefixes.some((prefix) => path.startsWith(prefix))
  ) {
    // 测试基础设施与工作流自身：既影响 Core 回归，也可能改变 E2E 编排。
    return { kind: "global" };
  }
  if (matchesPrefix(path, selection.browserPrefixes)) {
    return { kind: "browser" };
  }
  if (
    matchesPrefix(path, selection.e2eInfraPrefixes) ||
    selection.e2eInfraFiles.includes(path) ||
    selection.e2eInfraGlobs.some((glob) => matchesGlob(path, glob))
  ) {
    return { kind: "e2e-infra" };
  }
  return { kind: "unknown" };
}

function mergeDependencies(
  base: Record<string, string[]>,
  extra?: Record<string, string[]>,
): Record<string, string[]> {
  if (!extra) return base;
  const merged: Record<string, string[]> = {};
  for (const module of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    merged[module] = [
      ...new Set([...(base[module] ?? []), ...(extra[module] ?? [])]),
    ].sort();
  }
  return merged;
}

/**
 * 从变更路径计算 Core + E2E 选择。
 *
 * @param changes - 变更记录（重命名的前后路径都会被评估）
 * @param options - 全量开关与 base 依赖图
 */
export function selectFromPaths(
  changes: readonly ChangedPath[],
  options: SelectionOptions = {},
): CoreSelection {
  const reasons: string[] = [];
  const direct = new Set<string>();
  const production = new Set<string>();
  const apiDomains = new Set<string>();
  let coreFull = Boolean(options.full);
  let browser = false;
  let crossDomain = false;
  let allApi = false;

  if (options.full) {
    reasons.push("main push / 手动触发 / 显式 --full：执行全量功能测试");
  }

  for (const change of changes) {
    for (const path of [change.previousPath, change.path]) {
      if (!path) continue;
      const classification = classifyChangedPath(path);
      const prefix = change.previousPath && path === change.previousPath
        ? `（重命名前）`
        : "";
      switch (classification.kind) {
        case "core-full":
          coreFull = true;
          reasons.push(
            `${path}${prefix}: 共享/迁移/启动器/模块映射路径 → 全量 Core`,
          );
          break;
        case "core-module": {
          direct.add(classification.module!);
          if (classification.testOnly) {
            reasons.push(
              `${path}${prefix}: ${classification.module} 测试文件 → 模块测试 + 固定契约`,
            );
          } else {
            production.add(classification.module!);
            reasons.push(
              `${path}${prefix}: ${classification.module} 生产代码 → 模块 + 反向依赖闭包`,
            );
          }
          break;
        }
        case "e2e-domain":
          apiDomains.add(classification.domain!);
          reasons.push(`${path}${prefix}: E2E ${classification.domain}`);
          break;
        case "e2e-infra":
          allApi = true;
          crossDomain = true;
          browser = true;
          reasons.push(
            `${path}${prefix}: E2E 共享基础设施 → 全部 API + Browser + cross-domain`,
          );
          break;
        case "browser":
          browser = true;
          reasons.push(`${path}${prefix}: 前端产物 → Browser E2E`);
          break;
        case "cross-domain":
          crossDomain = true;
          reasons.push(`${path}${prefix}: 跨域流水线 → cross-domain E2E`);
          break;
        case "logic-only":
          reasons.push(`${path}${prefix}: 零依赖单测 → 由自身 test:logic 覆盖`);
          break;
        case "global":
          coreFull = true;
          allApi = true;
          crossDomain = true;
          browser = true;
          reasons.push(
            `${path}${prefix}: 测试基础设施/工作流 → 全量 Core + 全量 E2E`,
          );
          break;
        case "docs":
          reasons.push(`${path}${prefix}: 文档 → 不触发测试`);
          break;
        case "ignored":
          reasons.push(`${path}${prefix}: 由模块自身 CI 覆盖`);
          break;
        case "unknown":
          coreFull = true;
          allApi = true;
          crossDomain = true;
          browser = true;
          reasons.push(
            `${path}${prefix}: 无法归属 → 扩大到全量（不允许零测试）`,
          );
          break;
      }
    }
  }

  for (const module of production) {
    const mapping = E2E_CI_MAPPING[module] ?? {};
    if (mapping.allApiDomains) allApi = true;
    for (const domain of mapping.domains ?? []) apiDomains.add(domain);
    if (mapping.browser) browser = true;
    if (mapping.crossDomain) crossDomain = true;
  }
  if (production.size > 0) {
    // 计划要求：Core 生产模块变更附加 Browser 与 cross-domain 回归。
    browser = true;
    crossDomain = true;
  }
  if (coreFull) {
    allApi = true;
    crossDomain = true;
    browser = true;
  }
  if (allApi) {
    for (const domain of E2E_API_DOMAINS) apiDomains.add(domain);
  }

  const edges = mergeDependencies(
    MODULE_DEPENDENCIES,
    options.baseDependencies,
  );
  // 反向依赖闭包只对**生产代码**变更展开：测试文件变更不改变被依赖方行为，
  // 只需跑所属模块自己的测试与固定契约。
  const modules = [
    ...new Set([
      ...direct,
      ...reverseDependencyClosure([...production], edges),
    ]),
  ].sort();
  const domains = [
    ...E2E_API_DOMAINS.filter((domain) => apiDomains.has(domain)),
    ...(crossDomain ? ["cross-domain"] : []),
    ...(browser ? ["browser"] : []),
  ];
  return {
    coreFull,
    directModules: [...direct].sort(),
    modules,
    contracts: direct.size > 0 || coreFull ? [...FIXED_CONTRACTS] : [],
    e2e: { domains, allApi, browser, crossDomain },
    reasons: [...new Set(reasons)],
  };
}

/**
 * 解析 `git diff --name-status -z` 输出。
 *
 * 记录格式：`A\0path\0`、`M\0path\0`、`D\0path\0`、`R100\0old\0new\0`。
 *
 * @param output - 原始输出（NUL 分隔）
 */
export function parseNameStatusRecords(output: string): ChangedPath[] {
  const tokens = output.split("\0");
  const changes: ChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    if (/^[RC]\d+$/.test(status)) {
      const previousPath = tokens[++index];
      const path = tokens[++index];
      if (!previousPath || !path) break;
      changes.push({ path, previousPath, status: "renamed" });
      continue;
    }
    const kind = status[0];
    const path = tokens[++index];
    if (!path) continue;
    const map: Record<string, ChangeStatus> = {
      A: "added",
      M: "modified",
      D: "deleted",
      T: "modified",
    };
    const normalized = map[kind];
    if (!normalized) continue;
    changes.push({ path, status: normalized });
  }
  return changes;
}

/** CLI 选项。 */
export interface SelectorCliOptions {
  paths: string[];
  changedFiles?: string;
  base?: string;
  head?: string;
  event?: string;
  ref?: string;
  full: boolean;
  output?: string;
}

/** 解析选择器 CLI。 */
export function parseSelectorArgs(args: readonly string[]): SelectorCliOptions {
  const options: SelectorCliOptions = { paths: [], full: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--base") {
      options.base = args[++index];
      continue;
    }
    if (arg === "--head") {
      options.head = args[++index];
      continue;
    }
    if (arg === "--event") {
      options.event = args[++index];
      continue;
    }
    if (arg === "--ref") {
      options.ref = args[++index];
      continue;
    }
    if (arg === "--changed-files") {
      options.changedFiles = args[++index];
      continue;
    }
    if (arg === "--output") {
      options.output = args[++index];
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`选择器不识别参数：${arg}`);
    }
    options.paths.push(arg);
  }
  return options;
}

/** 读取 base 版本的依赖图（模块映射 PR 需要合并 base/head）。 */
export async function readBaseDependencies(
  base?: string,
): Promise<Record<string, string[]> | undefined> {
  if (!base) return undefined;
  try {
    const result = await new Deno.Command("git", {
      args: [
        "-C",
        new URL("../", import.meta.url).pathname,
        "show",
        `${base}:dev-docs/engineering/module-boundaries.json`,
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      moduleDependencies?: Record<string, string[]>;
    };
    return parsed.moduleDependencies;
  } catch {
    return undefined;
  }
}

async function changedPathsFromGit(
  base: string,
  head: string,
): Promise<ChangedPath[]> {
  const result = await new Deno.Command("git", {
    args: [
      "-C",
      new URL("../", import.meta.url).pathname,
      "diff",
      "--name-status",
      "-z",
      "-M",
      `${base}...${head}`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git diff 失败：${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return parseNameStatusRecords(new TextDecoder().decode(result.stdout));
}

async function resolveChanges(
  options: SelectorCliOptions,
): Promise<{ changes: ChangedPath[]; failure?: string }> {
  if (options.paths.length > 0) {
    return {
      changes: options.paths.map((path) => ({ path, status: "modified" })),
    };
  }
  if (options.changedFiles) {
    const text = await Deno.readTextFile(options.changedFiles);
    return { changes: parseNameStatusRecords(text) };
  }
  if (!options.base || !options.head) {
    return { changes: [], failure: "缺少 --base/--head，按全量处理" };
  }
  try {
    return { changes: await changedPathsFromGit(options.base, options.head) };
  } catch (error) {
    return {
      changes: [],
      failure: `git diff 解析失败，按全量处理：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * 运行选择器 CLI：写 `GITHUB_OUTPUT` 或打印 JSON。
 *
 * 解析失败时**不返回空选择**，而是扩大到全量并记录原因。
 *
 * @param args - 命令行参数
 * @param env - 环境变量（测试可注入）
 */
export async function runSelector(
  args: readonly string[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<number> {
  const options = parseSelectorArgs(args);
  const isFullEvent = options.event === "workflow_dispatch" ||
    options.event === "workflow_call" ||
    (options.event === "push" && options.ref === "refs/heads/main");
  const { changes, failure } = await resolveChanges(options);
  const selection = selectFromPaths(changes, {
    full: options.full || isFullEvent || Boolean(failure),
    baseDependencies: await readBaseDependencies(options.base),
  });
  if (failure) selection.reasons.unshift(failure);

  const outputs = {
    "core-full": String(selection.coreFull),
    "core-modules": JSON.stringify(selection.modules),
    "core-direct-modules": JSON.stringify(selection.directModules),
    "core-contracts": JSON.stringify(selection.contracts),
    "core-reasons": selection.reasons.join("; "),
    "e2e-domains": JSON.stringify(selection.e2e.domains),
    "e2e-browser": String(selection.e2e.browser),
  };
  console.log(
    `[select-core-ci] coreFull=${selection.coreFull} modules=${
      selection.modules.join(",") || "-"
    } e2e=${selection.e2e.domains.join(",") || "-"}`,
  );
  for (const reason of selection.reasons) console.log(`  - ${reason}`);

  const outputPath = options.output ?? env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await Deno.writeTextFile(outputPath, `${lines}\n`, { append: true });
  } else {
    console.log(JSON.stringify(selection, null, 2));
  }
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await runSelector(Deno.args));
  } catch (error) {
    // 选择器自身失败必须偏保守：输出全量选择，避免 workflow 以空选择通过。
    console.error(`[select-core-ci] 失败，扩大为全量：${String(error)}`);
    const outputPath = Deno.env.get("GITHUB_OUTPUT");
    if (outputPath) {
      await Deno.writeTextFile(
        outputPath,
        [
          "core-full=true",
          `core-modules=${JSON.stringify(Object.keys(E2E_CI_MAPPING))}`,
          "core-contracts=[]",
          `e2e-domains=${
            JSON.stringify([...E2E_API_DOMAINS, "cross-domain", "browser"])
          }`,
          "e2e-browser=true",
          "core-reasons=选择器异常，按全量处理",
        ].join("\n") + "\n",
        { append: true },
      );
    }
    Deno.exit(0);
  }
}
