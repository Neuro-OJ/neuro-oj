import {
  analyzeSources,
  type BoundaryConfig,
  findRuntimeCycles,
  loadBoundaryConfig,
  parseImports,
  validateBoundaryConfig,
  validateTestCiManifest,
} from "./check-module-boundaries.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: got ${String(actual)}`);
}

function testConfig(): BoundaryConfig {
  const names = [
    "access",
    "problems",
    "evaluations",
    "contests",
    "education",
    "communication",
    "assets",
    "platform",
    "read-models",
    "application",
    "http",
    "runtime",
  ] as const;
  const kind = (name: string) => {
    if (name === "read-models") return "read-models" as const;
    if (name === "application") return "application" as const;
    if (name === "http") return "http" as const;
    if (name === "runtime") return "runtime" as const;
    return "business" as const;
  };
  return {
    version: 1,
    coreSourceRoot: "noj-core/src",
    targetModules: names.map((name) => ({
      name,
      root: `src/modules/${name}`,
      kind: kind(name),
      legacyDomains: [],
    })),
    legacyDomainToModule: {},
    legacyTestTargets: {},
    tableOwnership: { schemaOwners: {}, tableExceptions: {} },
    testCiMapping: {},
    rules: {},
  };
}

Deno.test("parseImports 区分 type-only、混合导入、export * 和 dynamic import", () => {
  const imports = parseImports(`
    import type { User } from "./user.ts";
    import { type Id, Runtime } from "./mixed.ts";
    import { type Id } from "./only-type.ts";
    export type { User } from "./user.ts";
    export { type Id } from "./only-type.ts";
    export * from "./public.ts";
    import { type } from "./runtime-type.ts";
    import { type as alias } from "./runtime-type-alias.ts";
    import {
      type Foo,
      type Bar,
    } from "./trailing-type.ts";
    import("./lazy.ts");
    import(modulePath);
    const nested = \`\${import("./inside-template.ts")}\`;
    const regex = /import\(".\/regex-fake.ts"\)/;
    const text = "export * from './string-fake.ts'";
  `);

  assertEquals(imports.length, 12, "应解析全部静态和 dynamic import");
  assert(imports[0]!.typeOnly, "import type 必须脱离运行时图");
  assert(!imports[1]!.typeOnly, "混合具名导入仍是运行时边");
  assert(imports[2]!.typeOnly, "全是 type 的具名导入不是运行时边");
  assert(imports[3]!.typeOnly, "export type 必须脱离运行时图");
  assert(imports[4]!.typeOnly, "export { type X } 必须脱离运行时图");
  assert(
    imports[5]!.isStar && !imports[5]!.typeOnly,
    "export * 是运行时门面边",
  );
  assert(!imports[6]!.typeOnly, "名为 type 的导入绑定仍是运行时值");
  assert(!imports[7]!.typeOnly, "type as alias 导入绑定仍是运行时值");
  assert(imports[8]!.typeOnly, "带尾逗号的全 type 具名导入仍是 type-only");
  assertEquals(
    imports[9]!.specifier,
    "./lazy.ts",
    "字面量 dynamic import 应保留路径",
  );
  assert(imports[10]!.unresolvedDynamic, "变量 dynamic import 必须显式诊断");
  assertEquals(
    imports[11]!.specifier,
    "./inside-template.ts",
    "模板表达式中的 dynamic import 不能被跳过",
  );
});

Deno.test("AST 解析器不把字符串和正则字面量中的 import 当依赖", () => {
  const imports = parseImports(`
    const regex = /from ["']\.\/regex-fake\.ts["']/;
    const text = 'import("./string-fake.ts")';
    // export * from "./comment-fake.ts";
  `);
  assertEquals(imports.length, 0, "字符串、正则和注释不应产生依赖边");
});

Deno.test("findRuntimeCycles 只把真实运行时边纳入 SCC", () => {
  const nodes = ["a.ts", "b.ts", "types.ts"];
  const cycles = findRuntimeCycles(nodes, [
    {
      source: "a.ts",
      target: "b.ts",
      specifier: "./b.ts",
      kind: "import",
      sourceText: "import { b } from './b.ts'",
    },
    {
      source: "b.ts",
      target: "a.ts",
      specifier: "./a.ts",
      kind: "import",
      sourceText: "import { a } from './a.ts'",
    },
  ]);
  assertEquals(cycles.length, 1, "a/b 应形成一个运行时 SCC");
  assert(
    cycles[0]!.includes("a.ts") && cycles[0]!.includes("b.ts"),
    "SCC 成员完整",
  );
});

Deno.test("analyzeSources 覆盖 P3 结构负例：cycle、facade、方向和 HTTP actor factory", () => {
  const sources = new Map<string, string>([
    [
      "src/modules/problems/index.ts",
      `export * from "./services/write.ts";`,
    ],
    [
      "src/modules/problems/services/write.ts",
      `import { contestPolicy } from "../../contests/services/policy.ts";`,
    ],
    [
      "src/modules/contests/services/policy.ts",
      `import { problemWrite } from "../../problems/services/write.ts";`,
    ],
    [
      "src/modules/problems/services/query.ts",
      `import { read } from "../../read-models/view.ts";`,
    ],
    [
      "src/modules/read-models/view.ts",
      `export const read = true;`,
    ],
    [
      "src/modules/runtime/start.ts",
      `import { write } from "../problems/services/write.ts";`,
    ],
    [
      "src/modules/http/route.ts",
      `import { createSystemActor } from "../../runtime/system-actors.ts";`,
    ],
    [
      "src/runtime/system-actors.ts",
      `export const createSystemActor = () => {};`,
    ],
    [
      "src/shared/base/bad.ts",
      `import { write } from "../../modules/problems/services/write.ts";`,
    ],
  ]);
  const report = analyzeSources(sources, testConfig());
  const rules = new Set(report.violations.map((violation) => violation.rule));
  for (
    const rule of [
      "runtime-cycle",
      "facade-export-star",
      "shared-business-dependency",
      "business-read-model-dependency",
      "runtime-business-dependency",
      "http-system-actor-factory",
      "cross-module-service-import",
    ]
  ) {
    assert(rules.has(rule), `故意破坏的 ${rule} 必须失败`);
  }
});

Deno.test("type-only 边不会触发 runtime cycle 或跨模块运行时方向规则", () => {
  const sources = new Map<string, string>([
    [
      "src/modules/problems/a.ts",
      `import type { View } from "../read-models/view.ts";`,
    ],
    ["src/modules/read-models/view.ts", `export type View = { id: string };`],
  ]);
  const report = analyzeSources(sources, testConfig());
  assertEquals(
    report.runtimeEdges,
    0,
    "type-only import 不应成为 runtime edge",
  );
  assertEquals(
    report.runtimeCycles.length,
    0,
    "type-only import 不应成为 runtime cycle",
  );
  assert(
    !report.violations.some((violation) =>
      violation.rule === "business-read-model-dependency"
    ),
    "type-only 合同不应被误报成业务运行时依赖",
  );
});

Deno.test("业务模块不得直接导入另一业务模块的写 capability", () => {
  const report = analyzeSources(
    new Map([
      [
        "src/modules/problems/services/write.ts",
        `import { registerContestProblem } from "../../contests/services/contests.ts";`,
      ],
      [
        "src/modules/contests/services/contests.ts",
        `export const registerContestProblem = () => {};`,
      ],
    ]),
    testConfig(),
  );
  assert(
    report.violations.some((violation) =>
      violation.rule === "cross-module-service-import"
    ),
    "跨业务写 capability 的深路径导入必须由 AST 门禁拒绝",
  );
});

Deno.test("相对 import 缺失时必须报告，不能从真实依赖图静默丢失", () => {
  const sources = new Map<string, string>([
    ["src/modules/problems/read.ts", `import { missing } from "./missing.ts";`],
  ]);
  const report = analyzeSources(sources, testConfig());
  assert(
    report.violations.some((violation) =>
      violation.rule === "relative-import-unresolved"
    ),
    "缺失的相对运行时 import 应有明确诊断",
  );
});

Deno.test("module 元数据缺失目标模块时必须失败", () => {
  const config = testConfig();
  config.targetModules = config.targetModules.filter((module) =>
    module.name !== "assets"
  );
  const errors = validateBoundaryConfig(config);
  assert(
    errors.some((error) => error.includes("缺少目标模块元数据: assets")),
    "删除目标模块后应触发元数据门禁",
  );
});

Deno.test("变量 dynamic import 必须进入诊断而不是漏出依赖图", () => {
  const report = analyzeSources(
    new Map([
      ["src/modules/problems/load.ts", `const path = "./x.ts"; import(path);`],
    ]),
    testConfig(),
  );
  assertEquals(report.unresolvedDynamicImports, 1, "应统计变量 dynamic import");
  assert(
    report.violations.some((violation) =>
      violation.rule === "dynamic-import-unresolved"
    ),
    "变量 dynamic import 应有明确结构诊断",
  );
});

Deno.test("module metadata 的 test task/job 必须对应真实 manifest", async () => {
  const config = await loadBoundaryConfig(".");
  const manifestErrors = await validateTestCiManifest(".", config);
  assert(
    manifestErrors.length === 0,
    `模块测试映射必须能解析到 noj-core deno task 和现有 CI job: ${
      manifestErrors.join("; ")
    }`,
  );

  const broken = structuredClone(config);
  broken.testCiMapping.access!.testTasks = [
    "cd noj-core && deno task test:missing-module",
  ];
  const errors = await validateTestCiManifest(".", broken);
  assert(
    errors.some((error) =>
      error.includes("不存在的 deno task: test:missing-module")
    ),
    "不存在的 task 必须成为元数据负例",
  );
});
