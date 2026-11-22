/**
 * 校验 Domain 并行 CI 配置（语义校验，而非字符串包含）。
 *
 * 覆盖：
 * 1. noj-core / noj-tests 的每个 domain 都有对应 job 与路径过滤；
 * 2. Core 回归统一由完整分片 job 执行，不再保留重复 legacy domain job；
 * 3. `noj-tests/e2e/` 下没有未归域的文件，每个 Core 别名至少发现一个新/旧测试根；
 * 4. **每个受跟踪文件都至少被一个「会触发测试的」路径过滤命中**——这是本脚本的
 *    核心：避免只改共享 helper / deno.json / 脚本时 changes job 输出空数组，
 *    所有 job 被跳过而 workflow 仍报成功。
 *
 * 用法：`deno run -A scripts/verify-domain-ci.ts`
 */
import { fromFileUrl } from "jsr:@std/path@^1";
import {
  E2E_API_DOMAINS,
  LEGACY_DOMAIN_NAMES,
  MODULE_TEST_METADATA,
  testRootsForTarget,
} from "./module-test-metadata.ts";
import { classifyChangedPath } from "./select-core-ci.ts";

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
/**
 * 遍历回退时跳过的派生/依赖目录。
 *
 * 修复（2026-09-12 实测）：在 jj worktree（无 `.git` 目录）中 `git ls-files` 失败，
 * 会走到下面的遍历回退分支；旧实现只跳过 `.git`/`.jj`，于是把 `node_modules`
 * （1.3 万个文件）当成"受跟踪文件"，因为都不匹配路径过滤而**误报门禁失败**
 * ——即该门禁在 jj 工作区中根本不可用。CI 检出的是真 git 仓库，所以一直没暴露。
 */
const FALLBACK_EXCLUDED_DIRS = new Set([
  ".git",
  ".jj",
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "target",
  "coverage",
  ".test-cache",
  ".test-storage",
  ".deno_cache",
  "test-logs",
]);

async function trackedFiles(): Promise<string[]> {
  try {
    const { stdout, success } = await new Deno.Command("git", {
      args: ["-C", rootPath, "ls-files"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (success) {
      const files = new TextDecoder().decode(stdout).split("\n").filter(
        Boolean,
      );
      // 真 git 仓库路径下也要显式排除（防止未来有人把 node_modules 提交进来）
      if (files.length > 0) {
        return files.filter((f) =>
          !f.split("/").some((seg) => FALLBACK_EXCLUDED_DIRS.has(seg))
        );
      }
    }
  } catch {
    // 回退到遍历
  }
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    // Deno.readDir 惰性迭代：目录不存在时错误在 for await 处抛出
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(`${dir}/${entry.name}`, rel);
      else if (entry.isFile) out.push(rel);
    }
  }
  await walk(rootPath, "");
  return out;
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

const coreDomainDirs = [...LEGACY_DOMAIN_NAMES].sort();
// legacy 域允许按计划搬迁；身份来自统一元数据而不是当前物理目录名称。
// src/domains 已全部迁入 src/modules（#698 P1-3）；目录若被重新创建仍需登记。
const legacyDomainRoot = new URL("noj-core/src/domains/", root);
const legacyDomainRootExists = await Deno.stat(legacyDomainRoot).then(
  (info) => info.isDirectory,
  () => false,
);
if (legacyDomainRootExists) {
  for await (const entry of Deno.readDir(legacyDomainRoot)) {
    if (entry.isDirectory && !coreDomainDirs.includes(entry.name)) {
      fail(`遗留域 ${entry.name} 未登记到模块元数据`);
    }
  }
}
for (const module of MODULE_TEST_METADATA.targetModules) {
  if (
    !MODULE_TEST_METADATA.testCiMapping[module.name]?.ciJobs.includes(
      "core-test-sharded",
    )
  ) {
    fail(`模块 ${module.name} 缺少完整分片测试 CI 映射`);
  }
}

const e2eDomainDirs: string[] = [];
const rootLevelE2eTests: string[] = [];
for await (const entry of Deno.readDir(new URL("noj-tests/e2e/", root))) {
  if (entry.isDirectory) e2eDomainDirs.push(entry.name);
  else if (entry.isFile && entry.name.endsWith(".test.ts")) {
    rootLevelE2eTests.push(entry.name);
  }
}
e2eDomainDirs.sort();

// ── 1. Core 回归只由完整分片执行，禁止重复 legacy domain job ────────

for (const domain of coreDomainDirs) {
  if (ci.jobs.has(`core-${domain}`)) {
    fail(
      `ci.yml 仍保留重复的 legacy job core-${domain}；` +
        "Core 回归统一由 core-test-sharded 执行，避免同一文件重复跑",
    );
  }
  if (!MODULE_TEST_METADATA.legacyDomainToModule[domain]) {
    fail(`legacy 域 ${domain} 未登记到目标模块`);
  }
}
if (!ci.jobs.has("core-test-sharded")) {
  fail("ci.yml 缺少 core-test-sharded：Core 全部回归必须由完整分片执行");
}
if (!ciText.includes("deno task test:parallel --shards 4 --jobs 2")) {
  fail("core-test-sharded 必须以 4 片 2 并发执行全部 Core 测试");
}
if (ciText.includes("scripts/test-domain.sh")) {
  fail(
    "CI 不得用 test-domain.sh 重复执行完整分片已覆盖的测试（本地兼容入口保留即可）",
  );
}
if (ci.jobs.has("core-shared")) {
  fail("共享测试已并入完整分片，ci.yml 不得保留重复的 core-shared job");
}
if (!ciText.includes("scripts/select-core-ci.ts")) {
  fail("Core CI 必须由统一选择器接收真实变更路径，不得维护过时的 domain 过滤");
}
try {
  const denoConfig = JSON.parse(
    await Deno.readTextFile(new URL("noj-core/deno.json", root)),
  ) as { tasks?: Record<string, string> };
  for (const task of ["test:domain", "test:shared", "test:parallel"]) {
    if (!denoConfig.tasks?.[task]) {
      fail(`本地兼容入口 deno task ${task} 不得删除`);
    }
  }
} catch (error) {
  fail(`无法读取 noj-core/deno.json 校验本地兼容入口：${String(error)}`);
}

// ── 2. workflow 内的 domain 列表与实际目录一致 ─────────────────────

const e2eOnDisk = e2eDomainDirs.filter((d) =>
  !SKIP_E2E_DIRS.has(d) && d !== "cross-domain"
);
if (JSON.stringify([...E2E_API_DOMAINS].sort()) !== JSON.stringify(e2eOnDisk)) {
  fail(
    `module-boundaries.json e2eApiDomains 与 noj-tests/e2e 目录不一致：\n` +
      `  元数据: ${E2E_API_DOMAINS.join(", ")}\n  磁盘:   ${
        e2eOnDisk.join(", ")
      }`,
  );
}
if (!e2e.jobs.has("e2e-browser")) fail("e2e.yml 缺少 e2e-browser job");
if (!e2e.jobs.has("e2e-cross-domain")) {
  fail("e2e.yml 缺少 e2e-cross-domain job");
}
if (!e2eText.includes("scripts/select-core-ci.ts")) {
  fail("e2e.yml 必须由统一选择器计算 E2E 域");
}

// ── 3. 目录结构检查 ────────────────────────────────────────────────

if (rootLevelE2eTests.length > 0) {
  fail(
    `e2e/ 根目录存在未归入 Domain 的测试文件: ${rootLevelE2eTests.join(", ")}`,
  );
}
for (const domain of coreDomainDirs) {
  const roots = testRootsForTarget(domain);
  let found = false;
  for (const candidate of roots) {
    try {
      found ||=
        (await Deno.stat(new URL(`${candidate}/`, new URL("noj-core/", root))))
          .isDirectory;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (!found) {
    fail(`域 ${domain} 的旧/新模块测试根全部缺失，不能以搬迁为由漏测`);
  }
}

// ── 4. 每个受跟踪文件都必须被选择器解释（核心检查） ────────────────

// 触发面不再靠手抄 paths-filter：选择器必须能为每个受跟踪的 Core/E2E 文件
// 给出明确分类（模块、共享基础设施、文档、自身 CI……），返回 unknown 即失败。
const files = await trackedFiles();
const uncovered: string[] = [];
for (const file of files) {
  if (!file.startsWith("noj-core/") && !file.startsWith("noj-tests/")) continue;
  if (TEST_TRIGGER_ALLOWLIST.some((re) => re.test(file))) continue;
  if (classifyChangedPath(file).kind === "unknown") uncovered.push(file);
}
if (uncovered.length > 0) {
  fail(
    `以下文件无法被 CI 选择器归属，改动它们会无解释地扩大到全量：\n  ${
      uncovered.slice(0, 40).join("\n  ")
    }${uncovered.length > 40 ? `\n  ...共 ${uncovered.length} 个` : ""}`,
  );
}

console.log(
  `Domain CI 配置校验通过（core ${coreDomainDirs.length} 个域全部由完整分片覆盖 / e2e ${e2eDomainDirs.length} 个目录，受跟踪文件 ${files.length} 个全部可被选择器解释）`,
);
