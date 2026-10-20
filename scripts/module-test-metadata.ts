/**
 * Core 测试发现与 CI 映射的单一元数据读取点。
 *
 * `dev-docs/engineering/module-boundaries.json` 是唯一事实源：目标模块、迁移期
 * legacy domain 别名、测试 task 和 CI job 都从那里读取。Core 的测试启动器通过
 * 本模块取得同一份值，因此新增模块测试目录不会只被静态结构诊断发现，而在
 * `test:domain` / 并行分片中静默漏跑。
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

/** 解析目标模块名或迁移期 legacy domain 别名。 */
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
 * 返回迁移期目标的测试根：legacy 与 modules/** 同时保留，且去重。
 * 不在磁盘上的根由 launcher 在执行前过滤，这样空的未来模块不会阻止仍在
 * legacy 目录中的测试运行；一旦模块测试目录创建，就会自动进入同一 task。
 */
export function testRootsForTarget(targetOrLegacy: string): string[] {
  const target = resolveModuleTestTarget(targetOrLegacy);
  if (!target) return [];
  const roots = [
    ...target.legacyDomains.map((domain) => `src/domains/${domain}/tests`),
    `${coreRelativeRoot(target.root)}/tests`,
  ];
  return [...new Set(roots)];
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
  return MODULE_TEST_METADATA.targetModules.map((module) =>
    `${coreRelativeRoot(module.root)}/tests`
  );
}
