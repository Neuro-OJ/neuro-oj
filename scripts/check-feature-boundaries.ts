import { join } from "node:path";
import {
  collectProductionFiles,
  findRuntimeCycles,
  importCandidates,
  type ParsedImport,
  parseImports,
  type RuntimeEdge,
} from "./check-module-boundaries.ts";

export type SourceFile = string;

export interface FeatureViolation {
  rule: string;
  file: string;
  target: string;
  hint: string;
}

export interface FeatureBoundaryReport {
  violations: FeatureViolation[];
  scannedFiles: number;
  featureCount: number;
  setupError: string | null;
}

const SOURCE_ROOT = "noj-core/src";
const FEATURE_ROOT = "features";
const SHARED_ROOT = "shared";
const MODULES_ROOT = "modules";
const FEATURE_LIST = "features.ts";

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function featureNameOf(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] !== FEATURE_ROOT || parts.length < 3) return null;
  return parts[1]!;
}

function legacyModuleOf(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] !== MODULES_ROOT || parts.length < 3) return null;
  return parts[1]!;
}

/**
 * 相对说明符 → 已知文件集内的目标文件；无法解析或非相对说明符返回 null。
 *
 * 补全规则（扩展名、`index.ts`、`.js` → `.ts`）复用 check-module-boundaries 的
 * `importCandidates`，与旧模块门禁保持一致。
 */
export function resolveSpecifier(
  sourceFile: string,
  specifier: string,
  knownFiles: Set<string>,
): SourceFile | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const stack = sourceFile.split("/");
  stack.pop();
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  for (const candidate of importCandidates(stack.join("/"))) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function isFeatureEntry(name: string): string {
  return `${FEATURE_ROOT}/${name}/index.ts`;
}

export function checkDeepCrossFeature(
  sourceFile: string,
  target: string,
): FeatureViolation | null {
  const targetFeature = featureNameOf(target);
  if (targetFeature === null) return null;
  if (featureNameOf(sourceFile) === targetFeature) return null;
  if (target === isFeatureEntry(targetFeature)) return null;
  return {
    rule: "跨功能深引用",
    file: sourceFile,
    target,
    hint:
      `请改为从 \`src/features/${targetFeature}/index.ts\` 引入，并在其中导出所需符号`,
  };
}

export function checkSharedReverseDependency(
  sourceFile: string,
  target: string,
): FeatureViolation | null {
  if (!sourceFile.startsWith(`${SHARED_ROOT}/`)) return null;
  if (!target.startsWith(`${FEATURE_ROOT}/`) && target !== FEATURE_LIST) {
    return null;
  }
  return {
    rule: "底座反向依赖",
    file: sourceFile,
    target,
    hint:
      "底座不得依赖功能，应由功能依赖底座；请在功能内完成该逻辑，或先把通用能力迁入 src/shared/",
  };
}

export function checkFeatureIntoLegacyModule(
  sourceFile: string,
  target: string,
): FeatureViolation | null {
  if (featureNameOf(sourceFile) === null) return null;
  const legacy = legacyModuleOf(target);
  if (legacy === null) return null;
  const moduleRoot = `${MODULES_ROOT}/${legacy}`;
  if (
    target === `${moduleRoot}/index.ts` ||
    target.startsWith(`${moduleRoot}/contracts/`)
  ) {
    return null;
  }
  return {
    rule: "功能深入旧模块",
    file: sourceFile,
    target,
    hint:
      `请通过旧模块的 \`src/${moduleRoot}/index.ts\` 或 \`src/${moduleRoot}/contracts/\` 引用，或先把所需能力迁入 \`src/shared/\``,
  };
}

function setupFailure(message: string): FeatureBoundaryReport {
  return {
    violations: [],
    scannedFiles: 0,
    featureCount: 0,
    setupError: message,
  };
}

export async function checkFeatureBoundaries(
  rootDir: string,
): Promise<FeatureBoundaryReport> {
  try {
    const stat = await Deno.stat(join(rootDir, SOURCE_ROOT));
    if (!stat.isDirectory) return setupFailure(`源目录不存在：${SOURCE_ROOT}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return setupFailure(`源目录不存在：${SOURCE_ROOT}`);
    }
    throw error;
  }

  // 与旧模块门禁共用生产文件发现规则（.ts/.tsx/.mts/.cts/.json，排除测试与夹具）。
  const files = await collectProductionFiles(rootDir);
  if (files.length === 0) {
    return setupFailure(
      `未扫描到任何文件（${SOURCE_ROOT} 下没有生产 TS 文件），路径可能失效`,
    );
  }

  const prefix = `${SOURCE_ROOT}/`;
  const knownFiles = new Set<string>(
    files.map((file) => file.slice(prefix.length)),
  );
  const violations: FeatureViolation[] = [];
  const runtimeEdges: RuntimeEdge[] = [];
  const featureNodes = new Set<string>();

  for (const file of files) {
    const rel = file.slice(prefix.length);
    // JSON 只作为被引用的目标存在，自身没有 import。
    if (file.endsWith(".json")) continue;
    const source = await Deno.readTextFile(join(rootDir, file));
    const imports: ParsedImport[] = parseImports(source, rel);
    for (const parsed of imports) {
      if (parsed.unresolvedDynamic) continue;
      const target = resolveSpecifier(rel, parsed.specifier, knownFiles);
      if (target === null) continue;
      for (
        const violation of [
          checkDeepCrossFeature(rel, target),
          checkSharedReverseDependency(rel, target),
          checkFeatureIntoLegacyModule(rel, target),
        ]
      ) {
        if (violation !== null) violations.push(violation);
      }
      const sourceFeature = featureNameOf(rel);
      const targetFeature = featureNameOf(target);
      if (sourceFeature !== null) featureNodes.add(sourceFeature);
      if (targetFeature !== null) featureNodes.add(targetFeature);
      if (
        parsed.typeOnly || sourceFeature === null || targetFeature === null ||
        sourceFeature === targetFeature
      ) {
        continue;
      }
      runtimeEdges.push({
        source: sourceFeature,
        target: targetFeature,
        specifier: parsed.specifier,
        kind: parsed.kind,
        sourceText: parsed.sourceText,
      });
    }
  }

  const nodes = [...featureNodes].sort();
  for (const cycle of findRuntimeCycles(nodes, runtimeEdges)) {
    const path = [...cycle, cycle[0]!].join(" -> ");
    violations.push({
      rule: "功能间循环",
      file: `${FEATURE_ROOT}/${cycle[0]}`,
      target: path,
      hint:
        `功能间运行时 import 构成环（${path}）；请把共享能力下沉到 src/shared/，或改为经对方 index.ts 的纯函数式调用`,
    });
    const edge = runtimeEdges.find((item) =>
      item.target === cycle[0] && cycle.includes(item.source)
    );
    if (edge !== undefined) {
      violations.push({
        rule: "功能间循环",
        file: `${FEATURE_ROOT}/${edge.source}`,
        target: edge.specifier,
        hint: `该 import 是环 ${path} 的一部分`,
      });
    }
  }

  return {
    violations,
    scannedFiles: files.length,
    featureCount: nodes.length,
    setupError: null,
  };
}

async function main(): Promise<number> {
  const rootArg = Deno.args.find((arg) => arg.startsWith("--root="));
  const rootDir = rootArg ? rootArg.slice("--root=".length) : ".";
  const report = await checkFeatureBoundaries(rootDir);
  if (report.setupError !== null) {
    console.error(`功能边界检查自检失败：${report.setupError}`);
    return 1;
  }
  if (report.violations.length === 0) {
    console.log(
      `功能边界检查通过：扫描 ${report.scannedFiles} 个文件 / ${report.featureCount} 个功能`,
    );
    return 0;
  }
  for (const violation of report.violations) {
    console.error(
      `[${violation.rule}] ${violation.file} -> ${violation.target}`,
    );
    console.error(`  ${violation.hint}`);
  }
  console.error(
    `功能边界检查失败：${report.violations.length} 条违规（扫描 ${report.scannedFiles} 个文件 / ${report.featureCount} 个功能）`,
  );
  return 1;
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) Deno.exit(code);
}
