/**
 * Browser 分组计划单元测试：只验证纯规划逻辑与基线 loader，不需要 Playwright/DB。
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  auditPlan,
  type BrowserGroup,
  buildBrowserPlan,
  DEFAULT_BROWSER_GROUP_COUNT,
  discoverBrowserTestFiles,
  emptyBrowserBaseline,
  FALLBACK_BROWSER_FILE_DURATION_MS,
  type FileDurationBaseline,
  isBrowserTestFile,
  loadBrowserDurationBaseline,
  normalizeBrowserTestPath,
  partitionBrowserFiles,
} from "../../scripts/test-plan.ts";

/** 构造基线；默认给一个合法 source，聚焦被测字段。 */
function baseline(files: Record<string, number>): FileDurationBaseline {
  return {
    version: 1,
    generatedAt: "2026-11-03T00:00:00.000Z",
    source: "unit-test",
    files,
  };
}

function fileNames(groups: readonly BrowserGroup[]): string[] {
  return groups.flatMap((group) => group.files);
}

Deno.test("test-plan: 按耗时降序分配到当前累计最少的分组", () => {
  const files = [
    "e2e/browser/a.test.ts",
    "e2e/browser/b.test.ts",
    "e2e/browser/c.test.ts",
    "e2e/browser/d.test.ts",
    "e2e/browser/e.test.ts",
  ];
  const groups = partitionBrowserFiles(files, 2, {
    "e2e/browser/a.test.ts": 1000,
    "e2e/browser/b.test.ts": 900,
    "e2e/browser/c.test.ts": 800,
    "e2e/browser/d.test.ts": 100,
    "e2e/browser/e.test.ts": 50,
  });
  assertEquals(groups.map((group) => group.groupName), [
    "browser1",
    "browser2",
  ]);
  assertEquals(groups[0].files, [
    "e2e/browser/a.test.ts",
    "e2e/browser/d.test.ts",
    "e2e/browser/e.test.ts",
  ]);
  assertEquals(groups[0].estimatedMs, 1150);
  assertEquals(groups[1].files, [
    "e2e/browser/b.test.ts",
    "e2e/browser/c.test.ts",
  ]);
  assertEquals(groups[1].estimatedMs, 1700);
  assertEquals(auditPlan(groups, files), []);
});

Deno.test("test-plan: 同耗时按路径升序，输入顺序不影响结果", () => {
  const files = [
    "e2e/browser/zeta.test.ts",
    "e2e/browser/alpha.test.ts",
    "e2e/browser/mid.test.ts",
  ];
  const durations = {
    "e2e/browser/zeta.test.ts": 1000,
    "e2e/browser/alpha.test.ts": 1000,
    "e2e/browser/mid.test.ts": 1000,
  };
  const forward = partitionBrowserFiles(files, 3, durations);
  const backward = partitionBrowserFiles([...files].reverse(), 3, durations);
  assertEquals(forward, backward);
  assertEquals(forward.map((group) => group.files), [
    ["e2e/browser/alpha.test.ts"],
    ["e2e/browser/mid.test.ts"],
    ["e2e/browser/zeta.test.ts"],
  ]);
});

Deno.test("test-plan: 路径规范化、去重且空路径被丢弃", () => {
  const raw = [
    "./e2e/browser/a.test.ts",
    "e2e//browser/a.test.ts",
    "e2e/browser/b.test.ts",
    "",
    "   ",
  ];
  const groups = partitionBrowserFiles(raw, 2, {
    "e2e/browser/a.test.ts": 10,
    "e2e/browser/b.test.ts": 5,
  });
  assertEquals(fileNames(groups), [
    "e2e/browser/a.test.ts",
    "e2e/browser/b.test.ts",
  ]);
  assertEquals(auditPlan(groups, raw), []);
  assertEquals(
    normalizeBrowserTestPath("./e2e//browser/a.test.ts"),
    "e2e/browser/a.test.ts",
  );
});

Deno.test("test-plan: 未知文件在 partition 层使用给定估值", () => {
  const groups = partitionBrowserFiles(
    ["e2e/browser/known.test.ts", "e2e/browser/fresh.test.ts"],
    1,
    { "e2e/browser/known.test.ts": 10_000 },
  );
  assertEquals(
    groups[0].estimatedMs,
    10_000 + FALLBACK_BROWSER_FILE_DURATION_MS,
  );
});

Deno.test("test-plan: 未知文件用基线中位数估值", () => {
  const plan = buildBrowserPlan(
    [
      "e2e/browser/a.test.ts",
      "e2e/browser/b.test.ts",
      "e2e/browser/new.test.ts",
    ],
    baseline({
      "e2e/browser/a.test.ts": 1000,
      "e2e/browser/b.test.ts": 3000,
    }),
    1,
  );
  assertEquals(plan.baseline.unknownMs, 2000);
  assertEquals(plan.baseline.knownFiles, 2);
  assertEquals(plan.groups[0].estimatedMs, 6000);
});

Deno.test("test-plan: 无基线时回退到固定估值", () => {
  const plan = buildBrowserPlan(
    ["e2e/browser/a.test.ts", "e2e/browser/b.test.ts"],
    emptyBrowserBaseline(),
    1,
  );
  assertEquals(plan.baseline.source, "none");
  assertEquals(plan.baseline.unknownMs, FALLBACK_BROWSER_FILE_DURATION_MS);
  assertEquals(
    plan.groups[0].estimatedMs,
    2 * FALLBACK_BROWSER_FILE_DURATION_MS,
  );
});

Deno.test("test-plan: 分组数 1/2/3 每个文件恰好一组且总耗时守恒", () => {
  const files = [
    "e2e/browser/a.test.ts",
    "e2e/browser/b.test.ts",
    "e2e/browser/c.test.ts",
    "e2e/browser/d.test.ts",
    "e2e/browser/e.test.ts",
  ];
  const durations = {
    "e2e/browser/a.test.ts": 5000,
    "e2e/browser/b.test.ts": 4000,
    "e2e/browser/c.test.ts": 3000,
    "e2e/browser/d.test.ts": 2000,
    "e2e/browser/e.test.ts": 1000,
  };
  const total = Object.values(durations).reduce((sum, ms) => sum + ms, 0);
  for (const groupCount of [1, 2, 3]) {
    const plan = buildBrowserPlan(files, baseline(durations), groupCount);
    assertEquals(plan.groups.length, groupCount);
    assertEquals(
      plan.groups.map((group) => group.groupName),
      Array.from({ length: groupCount }, (_, index) => `browser${index + 1}`),
    );
    const planned = fileNames(plan.groups).sort();
    assertEquals(planned, [...files].sort());
    assertEquals(new Set(planned).size, files.length);
    assertEquals(
      plan.groups.reduce((sum, group) => sum + group.estimatedMs, 0),
      total,
    );
    assertEquals(auditPlan(plan, files), []);
  }
  assertEquals(DEFAULT_BROWSER_GROUP_COUNT, 3);
});

Deno.test("test-plan: 非法分组数直接失败", () => {
  assertThrows(
    () => partitionBrowserFiles(["e2e/browser/a.test.ts"], 0),
    Error,
    "分组数必须为 ≥1 的整数",
  );
  assertThrows(
    () => partitionBrowserFiles(["e2e/browser/a.test.ts"], 1.5),
    Error,
    "分组数必须为 ≥1 的整数",
  );
});

Deno.test("test-plan: auditPlan 发现遗漏文件", () => {
  const files = ["e2e/browser/a.test.ts", "e2e/browser/b.test.ts"];
  const groups = partitionBrowserFiles(files, 1);
  groups[0].files = ["e2e/browser/a.test.ts"];
  const problems = auditPlan(groups, files);
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "未进入任何分组");
  assertStringIncludes(problems[0], "e2e/browser/b.test.ts");
});

Deno.test("test-plan: auditPlan 发现跨组重复与组内重复", () => {
  const files = ["e2e/browser/a.test.ts", "e2e/browser/b.test.ts"];
  const groups = partitionBrowserFiles(files, 2);
  // 跨组重复：b 同时出现在两个组
  groups[0].files.push("e2e/browser/b.test.ts");
  const cross = auditPlan(groups, files);
  assertEquals(cross.some((line) => line.includes("同时出现在")), true);

  // 组内重复：同一文件在一个组出现两次
  const duplicated = partitionBrowserFiles(files, 2);
  duplicated[0].files.push(duplicated[0].files[0]!);
  const within = auditPlan(duplicated, files);
  assertEquals(within.some((line) => line.includes("重复包含")), true);
});

Deno.test("test-plan: auditPlan 发现计划外文件", () => {
  const files = ["e2e/browser/a.test.ts"];
  const groups = partitionBrowserFiles(files, 1);
  groups[0].files.push("e2e/browser/extra.test.ts");
  const problems = auditPlan(groups, files);
  assertEquals(problems.some((line) => line.includes("计划外的文件")), true);
});

Deno.test("test-plan: loader 读取基线并归一化 noj-tests/ 前缀", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-test-plan-" });
  try {
    const path = `${dir}/baseline.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-03T00:00:00.000Z",
        source: "deno task test:baseline --suite browser",
        files: {
          "noj-tests/e2e/browser/a.test.ts": 1200,
          "e2e/browser/b.test.ts": 800,
        },
      }),
    );
    const parsed = await loadBrowserDurationBaseline(path);
    assertEquals(parsed.version, 1);
    assertEquals(parsed.source, "deno task test:baseline --suite browser");
    assertEquals(parsed.files, {
      "e2e/browser/a.test.ts": 1200,
      "e2e/browser/b.test.ts": 800,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-plan: loader 对缺失/坏 JSON/结构错误明确失败", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-test-plan-" });
  try {
    const missing = `${dir}/missing.json`;
    await assertRejects(
      () => loadBrowserDurationBaseline(missing),
      Error,
      "基线不存在",
    );

    const broken = `${dir}/broken.json`;
    await Deno.writeTextFile(broken, "{ not json");
    await assertRejects(
      () => loadBrowserDurationBaseline(broken),
      Error,
      "不是合法 JSON",
    );

    const badVersion = `${dir}/version.json`;
    await Deno.writeTextFile(
      badVersion,
      JSON.stringify({
        version: 2,
        generatedAt: "2026-11-03T00:00:00.000Z",
        source: "x",
        files: {},
      }),
    );
    await assertRejects(
      () => loadBrowserDurationBaseline(badVersion),
      Error,
      "版本",
    );

    const missingSource = `${dir}/source.json`;
    await Deno.writeTextFile(
      missingSource,
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-03T00:00:00.000Z",
        source: "",
        files: {},
      }),
    );
    await assertRejects(
      () => loadBrowserDurationBaseline(missingSource),
      Error,
      "source",
    );

    const badDuration = `${dir}/duration.json`;
    await Deno.writeTextFile(
      badDuration,
      JSON.stringify({
        version: 1,
        generatedAt: "2026-11-03T00:00:00.000Z",
        source: "x",
        files: { "e2e/browser/a.test.ts": -1 },
      }),
    );
    await assertRejects(
      () => loadBrowserDurationBaseline(badDuration),
      Error,
      "不合法",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-plan: 发现逻辑排除 _*.ts 夹具并保留嵌套测试", async () => {
  const dir = await Deno.makeTempDir({ prefix: "noj-test-plan-" });
  try {
    const browser = `${dir}/e2e/browser`;
    await Deno.mkdir(`${browser}/nested`, { recursive: true });
    for (
      const name of [
        "a.test.ts",
        "_fixture.ts",
        "b_test.ts",
        "helper.ts",
        "nested/c.test.ts",
        "nested/_skip.test.ts",
      ]
    ) {
      await Deno.writeTextFile(`${browser}/${name}`, "");
    }
    assertEquals(await discoverBrowserTestFiles(dir), [
      "e2e/browser/a.test.ts",
      "e2e/browser/nested/c.test.ts",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("test-plan: 真实 e2e/browser 目录只含用例文件", async () => {
  const files = await discoverBrowserTestFiles(".");
  assertEquals(files.length > 0, true);
  assertEquals(files, [...files].sort());
  assertEquals(new Set(files).size, files.length);
  for (const file of files) {
    assertStringIncludes(file, "e2e/browser/");
    assertEquals(file.endsWith(".test.ts"), true);
    assertEquals(file.includes("/_"), false);
    assertEquals(isBrowserTestFile(file), true);
  }
  // 已知夹具文件不得进入计划
  assertEquals(files.some((file) => file.includes("_workspace-")), false);
});
