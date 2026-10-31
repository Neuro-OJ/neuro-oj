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

export interface ModuleTestMetadata {
  targetModules: ModuleTestTarget[];
  legacyDomainToModule: Record<string, string>;
  legacyTestTargets: Record<string, string[]>;
  testCiMapping: Record<string, ModuleTestMapping>;
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

function coreRelativeRoot(root: string): string {
  return root.replace(/^noj-core\//, "");
}

/** 一个业务模块可以由多个明确的子模块组成；测试发现必须覆盖所有子根。 */
function targetTestRoots(module: ModuleTestTarget): string[] {
  const root = coreRelativeRoot(module.root);
  const nested = module.name === "access"
    ? ["identity", "workspace"].map((part) => `${root}/${part}/tests`)
    : module.name === "communication"
    ? ["community", "messaging", "review"].map((part) =>
      `${root}/${part}/tests`
    )
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
