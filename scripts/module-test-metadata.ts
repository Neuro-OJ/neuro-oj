/**
 * Core 测试发现与 CI 映射的单一元数据读取点。
 *
 * `dev-docs/engineering/module-boundaries.json` 是唯一事实源：目标模块、旧命令
 * 别名、测试 task 和 CI job 都从那里读取。Core 的测试启动器通过本模块取得同一
 * 份值，因此新增模块测试目录不会只被静态结构诊断发现，而在 `test:domain` /
 * 并行分片中静默漏跑。
 */
import metadata from "../dev-docs/engineering/module-boundaries.json" with {
  type: "json",
};

export interface ModuleTestMapping {
  testTasks: string[];
  ciJobs: string[];
}

export interface ModuleTestTarget {
  name: string;
  root: string;
  kind: string;
  legacyDomains: string[];
}

/** 一个目标模块对应的 E2E 选择映射（P5-B）。 */
export interface E2eCiMapping {
  /** 该模块变更需要执行的 API E2E 域。 */
  domains?: string[];
  /** 为 true 时选择全部 API E2E 域（application/http/runtime 等组合层）。 */
  allApiDomains?: boolean;
  /** 需要附加 Browser E2E。 */
  browser?: boolean;
  /** 需要附加 cross-domain E2E。 */
  crossDomain?: boolean;
}

/** CI 影响范围选择器的路径分类配置（单一事实源）。 */
export interface CiSelectionConfig {
  /** 命中即"全量 Core"的路径前缀。 */
  coreFullPrefixes: string[];
  /** 命中即"全量 Core"的具体文件。 */
  coreFullFiles: string[];
  /** 命中即"全部相关 E2E"的路径前缀。 */
  e2eInfraPrefixes: string[];
  /** 命中即"全部相关 E2E"的 glob（支持 `*` / `**`）。 */
  e2eInfraGlobs: string[];
  /** 命中即"全部相关 E2E"的具体文件。 */
  e2eInfraFiles: string[];
  /** 只影响 Browser E2E 的路径前缀。 */
  browserPrefixes: string[];
  /** 只是零依赖单元测试、不需要 E2E 的路径前缀。 */
  logicOnlyPrefixes: string[];
  /** 文档路径前缀（不触发测试）。 */
  docPrefixes: string[];
  /** 文档后缀（不触发测试）。 */
  docSuffixes: string[];
  /** 由自身 CI job 覆盖、不需 Core/E2E 的路径前缀。 */
  ignoredPrefixes: string[];
}

export interface ModuleTestMetadata {
  targetModules: ModuleTestTarget[];
  legacyDomainToModule: Record<string, string>;
  legacyTestTargets: Record<string, string[]>;
  testCiMapping: Record<string, ModuleTestMapping>;
  /** 模块 → 其生产代码直接 import 的目标模块（P5-B 反向依赖闭包）。 */
  moduleDependencies: Record<string, string[]>;
  /** 全部 API E2E 域（与 noj-tests/e2e 目录一致，由 verify-domain-ci 校验）。 */
  e2eApiDomains: string[];
  /** 目标模块 → E2E 选择映射。 */
  e2eCiMapping: Record<string, E2eCiMapping>;
  /** 路径分类配置。 */
  ciSelection: CiSelectionConfig;
}

export const MODULE_TEST_METADATA = metadata as ModuleTestMetadata;

export const TARGET_MODULE_NAMES = MODULE_TEST_METADATA.targetModules.map((
  module,
) => module.name);

export const BUSINESS_MODULE_NAMES = MODULE_TEST_METADATA.targetModules
  .filter((module) => module.kind === "business")
  .map((module) => module.name);

export const LEGACY_DOMAIN_NAMES = Object.keys(
  MODULE_TEST_METADATA.legacyDomainToModule,
);

/** 模块 → 直接依赖的目标模块。 */
export const MODULE_DEPENDENCIES = MODULE_TEST_METADATA.moduleDependencies;

/** 全部 API E2E 域（不含 cross-domain / browser）。 */
export const E2E_API_DOMAINS = MODULE_TEST_METADATA.e2eApiDomains;

/** 目标模块 → E2E 选择映射。 */
export const E2E_CI_MAPPING = MODULE_TEST_METADATA.e2eCiMapping;

/** 影响范围选择器的路径分类配置。 */
export const CI_SELECTION = MODULE_TEST_METADATA.ciSelection;

function coreRelativeRoot(root: string): string {
  return root.replace(/^noj-core\//, "");
}

/** 一个业务模块可以由多个明确的子模块组成；测试发现必须覆盖所有子根。 */
function targetTestRoots(module: ModuleTestTarget): string[] {
  const root = coreRelativeRoot(module.root);
  const nested = module.name === "access"
    ? ["identity", "workspace"].map((part) => `${root}/${part}/tests`)
    : module.name === "communication"
    ? ["community"].map((part) => `${root}/${part}/tests`)
    : module.name === "platform"
    ? ["system", "gateway", "observability", "legal"].map((part) =>
      `${root}/${part}/tests`
    )
    : module.name === "read-models"
    ? ["queries", "search"].map((part) => `${root}/${part}/tests`)
    : module.name === "http"
    ? [`${root}/admin/tests`]
    : [];
  return [`${root}/tests`, ...nested];
}

/** 解析目标模块名或旧命令别名。 */
export function resolveModuleTestTarget(
  targetOrLegacy: string,
): ModuleTestTarget | undefined {
  const targetName =
    MODULE_TEST_METADATA.targetModules.some((module) =>
        module.name === targetOrLegacy
      )
      ? targetOrLegacy
      : MODULE_TEST_METADATA.legacyDomainToModule[targetOrLegacy];
  return MODULE_TEST_METADATA.targetModules.find((module) =>
    module.name === targetName
  );
}

/**
 * 返回目标模块的测试根。旧 domain 名称只作为命令兼容别名解析到目标模块，
 * 不再把已删除的 `src/domains/*` 实现重新纳入测试发现。
 */
export function testRootsForTarget(targetOrLegacy: string): string[] {
  const targetNames =
    MODULE_TEST_METADATA.targetModules.some((module) =>
        module.name === targetOrLegacy
      )
      ? [targetOrLegacy]
      : MODULE_TEST_METADATA.legacyTestTargets[targetOrLegacy] ??
        (MODULE_TEST_METADATA.legacyDomainToModule[targetOrLegacy]
          ? [MODULE_TEST_METADATA.legacyDomainToModule[targetOrLegacy]]
          : []);
  return [
    ...new Set(
      targetNames.flatMap((name) => {
        const target = MODULE_TEST_METADATA.targetModules.find((module) =>
          module.name === name
        );
        return target ? targetTestRoots(target) : [];
      }),
    ),
  ];
}

/** 返回所有目标及其 legacy 别名的测试根，供并行分片覆盖检查复用。 */
export function allModuleTestRoots(): string[] {
  return [
    ...new Set(
      MODULE_TEST_METADATA.targetModules.flatMap((module) =>
        testRootsForTarget(module.name)
      ),
    ),
  ];
}

/** 返回当前 12 个 target module 的测试根，不含已登记的 legacy roots。 */
export function allTargetModuleTestRoots(): string[] {
  return MODULE_TEST_METADATA.targetModules.flatMap(targetTestRoots);
}

/**
 * 把相对路径映射到目标模块。
 *
 * 同时识别迁移后的 `src/modules/<module>` 与迁移前的 `src/domains/<legacy>`
 * 路径：删除/重命名的 diff 会出现旧路径，只按新目录匹配会让它们在 PR 上静默
 * 失去影响范围。
 *
 * @param path - 仓库相对路径（可带 `noj-core/` 前缀）
 * @returns 目标模块名；不属于任何模块时返回 undefined
 */
export function moduleForCorePath(path: string): string | undefined {
  const relativePath = path.replace(/^noj-core\//, "");
  for (const module of MODULE_TEST_METADATA.targetModules) {
    const root = coreRelativeRoot(module.root);
    if (relativePath === root || relativePath.startsWith(`${root}/`)) {
      return module.name;
    }
  }
  const legacy = /^src\/domains\/([^/]+)(?:\/|$)/.exec(relativePath);
  if (legacy) {
    return MODULE_TEST_METADATA.legacyDomainToModule[legacy[1]!];
  }
  return undefined;
}

/** 路径是否是测试文件（`tests/` 目录或 `*.test.ts` / `*_test.ts`）。 */
export function isTestFilePath(path: string): boolean {
  return /(?:^|\/)tests?\//.test(path) || /(?:_test|\.test)\.ts$/.test(path);
}

/**
 * 反向依赖闭包：返回所有（直接或间接）依赖 seeds 的模块。
 *
 * @param seeds - 直接变更的模块
 * @param edges - 模块依赖图（默认使用元数据声明）
 */
export function reverseDependencyClosure(
  seeds: readonly string[],
  edges: Record<string, string[]> = MODULE_DEPENDENCIES,
): string[] {
  const reverse = new Map<string, Set<string>>();
  for (const [module, deps] of Object.entries(edges)) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(module);
    }
  }
  const result = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const dependent of reverse.get(current) ?? []) {
      if (result.has(dependent) || seeds.includes(dependent)) continue;
      result.add(dependent);
      queue.push(dependent);
    }
  }
  return [...result].sort();
}

/**
 * 极小的 glob 匹配（只支持选择器需要的 `*` 与 `**`）。
 *
 * 刻意不引入第三方依赖；行为与 paths-filter 的常用子集一致。
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
        continue;
      }
      regex += "[^/]*";
      continue;
    }
    regex += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`).test(path);
}
