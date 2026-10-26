/**
 * P3 模块结构诊断器。
 *
 * 这份检查和 check-domains.ts 的边界不同：它按真实文件解析运行时 import，
 * 把 `import type`、全是 `type` 的具名导入以及 `export type` 从运行时图中排除，
 * 但保留混合导入、导出门面和字面量 dynamic import。这样把一个文件改名为
 * `*.types.ts`、或把运行时代码藏进 type 文件，都不会绕过 SCC 检查。
 *
 * 默认模式是 P3 迁移期诊断，不改变现有 check-ci 的退出状态；`--strict` 才把
 * 发现的违规、缺失目标目录和元数据缺口变成非零退出。目标目录尚未全部迁移时，
 * 这个区别是有意的，避免用大白名单把遗留问题伪装成已完成。
 */
import { dirname, relative, resolve } from "node:path";
import ts from "npm:typescript@5.9.2";
import {
  BUSINESS_MODULE_NAMES,
  TARGET_MODULE_NAMES,
} from "./module-test-metadata.ts";

export type ModuleKind =
  | "business"
  | "read-models"
  | "application"
  | "http"
  | "runtime";

export interface ModuleSpec {
  name: string;
  root: string;
  kind: ModuleKind;
  legacyDomains: string[];
}

export interface TableOwnershipConfig {
  schemaOwners: Record<string, string>;
  tableExceptions: Record<string, Record<string, string>>;
}

export interface TestCiMapping {
  testTasks: string[];
  ciJobs: string[];
}

export interface BoundaryConfig {
  version: number;
  coreSourceRoot: string;
  targetModules: ModuleSpec[];
  legacyDomainToModule: Record<string, string>;
  legacyTestTargets: Record<string, string[]>;
  tableOwnership: TableOwnershipConfig;
  testCiMapping: Record<string, TestCiMapping>;
  rules: Record<string, boolean>;
}

export type ImportKind = "import" | "export" | "dynamic";

export interface ParsedImport {
  kind: ImportKind;
  specifier: string;
  typeOnly: boolean;
  isStar: boolean;
  unresolvedDynamic: boolean;
  sourceText: string;
}

export interface RuntimeEdge {
  source: string;
  target: string;
  specifier: string;
  kind: ImportKind;
  sourceText: string;
}

export interface BoundaryViolation {
  rule: string;
  file?: string;
  target?: string;
  message: string;
}

export interface BoundaryReport {
  scannedFiles: number;
  runtimeEdges: number;
  typeOnlyEdges: number;
  unresolvedDynamicImports: number;
  runtimeCycles: string[][];
  typeCycles: string[][];
  violations: BoundaryViolation[];
  metadataErrors: string[];
  missingTargetRoots: string[];
  tableCount: number;
  tableOwnershipGaps: string[];
}

const PRODUCTION_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  // JSON imported with `with { type: "json" }` is a runtime asset and must
  // remain visible in the graph even though it contains no TS imports.
  ".json",
]);
const SERVICE_PATH_PARTS = new Set([
  "services",
  "routes",
  "workers",
  "consumers",
]);

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

/**
 * 使用仓库已采用的 TypeScript Compiler API 解析静态、混合和 dynamic import。
 * 返回的 type-only 记录仍保留，供类型图单独统计；只有调用方筛掉它们时，才
 * 会进入运行时图。AST 遍历也会访问模板表达式中的 dynamic import，并天然跳过
 * 字符串、注释和正则字面量，避免手写词法扫描器的可绕过误判。
 */
export function parseImports(
  source: string,
  fileName = "check-module-boundaries.ts",
): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const allNamedBindingsTypeOnly = (
    bindings: ts.NamedImports | ts.NamedExports,
  ): boolean =>
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly);

  const literalSpecifier = (expression: ts.Expression): string | null => {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
    return null;
  };

  const addStaticImport = (
    node: ts.ImportDeclaration | ts.ExportDeclaration,
  ): void => {
    const moduleSpecifier = node.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return;

    let typeOnly = ts.isExportDeclaration(node) ? node.isTypeOnly : false;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        typeOnly = clause.isTypeOnly ||
          allNamedBindingsTypeOnly(clause.namedBindings);
      }
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      typeOnly = typeOnly || allNamedBindingsTypeOnly(node.exportClause);
    }

    imports.push({
      kind: ts.isImportDeclaration(node) ? "import" : "export",
      specifier: moduleSpecifier.text,
      typeOnly,
      isStar: ts.isExportDeclaration(node) && node.exportClause === undefined,
      unresolvedDynamic: false,
      sourceText: node.getText(sourceFile),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStaticImport(node);
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const specifier = ts.isExternalModuleReference(reference) &&
          reference.expression
        ? literalSpecifier(reference.expression)
        : null;
      if (specifier !== null) {
        imports.push({
          kind: "import",
          specifier,
          typeOnly: false,
          isStar: false,
          unresolvedDynamic: false,
          sourceText: node.getText(sourceFile),
        });
      }
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      const specifier = argument === undefined
        ? null
        : literalSpecifier(argument);
      imports.push({
        kind: "dynamic",
        specifier: specifier ?? "<dynamic>",
        typeOnly: false,
        isStar: false,
        unresolvedDynamic: specifier === null,
        sourceText: node.getText(sourceFile),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

function normalizedRelativePath(value: string): string {
  return toPosix(value).replace(/^\.\//, "");
}

function importCandidates(specifierPath: string): string[] {
  const normalized = normalizedRelativePath(specifierPath);
  const candidates = [normalized];
  const extension = normalized.match(/\.[^/.]+$/)?.[0];
  if (!extension) {
    candidates.push(
      `${normalized}.ts`,
      `${normalized}.tsx`,
      `${normalized}/index.ts`,
    );
  } else if (
    extension === ".js" || extension === ".mjs" || extension === ".cjs"
  ) {
    candidates.push(
      `${normalized.slice(0, -extension.length)}.ts`,
      `${normalized.slice(0, -extension.length)}.tsx`,
    );
  }
  return [...new Set(candidates)];
}

function resolveKnownImport(
  sourceFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = toPosix(
    relative(".", resolve(".", dirname(sourceFile), specifier)),
  );
  for (const candidate of importCandidates(base)) {
    const normalized = normalizedRelativePath(candidate);
    if (knownFiles.has(normalized)) return normalized;
  }
  return null;
}

function moduleFor(file: string, config: BoundaryConfig): string | null {
  const normalized = normalizedRelativePath(file);
  const containsSourcePath = (path: string): boolean =>
    normalized.startsWith(`${path}/`) || normalized.includes(`/${path}/`);
  if (
    containsSourcePath("src/routes") ||
    containsSourcePath("src/http") ||
    containsSourcePath("src/domains/admin") ||
    containsSourcePath("src/modules/http") ||
    normalized.endsWith("/src/app.ts") ||
    normalized === "src/app.ts"
  ) {
    return "http";
  }
  if (
    normalized.endsWith("/src/main.ts") ||
    normalized === "src/main.ts" ||
    containsSourcePath("src/runtime") ||
    containsSourcePath("src/modules/runtime")
  ) {
    return "runtime";
  }
  if (containsSourcePath("src/shared")) return "shared";

  for (const module of config.targetModules) {
    const root = normalizedRelativePath(module.root);
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return module.name;
    }
  }

  const domain = normalized.match(/\/src\/(?:domains|services)\/([^/]+)/)?.[1];
  if (domain) return config.legacyDomainToModule[domain] ?? null;
  return null;
}

function kindFor(
  moduleName: string | null,
  config: BoundaryConfig,
): ModuleKind | "shared" | null {
  if (!moduleName) return null;
  if (moduleName === "shared") return "shared";
  return config.targetModules.find((module) => module.name === moduleName)
    ?.kind ?? null;
}

function isFacade(file: string): boolean {
  const normalized = normalizedRelativePath(file);
  return normalized.endsWith("/index.ts") &&
    (normalized.includes("/src/modules/") ||
      normalized.startsWith("src/modules/") ||
      normalized.includes("/src/domains/") ||
      normalized.startsWith("src/domains/"));
}

function hasServicePath(file: string): boolean {
  return normalizedRelativePath(file).split("/").some((part) =>
    SERVICE_PATH_PARTS.has(part)
  );
}

function addViolation(
  violations: BoundaryViolation[],
  rule: string,
  message: string,
  file?: string,
  target?: string,
): void {
  violations.push({ rule, file, target, message });
}

function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(node: string): void {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(target)!),
        );
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let popped: string | undefined;
    do {
      popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== node);
    components.push(component.sort());
  }

  for (const node of nodes) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

export function findRuntimeCycles(
  nodes: string[],
  edges: RuntimeEdge[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node, new Set());
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
  }
  return stronglyConnectedComponents(nodes, adjacency).filter((component) => {
    if (component.length > 1) return true;
    return adjacency.get(component[0]!)?.has(component[0]!) ?? false;
  });
}

function emptyReport(scannedFiles: number): BoundaryReport {
  return {
    scannedFiles,
    runtimeEdges: 0,
    typeOnlyEdges: 0,
    unresolvedDynamicImports: 0,
    runtimeCycles: [],
    typeCycles: [],
    violations: [],
    metadataErrors: [],
    missingTargetRoots: [],
    tableCount: 0,
    tableOwnershipGaps: [],
  };
}

/**
 * 对一组仓库相对路径源码做纯逻辑分析。测试可用它构造最小夹具，而不需要
 * 连接数据库或搬动真实文件；生产入口 analyzeRoot() 会提供完整 Core 源码。
 */
export function analyzeSources(
  sources: ReadonlyMap<string, string>,
  config: BoundaryConfig,
): BoundaryReport {
  const normalizedSources = new Map<string, string>();
  for (const [file, source] of sources) {
    normalizedSources.set(normalizedRelativePath(file), source);
  }
  const files = [...normalizedSources.keys()].sort();
  const knownFiles = new Set(files);
  const report = emptyReport(files.length);
  const runtimeEdges: RuntimeEdge[] = [];
  const typeEdges: RuntimeEdge[] = [];

  for (const file of files) {
    const source = normalizedSources.get(file) ?? "";
    const sourceModule = moduleFor(file, config);
    const sourceKind = kindFor(sourceModule, config);
    for (const parsed of parseImports(source, file)) {
      if (parsed.unresolvedDynamic) {
        report.unresolvedDynamicImports++;
        addViolation(
          report.violations,
          "dynamic-import-unresolved",
          "dynamic import 必须使用可解析的字面量；变量路径无法进入真实运行时依赖图",
          file,
        );
        continue;
      }
      if (parsed.typeOnly) {
        report.typeOnlyEdges++;
      }
      const target = resolveKnownImport(file, parsed.specifier, knownFiles);
      if (!target) {
        if (
          parsed.specifier.startsWith("./") ||
          parsed.specifier.startsWith("../")
        ) {
          addViolation(
            report.violations,
            "relative-import-unresolved",
            "相对 import 未解析到被扫描的生产 TypeScript 文件，不能从依赖图中静默丢失",
            file,
          );
        }
        continue;
      }
      const edge: RuntimeEdge = {
        source: file,
        target,
        specifier: parsed.specifier,
        kind: parsed.kind,
        sourceText: parsed.sourceText,
      };
      if (parsed.typeOnly) {
        typeEdges.push(edge);
        continue;
      }
      runtimeEdges.push(edge);

      const targetModule = moduleFor(target, config);
      const targetKind = kindFor(targetModule, config);

      if (isFacade(file) && parsed.kind === "export" && parsed.isStar) {
        addViolation(
          report.violations,
          "facade-export-star",
          "生产公共门面不得整体 export *，必须显式列出公开合同",
          file,
          target,
        );
      }

      if (
        sourceModule === "http" &&
        (target.endsWith("/src/runtime/system-actors.ts") ||
          target === "src/runtime/system-actors.ts" ||
          target.endsWith("/src/modules/runtime/system-actors.ts") ||
          target === "src/modules/runtime/system-actors.ts")
      ) {
        addViolation(
          report.violations,
          "http-system-actor-factory",
          "HTTP 层不得导入 system actor factory；系统身份只能在 runtime/application composition 创建",
          file,
          target,
        );
      }

      if (sourceKind === "runtime" && targetKind === "business") {
        addViolation(
          report.violations,
          "runtime-business-dependency",
          "runtime 不得反向依赖业务模块；请通过显式 composition descriptor 注入能力",
          file,
          target,
        );
      }

      if (sourceKind === "shared" && targetKind === "business") {
        addViolation(
          report.violations,
          "shared-business-dependency",
          "shared 基础设施不得反向依赖业务模块；业务能力应由 application/runtime 显式组合",
          file,
          target,
        );
      }

      if (sourceKind === "business" && targetKind === "read-models") {
        addViolation(
          report.violations,
          "business-read-model-dependency",
          "业务模块不得反向依赖 read-models；查询聚合应在 read-models/application 组合",
          file,
          target,
        );
      }

      if (
        sourceKind === "business" &&
        targetKind === "business" &&
        sourceModule !== targetModule &&
        hasServicePath(target)
      ) {
        addViolation(
          report.violations,
          "cross-module-service-import",
          "检测到跨业务模块深路径服务/路由/worker 导入；这是写侵入的语法边界诊断，不声称能证明函数语义",
          file,
          target,
        );
      }
    }
  }

  report.runtimeEdges = runtimeEdges.length;
  report.runtimeCycles = findRuntimeCycles(files, runtimeEdges);
  report.typeCycles = findRuntimeCycles(files, typeEdges);
  for (const cycle of report.runtimeCycles) {
    addViolation(
      report.violations,
      "runtime-cycle",
      `运行时 import SCC：${cycle.join(" -> ")}`,
      cycle[0],
    );
  }
  return report;
}

export function validateBoundaryConfig(config: BoundaryConfig): string[] {
  const errors: string[] = [];
  if (config.version !== 1) {
    errors.push(`不支持的 module-boundaries version: ${config.version}`);
  }
  const modules = config.targetModules ?? [];
  const names = modules.map((module) => module.name);
  const nameSet = new Set(names);
  for (const required of TARGET_MODULE_NAMES) {
    if (!nameSet.has(required)) errors.push(`缺少目标模块元数据: ${required}`);
  }
  if (nameSet.size !== names.length) errors.push("targetModules 含重复模块名");
  const roots = modules.map((module) => normalizedRelativePath(module.root));
  if (new Set(roots).size !== roots.length) {
    errors.push("targetModules 含重复 root");
  }
  for (const module of modules) {
    if (
      !module.name || !module.root || !module.kind ||
      !Array.isArray(module.legacyDomains)
    ) {
      errors.push(`目标模块字段不完整: ${module.name || "<unknown>"}`);
    }
    if (
      module.kind === "business" &&
      !BUSINESS_MODULE_NAMES.includes(module.name)
    ) {
      errors.push(`未知业务模块: ${module.name}`);
    }
    for (const legacyDomain of module.legacyDomains) {
      if (config.legacyDomainToModule[legacyDomain] !== module.name) {
        errors.push(
          `模块 ${module.name} 的 legacyDomains 与映射不一致: ${legacyDomain}`,
        );
      }
    }
  }
  for (
    const [legacy, target] of Object.entries(config.legacyDomainToModule ?? {})
  ) {
    if (!nameSet.has(target)) {
      errors.push(`legacy 域 ${legacy} 指向未知模块 ${target}`);
      continue;
    }
    const module = modules.find((entry) => entry.name === target);
    if (!module?.legacyDomains.includes(legacy)) {
      errors.push(
        `legacy 域 ${legacy} 未在模块 ${target}.legacyDomains 中登记`,
      );
    }
  }
  for (
    const [legacy, targets] of Object.entries(config.legacyTestTargets ?? {})
  ) {
    if (!Array.isArray(targets) || targets.length === 0) {
      errors.push(`legacy 测试目标 ${legacy} 必须至少包含一个模块`);
      continue;
    }
    for (const target of targets) {
      if (!nameSet.has(target)) {
        errors.push(`legacy 测试目标 ${legacy} 指向未知模块 ${target}`);
      }
    }
  }
  const ownership = config.tableOwnership ??
    { schemaOwners: {}, tableExceptions: {} };
  for (const [file, owner] of Object.entries(ownership.schemaOwners ?? {})) {
    if (!nameSet.has(owner)) {
      errors.push(`schema ${file} 指向未知表所有权模块 ${owner}`);
    }
  }
  for (
    const [file, tables] of Object.entries(ownership.tableExceptions ?? {})
  ) {
    for (const [table, owner] of Object.entries(tables)) {
      if (!nameSet.has(owner)) {
        errors.push(
          `表 ${file}:${table} 指向未知表所有权模块 ${owner}`,
        );
      }
    }
  }
  const mapping = config.testCiMapping ?? {};
  for (const required of TARGET_MODULE_NAMES) {
    const entry = mapping[required];
    if (!entry?.testTasks?.length || !entry.ciJobs?.length) {
      errors.push(`模块 ${required} 缺少正式 test/CI 映射`);
    }
  }
  return errors;
}

function workflowJobNames(text: string): Set<string> {
  const jobs = new Set<string>();
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      if (line.trim() === "" || line.startsWith("#")) continue;
      break;
    }
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) jobs.add(match[1]!);
  }
  return jobs;
}

function taskReference(command: string): { cwd: string; task: string } | null {
  const match = /^\s*cd\s+([^&\s]+)\s+&&\s+deno\s+task\s+([^\s]+)/.exec(
    command,
  );
  if (!match) return null;
  return { cwd: match[1]!, task: match[2]! };
}

/**
 * 校验 module-boundaries.json 中的 task/job manifest 是可执行的实际入口。
 * 这里消费现有 `noj-core/deno.json` 与 `ci.yml`，不另维护一份模块映射；
 * 缺少 task/job 时迁移期诊断也必须明确报告，避免元数据只停留在文档层。
 */
export async function validateTestCiManifest(
  root = ".",
  config?: BoundaryConfig,
): Promise<string[]> {
  const errors: string[] = [];
  const boundaryConfig = config ?? await loadBoundaryConfig(root);
  let tasks: Set<string>;
  try {
    const denoConfig = JSON.parse(
      await Deno.readTextFile(resolve(root, "noj-core/deno.json")),
    ) as { tasks?: Record<string, unknown> };
    tasks = new Set(Object.keys(denoConfig.tasks ?? {}));
  } catch (error) {
    errors.push(
      `无法读取 noj-core/deno.json 以校验测试 task: ${String(error)}`,
    );
    tasks = new Set();
  }

  let jobs = new Set<string>();
  try {
    jobs = workflowJobNames(
      await Deno.readTextFile(resolve(root, ".github/workflows/ci.yml")),
    );
  } catch (error) {
    errors.push(
      `无法读取 .github/workflows/ci.yml 以校验 CI job: ${String(error)}`,
    );
  }

  for (const module of TARGET_MODULE_NAMES) {
    const mapping = boundaryConfig.testCiMapping?.[module];
    if (!mapping) continue;
    for (const command of mapping.testTasks ?? []) {
      const reference = taskReference(command);
      if (!reference) {
        errors.push(
          `模块 ${module} 的 test task 不是可解析的 noj-core task: ${command}`,
        );
        continue;
      }
      if (reference.cwd !== "noj-core") {
        errors.push(
          `模块 ${module} 的 test task 必须在 noj-core 执行: ${command}`,
        );
      }
      if (!tasks.has(reference.task)) {
        errors.push(
          `模块 ${module} 引用了不存在的 deno task: ${reference.task}`,
        );
      }
    }
    for (const job of mapping.ciJobs ?? []) {
      if (!jobs.has(job)) {
        errors.push(`模块 ${module} 引用了不存在的 CI job: ${job}`);
      }
    }
  }
  return errors;
}

async function collectProductionFiles(root: string): Promise<string[]> {
  const sourceRoot = resolve(root, "noj-core/src");
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name === "node_modules" || entry.name === ".deno_cache") {
        continue;
      }
      const full = resolve(directory, entry.name);
      if (entry.isDirectory) {
        await walk(full);
        continue;
      }
      if (!entry.isFile) continue;
      const extension = entry.name.match(/\.[^.]+$/)?.[0] ?? "";
      if (!PRODUCTION_FILE_EXTENSIONS.has(extension)) continue;
      if (
        /(?:^|\/)(?:tests?|fixtures)(?:\/|$)/.test(toPosix(full)) ||
        /(?:\.test|_test|\.spec)\.[mc]?tsx?$/.test(entry.name)
      ) continue;
      files.push(normalizedRelativePath(relative(resolve(root), full)));
    }
  }
  try {
    await walk(sourceRoot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return files.sort();
}

function tableNames(source: string): string[] {
  const names: string[] = [];
  const pattern =
    /export\s+const\s+[A-Za-z0-9_$]+\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

async function inspectTableOwnership(
  root: string,
  config: BoundaryConfig,
): Promise<{ tableCount: number; gaps: string[] }> {
  const directory = resolve(root, "noj-core/src/shared/db/schema");
  const gaps: string[] = [];
  let count = 0;
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (
        !entry.isFile || !entry.name.endsWith(".ts") ||
        entry.name === "index.ts"
      ) continue;
      const path = resolve(directory, entry.name);
      const source = await Deno.readTextFile(path);
      for (const table of tableNames(source)) {
        count++;
        const owner =
          config.tableOwnership.tableExceptions[entry.name]?.[table] ??
            config.tableOwnership.schemaOwners[entry.name];
        if (!owner) gaps.push(`${entry.name}:${table}`);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      gaps.push("noj-core/src/shared/db/schema: directory missing");
    } else {
      throw error;
    }
  }
  return { tableCount: count, gaps };
}

export async function loadBoundaryConfig(root = "."): Promise<BoundaryConfig> {
  const path = resolve(root, "dev-docs/engineering/module-boundaries.json");
  const raw = JSON.parse(await Deno.readTextFile(path)) as BoundaryConfig;
  return raw;
}

export async function analyzeRoot(root = "."): Promise<BoundaryReport> {
  const config = await loadBoundaryConfig(root);
  const files = await collectProductionFiles(root);
  const sources = new Map<string, string>();
  for (const file of files) {
    sources.set(file, await Deno.readTextFile(resolve(root, file)));
  }
  const report = analyzeSources(sources, config);
  report.metadataErrors.push(...validateBoundaryConfig(config));
  report.metadataErrors.push(...await validateTestCiManifest(root, config));
  const ownership = await inspectTableOwnership(root, config);
  report.tableCount = ownership.tableCount;
  report.tableOwnershipGaps.push(...ownership.gaps);

  for (const module of config.targetModules) {
    try {
      const stat = await Deno.stat(resolve(root, module.root));
      if (!stat.isDirectory) report.missingTargetRoots.push(module.root);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        report.missingTargetRoots.push(module.root);
      } else throw error;
    }
  }
  return report;
}

function strictFailure(report: BoundaryReport): boolean {
  return report.violations.length > 0 ||
    report.metadataErrors.length > 0 ||
    report.missingTargetRoots.length > 0 ||
    report.tableOwnershipGaps.length > 0;
}

function printReport(report: BoundaryReport): void {
  console.log(
    `P3 module boundary diagnostic: ${report.scannedFiles} production files`,
  );
  console.log(
    `runtime edges=${report.runtimeEdges}, type-only edges=${report.typeOnlyEdges}, ` +
      `runtime SCC=${report.runtimeCycles.length}, type SCC=${report.typeCycles.length}`,
  );
  console.log(
    `dynamic unresolved=${report.unresolvedDynamicImports}, tables=${report.tableCount}, ` +
      `table ownership gaps=${report.tableOwnershipGaps.length}, ` +
      `target roots missing=${report.missingTargetRoots.length}`,
  );
  const counts = new Map<string, number>();
  for (const violation of report.violations) {
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  }
  if (counts.size > 0) {
    console.log("violations by rule:");
    for (const [rule, count] of [...counts.entries()].sort()) {
      console.log(`  ${rule}: ${count}`);
    }
  }
  if (report.metadataErrors.length > 0) {
    console.log("metadata errors:");
    for (const error of report.metadataErrors) console.log(`  ${error}`);
  }
  if (report.tableOwnershipGaps.length > 0) {
    console.log("table ownership gaps:");
    for (const gap of report.tableOwnershipGaps) console.log(`  ${gap}`);
  }
  if (report.missingTargetRoots.length > 0) {
    console.log("target module roots not migrated yet:");
    for (const path of report.missingTargetRoots) console.log(`  ${path}`);
  }
  const sample = report.violations.slice(0, 20);
  if (sample.length > 0) {
    console.log("first diagnostic findings:");
    for (const violation of sample) {
      const location = violation.file
        ? `${violation.file}${
          violation.target ? ` -> ${violation.target}` : ""
        }`
        : "<metadata>";
      console.log(`  [${violation.rule}] ${location}: ${violation.message}`);
    }
    if (report.violations.length > sample.length) {
      console.log(`  ... ${report.violations.length - sample.length} more`);
    }
  }
}

if (import.meta.main) {
  const strict = Deno.args.includes("--strict");
  const json = Deno.args.includes("--json");
  const rootArg = Deno.args.find((arg) => arg.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : ".";
  const report = await analyzeRoot(root);
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (strict && strictFailure(report)) Deno.exit(1);
}
