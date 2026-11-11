/**
 * CI 影响范围选择器回归（P5-B）。
 *
 * 这些用例以**真实文件集合**审查选择结果，而不是断言 job 名字符串：
 * 1. 每个目标模块的变更都能落到正确模块、反向依赖闭包与 E2E 域；
 * 2. 新增/删除/重命名（含迁移前 `src/domains/*` 旧路径）都参与分类；
 * 3. shared/迁移/启动器/锁文件/未知路径扩大到全量，绝不输出空选择；
 * 4. 元数据里的 E2E 域与 `noj-tests/e2e` 磁盘目录一致，依赖图没有幻影边；
 * 5. workflow 结构：Core 回归只由完整分片执行，不再有重复 legacy domain job。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type ChangedPath,
  classifyChangedPath,
  parseNameStatusRecords,
  runSelector,
  selectFromPaths,
} from "./select-core-ci.ts";
import {
  CI_SELECTION,
  E2E_API_DOMAINS,
  E2E_CI_MAPPING,
  LEGACY_DOMAIN_NAMES,
  MODULE_DEPENDENCIES,
  moduleForCorePath,
  reverseDependencyClosure,
  TARGET_MODULE_NAMES,
  testRootsForTarget,
} from "./module-test-metadata.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const CI_TEXT = Deno.readTextFileSync(`${ROOT}/.github/workflows/ci.yml`);
const E2E_TEXT = Deno.readTextFileSync(`${ROOT}/.github/workflows/e2e.yml`);

function changed(path: string): ChangedPath[] {
  return [{ path, status: "modified" }];
}

function jobBlocks(workflow: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const start = workflow.indexOf("\njobs:\n");
  assert(start >= 0, "workflow 必须有 jobs 段");
  const lines = workflow.slice(start + 1).split("\n");
  let current: string | undefined;
  let buffer: string[] = [];
  for (const line of lines) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      if (current) jobs.set(current, buffer.join("\n"));
      current = match[1]!;
      buffer = [line];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) jobs.set(current, buffer.join("\n"));
  return jobs;
}

Deno.test("选择器: 路径分类覆盖迁移后模块、测试文件与共享路径", () => {
  const cases: Array<
    [
      string,
      string,
      Partial<{ module: string; testOnly: boolean; domain: string }>,
    ]
  > = [
    [
      "noj-core/src/modules/access/identity/services/auth.ts",
      "core-module",
      { module: "access", testOnly: false },
    ],
    [
      "noj-core/src/modules/access/identity/tests/lib/jwt.test.ts",
      "core-module",
      { module: "access", testOnly: true },
    ],
    ["noj-core/src/shared/db/schema/identity.ts", "core-full", {}],
    ["noj-core/scripts/test-launcher.ts", "core-full", {}],
    ["noj-core/drizzle/0001_init.sql", "core-full", {}],
    ["dev-docs/engineering/module-boundaries.json", "core-full", {}],
    ["dev-docs/engineering/test-duration-baseline.json", "core-full", {}],
    ["scripts/select-core-ci.ts", "global", {}],
    [".github/workflows/ci.yml", "global", {}],
    ["noj-tests/e2e/catalog/import_bundle.test.ts", "e2e-domain", {
      domain: "catalog",
    }],
    ["noj-tests/e2e/browser/ui_flows.test.ts", "browser", {}],
    ["noj-tests/e2e/cross-domain/pipeline.test.ts", "cross-domain", {}],
    ["noj-tests/fixtures/wait.ts", "e2e-infra", {}],
    ["noj-tests/e2e/helper.ts", "e2e-infra", {}],
    ["noj-tests/deno.lock", "e2e-infra", {}],
    ["noj-tests/tests/unit/problem-bundle.test.ts", "logic-only", {}],
    ["noj-ui/pages/problems.vue", "browser", {}],
    ["noj-judge/src/main.rs", "e2e-infra", {}],
    ["dev-docs/engineering/testing.md", "docs", {}],
    ["noj-core/AGENTS.md", "docs", {}],
    ["noj-cli/src/main.ts", "ignored", {}],
    ["noj-core/src/modules/unknown/new-file.ts", "unknown", {}],
    // 功能切片（refactor-core-feature-slices 2.5）：一律归为全量 Core。
    ["noj-core/src/features/demo/service.ts", "core-full", {}],
    ["noj-core/src/features/demo/demo.test.ts", "core-full", {}],
    ["noj-core/src/features.ts", "core-full", {}],
    ["noj-core/src/shared/feature.ts", "core-full", {}],
    ["noj-core/src/features", "core-full", {}],
  ];
  for (const [path, kind, extra] of cases) {
    const classification = classifyChangedPath(path);
    assertEquals(classification.kind, kind, `${path} 分类错误`);
    if (extra.module) assertEquals(classification.module, extra.module);
    if (extra.testOnly !== undefined) {
      assertEquals(classification.testOnly, extra.testOnly);
    }
    if (extra.domain) assertEquals(classification.domain, extra.domain);
  }
});

Deno.test("选择器: 每个 legacy 域都能解析到目标模块（含旧 src/domains 路径）", () => {
  for (const legacy of LEGACY_DOMAIN_NAMES) {
    const path = `noj-core/src/domains/${legacy}/services/sample.ts`;
    const module = moduleForCorePath(path);
    assert(module, `legacy 域 ${legacy} 必须能映射到目标模块`);
    assertEquals(classifyChangedPath(path).kind, "core-module");
    assertEquals(classifyChangedPath(path).module, module);
  }
});

Deno.test("选择器: 生产模块变更带反向闭包、Browser 与 cross-domain", () => {
  const selection = selectFromPaths(changed(
    "noj-core/src/modules/access/identity/services/auth.ts",
  ));
  assertEquals(selection.coreFull, false);
  assertEquals(selection.directModules, ["access"]);
  assert(
    selection.modules.includes("access") &&
      selection.modules.length > 1,
    `生产变更必须包含反向依赖闭包：${selection.modules.join(",")}`,
  );
  assert(
    selection.modules.includes("http"),
    "http 组合层依赖 access，必须被选中",
  );
  assertEquals(selection.contracts, [
    "cd noj-core && deno task test:logic",
    "cd noj-core && deno task check:contracts",
  ]);
  for (const domain of ["identity", "admin", "rate-limit"]) {
    assert(
      selection.e2e.domains.includes(domain),
      `access 变更必须选择 ${domain} E2E`,
    );
  }
  assert(selection.e2e.browser, "生产模块变更附加 Browser");
  assert(selection.e2e.crossDomain, "生产模块变更附加 cross-domain");
  assertEquals(selection.e2e.allApi, false, "单模块变更不应升级为全部 API E2E");
});

Deno.test("选择器: 测试文件变更只跑所属模块测试，不触发 E2E", () => {
  const selection = selectFromPaths(changed(
    "noj-core/src/modules/access/identity/tests/lib/jwt.test.ts",
  ));
  assertEquals(selection.coreFull, false);
  assertEquals(selection.directModules, ["access"]);
  assertEquals(selection.modules, ["access"], "测试文件变更不展开反向依赖");
  assertEquals(selection.e2e.domains, []);
  assertEquals(selection.e2e.browser, false);
  assertEquals(selection.e2e.crossDomain, false);
  assert(selection.contracts.length > 0, "固定契约检查必须保留");
});

Deno.test("选择器: shared/迁移/启动器/模块映射 → 全量 Core + 全量 E2E", () => {
  for (
    const path of [
      "noj-core/src/shared/db/schema/identity.ts",
      "noj-core/drizzle/0123_migration.sql",
      "noj-core/scripts/test-launcher.ts",
      "dev-docs/engineering/module-boundaries.json",
    ]
  ) {
    const selection = selectFromPaths(changed(path));
    assertEquals(selection.coreFull, true, `${path} 必须触发全量 Core`);
    assertEquals(selection.e2e.allApi, true, `${path} 必须触发全部 API E2E`);
    assertEquals(
      selection.e2e.domains,
      [...E2E_API_DOMAINS, "cross-domain", "browser"],
      `${path} 的 E2E 选择应覆盖全部域`,
    );
  }
});

Deno.test("选择器: 功能切片改动触发全量 Core 回归", () => {
  for (
    const path of [
      "noj-core/src/features/demo/service.ts",
      "noj-core/src/features/demo/demo.test.ts",
      "noj-core/src/features.ts",
      "noj-core/src/shared/feature.ts",
    ]
  ) {
    const selection = selectFromPaths(changed(path));
    assertEquals(selection.coreFull, true, `${path} 必须触发全量 Core`);
    assert(
      selection.reasons.some((reason) => reason.includes("全量 Core")),
      `${path} 必须写明全量 Core 的原因`,
    );
    assertEquals(selection.e2e.allApi, true, `${path} 必须触发全部 API E2E`);
  }
});

Deno.test("选择器: 未知 Core 路径扩大到全量并写明原因", () => {
  const selection = selectFromPaths(changed(
    "noj-core/src/modules/not-registered/service.ts",
  ));
  assertEquals(selection.coreFull, true);
  assertEquals(selection.e2e.allApi, true);
  assert(
    selection.reasons.some((reason) => reason.includes("无法归属")),
    "未知路径必须说明扩大原因",
  );
});

Deno.test("选择器: 文档变更不触发测试，但也不会输出未解释的空选择", () => {
  const selection = selectFromPaths(changed("dev-docs/engineering/testing.md"));
  assertEquals(selection.coreFull, false);
  assertEquals(selection.modules, []);
  assertEquals(selection.e2e.domains, []);
  assertEquals(selection.contracts, []);
  assert(
    selection.reasons.some((reason) => reason.includes("文档")),
    "文档变更必须记录理由",
  );
});

Deno.test("选择器: 新增/删除/重命名前后路径都参与分类", () => {
  const rename: ChangedPath = {
    path: "noj-core/src/modules/http/admin/routes/audit.ts",
    previousPath: "noj-core/src/domains/admin/routes/audit.ts",
    status: "renamed",
  };
  const selection = selectFromPaths([rename]);
  assertEquals(selection.directModules, ["http"]);

  const deleted: ChangedPath = {
    path: "noj-core/src/domains/workspace/services/invite.ts",
    status: "deleted",
  };
  assertEquals(selectFromPaths([deleted]).directModules, ["access"]);

  const added: ChangedPath = {
    path: "noj-core/src/modules/problems/catalog/services/new.ts",
    status: "added",
  };
  assertEquals(selectFromPaths([added]).directModules, ["problems"]);
});

Deno.test("选择器: base 依赖图与 head 合并，PR 删除依赖也不漏选", () => {
  // assets 生产变更；base 里 contests 依赖 assets（head 已删除该边）。
  const selection = selectFromPaths(
    changed("noj-core/src/modules/assets/services/storage.ts"),
    {
      baseDependencies: {
        ...MODULE_DEPENDENCIES,
        contests: [...MODULE_DEPENDENCIES.contests!, "assets"],
      },
    },
  );
  assert(
    selection.modules.includes("contests"),
    "base 依赖必须参与反向闭包",
  );
});

Deno.test("选择器: 解析 git name-status（A/M/D/R）记录", () => {
  const output = [
    "A",
    "noj-core/src/modules/problems/new.ts",
    "M",
    "noj-core/src/modules/access/auth.ts",
    "D",
    "noj-core/src/domains/workspace/old.ts",
    "R092",
    "noj-core/src/domains/admin/routes/a.ts",
    "noj-core/src/modules/http/admin/routes/a.ts",
    "",
  ].join("\0");
  const changes = parseNameStatusRecords(output);
  assertEquals(changes.length, 4);
  assertEquals(changes[0], {
    path: "noj-core/src/modules/problems/new.ts",
    status: "added",
  });
  assertEquals(changes[2], {
    path: "noj-core/src/domains/workspace/old.ts",
    status: "deleted",
  });
  assertEquals(changes[3], {
    path: "noj-core/src/modules/http/admin/routes/a.ts",
    previousPath: "noj-core/src/domains/admin/routes/a.ts",
    status: "renamed",
  });
  const selection = selectFromPaths(changes);
  assertEquals(selection.directModules.sort(), ["access", "http", "problems"]);
});

Deno.test("选择器: CLI 在 main push 时输出全量，在 git 失败时也输出全量", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-selector-" });
  try {
    const mainOutput = `${dir}/main.out`;
    await runSelector([
      "--event",
      "push",
      "--ref",
      "refs/heads/main",
      "--output",
      mainOutput,
    ], {});
    const mainText = await Deno.readTextFile(mainOutput);
    assert(mainText.includes("core-full=true"));
    assert(
      mainText.includes(
        `e2e-domains=${
          JSON.stringify([...E2E_API_DOMAINS, "cross-domain", "browser"])
        }`,
      ),
    );

    const failedOutput = `${dir}/failed.out`;
    await runSelector([
      "--base",
      "0000000000000000000000000000000000000000",
      "--head",
      "1111111111111111111111111111111111111111",
      "--output",
      failedOutput,
    ], {});
    const failedText = await Deno.readTextFile(failedOutput);
    assert(failedText.includes("core-full=true"), "git 解析失败必须扩大为全量");
    assert(
      failedText.includes("按全量处理"),
      "必须写明扩大原因",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("选择器: E2E 元数据与 noj-tests/e2e 磁盘目录一致", async () => {
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}/noj-tests/e2e`)) {
    if (entry.isDirectory) onDisk.push(entry.name);
  }
  const skip = new Set([
    "browser",
    "cross-domain",
    "support-package",
    "staging",
  ]);
  assertEquals(
    [...E2E_API_DOMAINS].sort(),
    onDisk.filter((name) => !skip.has(name)).sort(),
    "e2eApiDomains 必须与磁盘目录一致",
  );
  for (const [module, mapping] of Object.entries(E2E_CI_MAPPING)) {
    assert(
      TARGET_MODULE_NAMES.includes(module),
      `E2E 映射引用未知模块：${module}`,
    );
    for (const domain of mapping.domains ?? []) {
      assert(
        E2E_API_DOMAINS.includes(domain),
        `${module} 映射了不存在的 E2E 域：${domain}`,
      );
    }
    if (mapping.allApiDomains) {
      assertEquals(mapping.domains ?? [], [], "allApiDomains 不需要再列域名");
    }
  }
  for (const module of TARGET_MODULE_NAMES) {
    assert(module in E2E_CI_MAPPING, `模块 ${module} 缺少 E2E 映射`);
  }
});

Deno.test("选择器: 声明的模块依赖无幻影边，且能覆盖迁移前旧目录", () => {
  const modules = new Set(TARGET_MODULE_NAMES);
  for (const [module, deps] of Object.entries(MODULE_DEPENDENCIES)) {
    assert(modules.has(module), `依赖图含未知模块：${module}`);
    for (const dep of deps) {
      assert(modules.has(dep), `${module} 依赖未知模块 ${dep}`);
      assert(dep !== module, `${module} 不应依赖自身`);
    }
  }
  // 反向闭包自洽：access 的所有依赖方都在闭包里。
  const closure = reverseDependencyClosure(["access"]);
  for (const [module, deps] of Object.entries(MODULE_DEPENDENCIES)) {
    if (deps.includes("access") && module !== "access") {
      assert(closure.includes(module), `反向闭包漏掉依赖方 ${module}`);
    }
  }
  for (const module of TARGET_MODULE_NAMES) {
    assert(
      testRootsForTarget(module).length > 0,
      `模块 ${module} 必须有测试根`,
    );
  }
});

Deno.test("workflow: Core 回归只由完整分片执行，没有重复 legacy domain job", () => {
  const jobs = jobBlocks(CI_TEXT);
  assert(jobs.has("core-test-sharded"), "ci.yml 必须保留完整分片 job");
  const sharded = jobs.get("core-test-sharded")!;
  assert(
    sharded.includes("deno task test:parallel --shards 4 --jobs 2"),
    "完整分片必须以 4 片 2 并发执行全部 Core 测试",
  );
  for (const legacy of LEGACY_DOMAIN_NAMES) {
    assert(
      !jobs.has(`core-${legacy}`),
      `ci.yml 不得保留重复的 core-${legacy} legacy job`,
    );
  }
  assert(
    !CI_TEXT.includes("scripts/test-domain.sh"),
    "CI 中不得再次用 test-domain.sh 重复执行分片已覆盖的测试",
  );
  assert(
    !CI_TEXT.includes("test-shared.sh"),
    "共享测试已并入完整分片，不得保留重复 job",
  );
  const changesJob = jobs.get("changes")!;
  assert(
    changesJob.includes("scripts/select-core-ci.ts") &&
      changesJob.includes("--base") && changesJob.includes("--head"),
    "changes job 必须把真实变更路径交给选择器",
  );
  assert(
    changesJob.includes("core-full") && changesJob.includes("e2e-domains"),
    "changes job 必须输出选择结果供下游 job 使用",
  );
});

Deno.test("workflow: E2E job 按选择器结果运行，且选择器覆盖全部 E2E 目录", () => {
  const jobs = jobBlocks(E2E_TEXT);
  const changes = jobs.get("changes")!;
  assert(
    changes.includes("scripts/select-core-ci.ts"),
    "e2e.yml 必须使用统一选择器",
  );
  assert(
    changes.includes("e2e-domains") && changes.includes("e2e-browser"),
    "e2e.yml 必须输出域与浏览器选择结果",
  );
  for (const domain of E2E_API_DOMAINS) {
    if (domain === "browser") {
      // Browser 拆成三组 matrix，并保留同名聚合 job 作为必需检查。
      const shard = jobs.get("e2e-browser-shard");
      assert(shard, "e2e.yml 缺少 e2e-browser-shard matrix job");
      assert(
        shard.includes("needs.changes.outputs.e2e-domains"),
        "Browser 分片必须按选择结果运行",
      );
      assert(
        shard.includes("browser1") && shard.includes("browser2") &&
          shard.includes("browser3"),
        "Browser 分片 matrix 必须覆盖三组",
      );
      assert(
        shard.includes("--shard") || shard.includes("shard:"),
        "Browser 分片必须把组名传给测试入口",
      );
      const aggregate = jobs.get("e2e-browser");
      assert(aggregate, "e2e.yml 缺少 Browser 聚合 job");
      assert(
        aggregate.includes("e2e-browser-shard.result") &&
          aggregate.includes("needs.changes.outputs.e2e-browser") &&
          aggregate.includes("always()"),
        "Browser 聚合 job 必须同时读取选择结果与分片结果，并在 skipped 时仍运行",
      );
      continue;
    }
    const job = jobs.get(`e2e-${domain}`);
    assert(job, `e2e.yml 缺少 e2e-${domain} job`);
    assert(
      job.includes("needs.changes.outputs.e2e-domains") ||
        job.includes("always()"),
      `e2e-${domain} 必须按选择结果运行`,
    );
  }
  assert(
    jobs.get("e2e-cross-domain")?.includes("e2e-domains"),
    "cross-domain job 必须按选择结果运行",
  );
});

Deno.test("workflow: 选择器路径分类覆盖受跟踪文件，没有无法归属的 Core/E2E 文件", async () => {
  const result = await new Deno.Command("git", {
    args: ["-C", ROOT, "ls-files"],
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(result.success, "需要 git ls-files 校验真实文件集合");
  const files = new TextDecoder().decode(result.stdout).split("\n").filter(
    Boolean,
  );
  const unknown: string[] = [];
  for (const file of files) {
    if (file.startsWith("dev-docs/") && CI_SELECTION.docPrefixes.length > 0) {
      // 文档由 docPrefixes 解释，无需逐条断言。
      if (file.endsWith(".md")) continue;
    }
    if (!file.startsWith("noj-core/") && !file.startsWith("noj-tests/")) {
      continue;
    }
    if (classifyChangedPath(file).kind === "unknown") unknown.push(file);
  }
  assertEquals(
    unknown.slice(0, 20),
    [],
    `以下受跟踪的 Core/E2E 文件无法归属，改动它们会扩大到全量：\n${
      unknown.slice(0, 20).map((file) => "  - " + file).join("\n")
    }`,
  );
});
