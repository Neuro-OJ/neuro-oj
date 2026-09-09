/**
 * 校验 Domain 并行 CI 配置（语义校验，而非字符串包含）。
 *
 * 覆盖：
 * 1. noj-core / noj-tests 的每个 domain 都有对应 job 与路径过滤；
 * 2. workflow 内的 domain 列表与文件系统实际 domain 一致（防手工列表漂移）；
 * 3. `noj-tests/e2e/` 下没有未归域的文件，`noj-core/src/domains/*` 都有 tests 目录；
 * 4. **每个受跟踪文件都至少被一个「会触发测试的」路径过滤命中**——这是本脚本的
 *    核心：避免只改共享 helper / deno.json / 脚本时 changes job 输出空数组，
 *    所有 job 被跳过而 workflow 仍报成功。
 *
 * 用法：`deno run -A scripts/verify-domain-ci.ts`
 */
import { fromFileUrl } from "jsr:@std/path@^1";

const root = new URL("../", import.meta.url);
const rootPath = fromFileUrl(root);

const SKIP_E2E_DIRS = new Set(["browser", "support-package", "staging"]);

/** 不参与「必须有测试触发」判定的文件（文档、镜像、测试产物等）。 */
const TEST_TRIGGER_ALLOWLIST: RegExp[] = [
  /^noj-core\/(AGENTS|CLAUDE)\.md$/,
  /^noj-core\/\.env\.example$/,
  /^noj-core\/\.(docker|git)ignore$/,
  /^noj-core\/Dockerfile/,
  /^noj-core\/\.test-storage\//,
  /^noj-core\/test-logs\//,
  /^noj-tests\/(AGENTS|CLAUDE|README|E2E_TESTING)\.md$/,
  /^noj-tests\/\.gitignore$/,
  // staging 验收清单由 scripts/staging/acceptance.sh 在生产候选环境执行，
  // 不在 PR E2E 栈中重复运行（与设计文档一致）。
  /^noj-tests\/e2e\/staging\//,
];

function fail(msg: string): never {
  throw new Error(`Domain CI 校验失败: ${msg}`);
}

// ── 基础工具 ────────────────────────────────────────────────────────

/** 把 paths-filter 的 glob 翻译成正则（支持 `**`、`*`、`?`）。 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+{}[]|().".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

interface WorkflowFilters {
  /** filter 名 → glob 列表 */
  filters: Map<string, string[]>;
  /** jobs 段中的 job 名集合 */
  jobs: Set<string>;
}

/** 解析 workflow 中的 `filters: |` 块与 `jobs:` 下的 job 名。 */
export function parseWorkflow(text: string): WorkflowFilters {
  const filters = new Map<string, string[]>();
  const jobs = new Set<string>();
  const lines = text.split("\n");

  // 1) filters 块（可能出现在任意 job 的 step 内）
  let filterIndent = -1;
  let currentFilter: string | null = null;
  for (const line of lines) {
    if (/^\s*filters:\s*\|/.test(line)) {
      filterIndent = line.search(/\S/);
      currentFilter = null;
      continue;
    }
    if (filterIndent < 0) continue;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= filterIndent) {
      filterIndent = -1;
      currentFilter = null;
      continue;
    }
    const nameMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(line.trim());
    if (nameMatch) {
      currentFilter = nameMatch[1];
      if (!filters.has(currentFilter)) filters.set(currentFilter, []);
      continue;
    }
    const patMatch = /^-\s*'([^']+)'\s*$/.exec(line.trim());
    if (patMatch && currentFilter) {
      filters.get(currentFilter)!.push(patMatch[1]);
    }
  }

  // 2) jobs 段（顶层键，2 空格缩进）
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      if (line.trim() === "" || line.startsWith("#")) continue;
      break; // 进入下一个顶层键
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) jobs.add(m[1]);
  }
  return { filters, jobs };
}

/** 读取受 git 跟踪的文件列表（失败时回退到目录遍历）。 */
async function trackedFiles(): Promise<string[]> {
  try {
    const { stdout, success } = await new Deno.Command("git", {
      args: ["-C", rootPath, "ls-files"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (success) {
      return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
    }
  } catch {
    // 回退到遍历
  }
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === ".git" || entry.name === ".jj") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(`${dir}/${entry.name}`, rel);
      else if (entry.isFile) out.push(rel);
    }
  }
  await walk(rootPath, "");
  return out;
}

function matchesAny(patterns: string[], file: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

// ── 读取配置 ────────────────────────────────────────────────────────

const ciText = await Deno.readTextFile(
  new URL(".github/workflows/ci.yml", root),
);
const e2eText = await Deno.readTextFile(
  new URL(".github/workflows/e2e.yml", root),
);
const ci = parseWorkflow(ciText);
const e2e = parseWorkflow(e2eText);

const coreDomainDirs: string[] = [];
for await (
  const entry of Deno.readDir(new URL("noj-core/src/domains/", root))
) {
  if (entry.isDirectory) coreDomainDirs.push(entry.name);
}
coreDomainDirs.sort();

const e2eDomainDirs: string[] = [];
const rootLevelE2eTests: string[] = [];
for await (const entry of Deno.readDir(new URL("noj-tests/e2e/", root))) {
  if (entry.isDirectory) e2eDomainDirs.push(entry.name);
  else if (entry.isFile && entry.name.endsWith(".test.ts")) {
    rootLevelE2eTests.push(entry.name);
  }
}
e2eDomainDirs.sort();

// ── 1. 每个 domain 都有 job 与过滤 ─────────────────────────────────

for (const domain of coreDomainDirs) {
  if (!ci.jobs.has(`core-${domain}`)) {
    fail(`ci.yml 缺少 core-${domain} job`);
  }
  if (!ci.filters.has(`core-${domain}`)) {
    fail(`ci.yml 缺少 core-${domain} 路径过滤`);
  }
}
if (!ci.jobs.has("core-shared")) fail("ci.yml 缺少 core-shared job");
if (!ci.filters.has("core-shared")) fail("ci.yml 缺少 core-shared 路径过滤");

for (const domain of e2eDomainDirs) {
  if (SKIP_E2E_DIRS.has(domain)) continue;
  if (!e2e.jobs.has(`e2e-${domain}`)) {
    fail(`e2e.yml 缺少 e2e-${domain} job`);
  }
  if (!e2e.filters.has(`e2e-${domain}`)) {
    fail(`e2e.yml 缺少 e2e-${domain} 路径过滤`);
  }
}
if (!e2e.jobs.has("e2e-browser")) fail("e2e.yml 缺少 e2e-browser job");
if (!e2e.filters.has("e2e-infra")) fail("e2e.yml 缺少 e2e-infra 路径过滤");

// ── 2. workflow 内的 domain 列表与实际目录一致 ─────────────────────

function pythonList(text: string, varName: string, file: string): string[] {
  const m = new RegExp(`${varName} = \\[([^\\]]*)\\]`).exec(text);
  if (!m) fail(`${file} 中找不到 ${varName} 列表`);
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean).sort();
}

const coreInWorkflow = pythonList(ciText, "all_core", "ci.yml");
if (coreInWorkflow.join(",") !== coreDomainDirs.join(",")) {
  fail(
    `ci.yml all_core 列表与 noj-core/src/domains 不一致：\n  workflow: ${
      coreInWorkflow.join(", ")
    }\n  磁盘:     ${coreDomainDirs.join(", ")}`,
  );
}

const e2eInWorkflow = pythonList(e2eText, "all_e2e", "e2e.yml");
const e2eOnDisk = e2eDomainDirs.filter((d) =>
  !SKIP_E2E_DIRS.has(d) && d !== "cross-domain"
);
if (e2eInWorkflow.join(",") !== e2eOnDisk.join(",")) {
  fail(
    `e2e.yml all_e2e 列表与 noj-tests/e2e 目录不一致：\n  workflow: ${
      e2eInWorkflow.join(", ")
    }\n  磁盘:     ${e2eOnDisk.join(", ")}`,
  );
}

// ── 3. 目录结构检查 ────────────────────────────────────────────────

if (rootLevelE2eTests.length > 0) {
  fail(
    `e2e/ 根目录存在未归入 Domain 的测试文件: ${rootLevelE2eTests.join(", ")}`,
  );
}
for (const domain of coreDomainDirs) {
  try {
    await Deno.stat(
      new URL(`${domain}/tests/`, new URL("noj-core/src/domains/", root)),
    );
  } catch {
    fail(`src/domains/${domain} 缺少 tests 目录`);
  }
}

// ── 4. 每个受跟踪文件都必须有测试触发路径（核心检查） ──────────────

const coreTestFilters = [...ci.filters.entries()]
  .filter(([name]) => name === "core-shared" || name.startsWith("core-"))
  .flatMap(([, patterns]) => patterns);
const e2eTestFilters = [...e2e.filters.entries()]
  .filter(([name]) => name.startsWith("e2e-"))
  .flatMap(([, patterns]) => patterns);

const files = await trackedFiles();
const uncovered: string[] = [];
for (const file of files) {
  const isCore = file.startsWith("noj-core/");
  const isE2e = file.startsWith("noj-tests/");
  if (!isCore && !isE2e) continue;
  if (TEST_TRIGGER_ALLOWLIST.some((re) => re.test(file))) continue;
  const patterns = isCore ? coreTestFilters : e2eTestFilters;
  if (!matchesAny(patterns, file)) uncovered.push(file);
}
if (uncovered.length > 0) {
  fail(
    `以下文件不属于任何会触发测试的路径过滤，改动它们将零测试执行：\n  ${
      uncovered.slice(0, 40).join("\n  ")
    }${uncovered.length > 40 ? `\n  ...共 ${uncovered.length} 个` : ""}`,
  );
}

console.log(
  `Domain CI 配置校验通过（core ${coreDomainDirs.length} 个域 / e2e ${e2eDomainDirs.length} 个目录，受跟踪文件 ${files.length} 个全部有测试触发路径）`,
);
