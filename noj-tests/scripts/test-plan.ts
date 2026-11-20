/**
 * Browser E2E 分组计划（P6-A 纯规划模块，单一事实源）。
 *
 * 规则与 Core 分片保持一致（见 `noj-core/scripts/test-parallel-shards.ts`）：
 * 先发现实际存在的 Browser 测试文件，再按文件级耗时基线降序分配到当前累计耗时
 * 最少的分组，同耗时按路径升序，保证同一输入永远产出同一计划。
 *
 * 与 Core 的差异（有意为之）：
 * - 没有"每个分片都必须执行"的迁移入口，Browser 文件天然互不重复；
 * - 默认分 3 组，未知文件回退 15 秒（Browser 单文件成本远高于 Core 单测）；
 * - 路径以 noj-tests 模块根为基准（`e2e/browser/x.test.ts`），基线里若带
 *   `noj-tests/` 前缀会在加载时归一化。
 *
 * 本模块只在函数内部读文件系统，导入时不产生副作用，可被 `test:logic`
 * 的零依赖测试直接使用。
 */

/** 默认 Browser 分组数：3 组覆盖当前 14 个 Browser 测试文件。 */
export const DEFAULT_BROWSER_GROUP_COUNT = 3;

/** 基线里查不到的新文件按此耗时估值（毫秒），基线存在时由基线中位数替换。 */
export const FALLBACK_BROWSER_FILE_DURATION_MS = 15_000;

/** Browser 测试目录（相对 noj-tests 模块根）。 */
export const BROWSER_TEST_ROOT = "e2e/browser";

/** 单个分组的执行计划。 */
export interface BrowserGroup {
  /** 稳定名称：`browser1`…`browserN`，同时用于 JUnit 文件名与 `--shard` 取值。 */
  groupName: string;
  /** 该组要执行的测试文件（模块相对路径，升序）。 */
  files: string[];
  /** 按基线/中位数估值的分组耗时（毫秒），仅用于调度与报告。 */
  estimatedMs: number;
}

/** 文件级耗时基线的解析结果（结构同 dev-docs/engineering/test-duration-baseline.json）。 */
export interface FileDurationBaseline {
  version: number;
  generatedAt: string;
  source: string;
  /** noj-tests 模块相对路径 → 实测耗时毫秒。 */
  files: Record<string, number>;
}

/** 一次 Browser 分组计划的完整输入与产出，供启动器写报告与零依赖测试断言。 */
export interface BrowserPlan {
  groupCount: number;
  /** 发现后进入计划的全部测试文件，已去重、规范化并升序排序。 */
  selectedFiles: string[];
  groups: BrowserGroup[];
  baseline: {
    /** 基线来源；未读到基线时为 `none`。 */
    source: string;
    generatedAt: string;
    knownFiles: number;
    /** 未知文件的估值（毫秒）：基线中位数或内置回退值。 */
    unknownMs: number;
  };
}

/**
 * 路径规范化：统一分隔符、去掉 `./` 前缀、折叠重复分隔符与结尾斜杠。
 *
 * 只做字符串层面的规范化（不解析 `..`）：计划只接受由发现逻辑产生的真实测试
 * 文件路径，接受越界路径会让报告与清理不可审计。
 *
 * @param relativePath - 任意书写的模块相对路径
 * @returns 规范化后的模块相对路径
 */
export function normalizeBrowserTestPath(relativePath: string): string {
  return relativePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

/**
 * 判断文件是否属于 Browser 测试集合。
 *
 * `_*.ts` 是夹具（如 `_workspace-input-mode-fixtures.ts`），不是用例文件。
 *
 * @param relativePath - 模块相对路径
 * @returns 是否应进入 Browser 分组计划
 */
export function isBrowserTestFile(relativePath: string): boolean {
  const normalized = normalizeBrowserTestPath(relativePath);
  if (!normalized.endsWith(".test.ts")) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return !base.startsWith("_");
}

/**
 * 发现 Browser 测试文件（`e2e/browser` 下的 `*.test.ts`，排除 `_*` 夹具）。
 *
 * @param rootDir - noj-tests 模块根目录（绝对或相对路径），默认为当前目录
 * @returns 去重、规范化并升序排序的模块相对路径
 */
export async function discoverBrowserTestFiles(
  rootDir = ".",
): Promise<string[]> {
  const base = `${rootDir.replace(/\/+$/, "")}/${BROWSER_TEST_ROOT}`;
  const seen = new Set<string>();
  const walk = async (absoluteDir: string, relativeDir: string) => {
    for await (const entry of Deno.readDir(absoluteDir)) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith(".")) continue;
        await walk(`${absoluteDir}/${entry.name}`, relativePath);
        continue;
      }
      if (!entry.isFile) continue;
      const normalized = normalizeBrowserTestPath(relativePath);
      if (isBrowserTestFile(normalized)) seen.add(normalized);
    }
  };
  await walk(base, BROWSER_TEST_ROOT);
  return [...seen].sort();
}

/** 计算中位数；空数组返回 undefined。 */
function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/**
 * 按基线把 Browser 测试文件分配到 N 个分组。
 *
 * 规则（与 Core 分片一致）：
 * 1. 路径规范化、去重、升序，空路径丢弃；
 * 2. 按耗时降序排序，同耗时按路径升序，保证同一输入永远产出同一计划；
 * 3. 每个文件分配给当前累计耗时最少的分组，平局取较小分组序号；
 * 4. 分组内文件升序排序。
 *
 * @param files - 已发现的 Browser 测试文件（可含重复/未规范化路径）
 * @param groupCount - 分组数（≥1 的整数）
 * @param durations - 已知耗时映射；查不到的文件用 `unknownMs`
 * @param unknownMs - 未知文件估值（毫秒）
 * @returns 每个文件恰好落入一个分组的计划
 */
export function partitionBrowserFiles(
  files: readonly string[],
  groupCount: number,
  durations: Record<string, number> = {},
  unknownMs = FALLBACK_BROWSER_FILE_DURATION_MS,
): BrowserGroup[] {
  if (!Number.isInteger(groupCount) || groupCount < 1) {
    throw new Error(`Browser 分组数必须为 ≥1 的整数，实际 ${groupCount}`);
  }
  const unique = [
    ...new Set(
      files.map(normalizeBrowserTestPath).filter((file) => file.length > 0),
    ),
  ].sort();

  const groups: BrowserGroup[] = Array.from(
    { length: groupCount },
    (_, index) => ({
      groupName: `browser${index + 1}`,
      files: [],
      estimatedMs: 0,
    }),
  );

  const weighted = unique.map((file) => ({
    file,
    duration: durations[file] ?? unknownMs,
  }));
  weighted.sort((left, right) =>
    right.duration === left.duration
      ? left.file < right.file ? -1 : left.file === right.file ? 0 : 1
      : right.duration - left.duration
  );

  for (const { file, duration } of weighted) {
    let target = groups[0]!;
    for (const group of groups) {
      if (group.estimatedMs < target.estimatedMs) target = group;
    }
    target.files.push(file);
    target.estimatedMs += duration;
  }

  for (const group of groups) group.files.sort();
  return groups;
}

/**
 * 组装完整 Browser 分组计划：估算未知文件 → 分配 → 覆盖守卫。
 *
 * @param files - 已发现的 Browser 测试文件
 * @param baseline - 文件级耗时基线
 * @param groupCount - 分组数，默认 {@link DEFAULT_BROWSER_GROUP_COUNT}
 * @returns 带基线来源与未知估值的完整计划
 * @throws 分组数非法，或分组计划未做到"每个文件恰好一组"时
 */
export function buildBrowserPlan(
  files: readonly string[],
  baseline: FileDurationBaseline,
  groupCount = DEFAULT_BROWSER_GROUP_COUNT,
): BrowserPlan {
  const unknownMs = medianOf(Object.values(baseline.files)) ??
    FALLBACK_BROWSER_FILE_DURATION_MS;
  const selected = [
    ...new Set(
      files.map(normalizeBrowserTestPath).filter((file) => file.length > 0),
    ),
  ].sort();
  const groups = partitionBrowserFiles(
    selected,
    groupCount,
    baseline.files,
    unknownMs,
  );
  const problems = auditPlan(groups, selected);
  if (problems.length > 0) {
    throw new Error(`Browser 分组计划不完整：\n- ${problems.join("\n- ")}`);
  }
  return {
    groupCount,
    selectedFiles: selected,
    groups,
    baseline: {
      source: baseline.source,
      generatedAt: baseline.generatedAt,
      knownFiles: Object.keys(baseline.files).length,
      unknownMs,
    },
  };
}

/**
 * 覆盖守卫：断言每个文件恰好出现在一个分组中。
 *
 * @param plan - 分组列表，或 {@link buildBrowserPlan} 的完整计划
 * @param allFiles - 发现阶段得到的全部测试文件（可含重复/未规范化路径）
 * @returns 违规说明列表；空数组表示计划完整
 */
export function auditPlan(
  plan: readonly BrowserGroup[] | BrowserPlan,
  allFiles: readonly string[],
): string[] {
  // readonly 数组不能由 Array.isArray 收窄，显式区分两种入参。
  const groups: readonly BrowserGroup[] = Array.isArray(plan)
    ? plan
    : (plan as BrowserPlan).groups;
  const expected = [
    ...new Set(
      allFiles.map(normalizeBrowserTestPath).filter((file) => file.length > 0),
    ),
  ].sort();
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const group of groups) {
    const local = new Set<string>();
    for (const file of group.files) {
      if (local.has(file)) {
        problems.push(`分组 ${group.groupName} 重复包含 ${file}`);
        continue;
      }
      local.add(file);
      const previous = seen.get(file);
      if (previous) {
        problems.push(`${file} 同时出现在 ${previous} 与 ${group.groupName}`);
      }
      seen.set(file, group.groupName);
    }
  }
  const missing = expected.filter((file) => !seen.has(file));
  if (missing.length > 0) {
    problems.push(`以下测试文件未进入任何分组：${missing.join("、")}`);
  }
  const expectedSet = new Set(expected);
  for (const file of seen.keys()) {
    if (!expectedSet.has(file)) {
      problems.push(`分组包含计划外的文件：${file}`);
    }
  }
  return problems;
}

/** 基线不可用时的空基线；调用方仍会显式记录来源为 `none`。 */
export function emptyBrowserBaseline(): FileDurationBaseline {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "none",
    files: {},
  };
}

/** 基线键归一化：允许生成方使用 `noj-tests/` 前缀。 */
function normalizeBaselineKey(path: string): string {
  const normalized = normalizeBrowserTestPath(path);
  return normalized.startsWith("noj-tests/")
    ? normalized.slice("noj-tests/".length)
    : normalized;
}

/**
 * 读取 Browser 文件级耗时基线并校验最小结构。
 *
 * 基线缺失/损坏时抛错：静默退化成"全用中位数"会让分组调度失去依据，却仍在
 * 报告里显示为均衡。
 *
 * @param path - 基线 JSON 路径
 * @returns 规范化后的基线
 * @throws 文件不存在、JSON 非法、版本/字段/耗时不合法时
 */
export async function loadBrowserDurationBaseline(
  path: string,
): Promise<FileDurationBaseline> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Browser 测试耗时基线不存在：${path}；如需从零开始，请显式传入 emptyBrowserBaseline()`,
        { cause: error },
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Browser 测试耗时基线不是合法 JSON：${path}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Browser 测试耗时基线不是对象：${path}`);
  }
  const baseline = parsed as Partial<FileDurationBaseline>;
  if (baseline.version !== 1) {
    throw new Error(
      `不支持的 Browser 测试耗时基线版本：${String(baseline.version)}`,
    );
  }
  if (typeof baseline.generatedAt !== "string" || !baseline.generatedAt) {
    throw new Error("Browser 测试耗时基线缺少 generatedAt");
  }
  if (typeof baseline.source !== "string" || !baseline.source) {
    throw new Error("Browser 测试耗时基线缺少 source（必须说明数据来源）");
  }
  if (!baseline.files || typeof baseline.files !== "object") {
    throw new Error("Browser 测试耗时基线缺少 files 映射");
  }
  const files: Record<string, number> = {};
  for (const [file, duration] of Object.entries(baseline.files)) {
    if (
      typeof duration !== "number" || !Number.isFinite(duration) || duration < 0
    ) {
      throw new Error(
        `Browser 测试耗时基线中 ${file} 的耗时不合法：${duration}`,
      );
    }
    files[normalizeBaselineKey(file)] = duration;
  }
  return {
    version: 1,
    generatedAt: baseline.generatedAt,
    source: baseline.source,
    files,
  };
}
