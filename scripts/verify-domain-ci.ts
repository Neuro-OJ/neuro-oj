// 校验 Domain 并行 CI 配置：目录结构、core-* / e2e-* job 命名、无游离测试文件。
const CORE_DOMAINS = [
  "identity",
  "catalog",
  "submission",
  "contest",
  "system",
  "community",
  "messaging",
  "objective",
  "admin",
  "search",
  "query",
  "gateway",
  "content-review",
];
const E2E_DOMAINS = [
  "identity",
  "catalog",
  "submission",
  "contest",
  "system",
  "community",
  "messaging",
  "objective",
  "admin",
  "cross-domain",
];
const SKIP_E2E_DIRS = new Set(["browser", "support-package", "staging"]);

const root = new URL("../", import.meta.url);
const e2eRoot = new URL("noj-tests/e2e/", root);
const domainsRoot = new URL("noj-core/src/domains/", root);
const ciYml = await Deno.readTextFile(
  new URL(".github/workflows/ci.yml", root),
);
const e2eYml = await Deno.readTextFile(
  new URL(".github/workflows/e2e.yml", root),
);

function fail(msg: string): never {
  throw new Error(`Domain CI 校验失败: ${msg}`);
}

// 1. noj-core 每个 domain 都有 core-<name> job，且有 core-shared
for (const name of CORE_DOMAINS) {
  if (!ciYml.includes(`core-${name}:`)) fail(`ci.yml 缺少 core-${name} job`);
}
if (!ciYml.includes("core-shared:")) fail("ci.yml 缺少 core-shared job");

// 2. e2e 每个 domain 都有 e2e-<name> job，且有 e2e-cross-domain / e2e-browser
for (const name of E2E_DOMAINS) {
  if (!e2eYml.includes(`e2e-${name}:`)) fail(`e2e.yml 缺少 e2e-${name} job`);
}
if (!e2eYml.includes("e2e-browser:")) fail("e2e.yml 缺少 e2e-browser job");

// 3. noj-tests/e2e 下每个目录都是已知 domain，且根目录无游离测试文件
for await (const entry of Deno.readDir(e2eRoot)) {
  if (entry.isDirectory) {
    if (!E2E_DOMAINS.includes(entry.name) && !SKIP_E2E_DIRS.has(entry.name)) {
      fail(`e2e/ 存在未知目录: ${entry.name}`);
    }
  } else if (entry.isFile && entry.name.endsWith(".test.ts")) {
    fail(`e2e/ 根目录存在未归入 Domain 的测试文件: ${entry.name}`);
  }
}

// 4. noj-core/src/domains 下每个 domain 都有 tests 目录
for await (const entry of Deno.readDir(domainsRoot)) {
  if (!entry.isDirectory) continue;
  if (!CORE_DOMAINS.includes(entry.name)) {
    fail(`src/domains/ 存在未知 domain: ${entry.name}`);
  }
  const testsDir = new URL(`${entry.name}/tests/`, domainsRoot);
  try {
    await Deno.stat(testsDir);
  } catch {
    fail(`src/domains/${entry.name} 缺少 tests 目录`);
  }
}

// 5. e2e-infra 必须覆盖基础测试设施路径，避免只改测试启动器/复合 Action 时
//    changes job 输出空数组导致所有 E2E job 被跳过。
const E2E_INFRA_REQUIRED_PATHS = [
  "noj-tests/scripts/**",
  "noj-tests/deno.json",
  ".github/actions/e2e-domain/**",
];
for (const p of E2E_INFRA_REQUIRED_PATHS) {
  if (!e2eYml.includes(`'${p}'`)) {
    fail(`e2e.yml e2e-infra 缺少路径 ${p}`);
  }
}

console.log("Domain CI 配置校验通过");
