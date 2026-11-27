/**
 * 分支安全自检的回归测试。
 *
 * 夹具全部是**真实 git 仓库**（临时目录 + git 子进程）：检查项 A/C 的判定完全
 * 建立在 git 历史之上，mock 掉 git 等于测了个假的。
 *
 * 注意：本文件本身会被检查项 B 扫描（`scripts/` 在扫描范围内），所以夹具里的
 * 路径一律用 `fixturePath()` 拼接生成，不写整段字面量——否则测试数据会变成
 * 自伤的门禁告警。测试文件只查导入、不查字符串字面量，这条规则也一并被测到。
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { fileURLToPath } from "node:url";
import { parseArgs, runChecks } from "./check-branch-safety.ts";
import { validateCommitMessage } from "./lib/branch-safety-checks.ts";
import {
  parsePushedRefs,
  runPushedRefsChecks,
} from "./lib/branch-safety-pushed.ts";
import {
  checkBrokenReferences,
  extractReferences,
  resolveSpecifier,
} from "./lib/branch-safety-references.ts";
import type { TreeSource } from "./lib/branch-safety-tree.ts";

/** 拼接夹具路径（拆开写，避免本文件被自己扫描时命中整段假路径）。 */
function fixturePath(...segments: string[]): string {
  return segments.join("/");
}

const GIT_CONFIG = [
  "-c",
  "user.name=Branch Safety Test",
  "-c",
  "user.email=branch-safety@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

/** 跑一条 git 命令；失败直接抛错（夹具本身坏掉时要立刻暴露）。 */
async function git(root: string, args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args: ["-C", root, ...GIT_CONFIG, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败：${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/** 写夹具文件（自动建父目录）。 */
async function writeFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const full = `${root}/${relativePath}`;
  const slash = full.lastIndexOf("/");
  await Deno.mkdir(full.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(full, content);
}

/** 暂存并提交。 */
async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", message]);
}

/**
 * 建一个带 main 分支的临时仓库。
 *
 * 初始提交里必须有 `scripts/`：引用扫描的零输入守卫要求仓库看起来像本仓库。
 */
async function createRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "noj-branch-safety-" });
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(
    root,
    fixturePath("scripts", "placeholder.ts"),
    "export const placeholder = 1;\n",
  );
  await commitAll(root, "feat(root): 初始化夹具仓库");
  return root;
}

/** 生成 N 行互不相同的源码，便于构造"净删除 M 行"的 diff。 */
function lines(count: number, prefix: string): string {
  return Array.from(
    { length: count },
    (_, index) => `export const ${prefix}${index} = ${index};`,
  ).join("\n") + "\n";
}

/** 清理临时仓库（Windows 上 .git 里有只读对象，失败时忽略）。 */
async function cleanup(root: string): Promise<void> {
  try {
    await Deno.remove(root, { recursive: true });
  } catch {
    // 临时目录清不掉不影响测试结论
  }
}

/** 跑一条允许失败的 git 命令（需要看 stdout/stderr 时用）。 */
async function gitResult(
  root: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", {
    args: ["-C", root, ...GIT_CONFIG, ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** 取完整提交 SHA。 */
async function headSha(root: string, revision = "HEAD"): Promise<string> {
  return (await git(root, ["rev-parse", revision])).trim();
}

/** 拼一行 pre-push stdin。 */
function refLine(
  localRef: string,
  localSha: string,
  remoteRef: string,
  remoteSha: string,
): string {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}`;
}

/** 内存版提交树：断链扫描单测不碰真实文件系统。 */
function memoryTree(files: Record<string, string>): TreeSource {
  const paths = Object.keys(files).sort();
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return {
    commit: "memory",
    listFiles: () => Promise.resolve(paths),
    readFile: (path) => Promise.resolve(files[path] ?? null),
    exists: (path) => Promise.resolve(path in files || directories.has(path)),
    topLevel: () =>
      Promise.resolve(new Set(paths.map((path) => path.split("/")[0]))),
    close: () => Promise.resolve(),
  };
}

/** 命令是否可用（hook 测试要 node 装钩子）。 */
async function hasCommand(name: string): Promise<boolean> {
  try {
    const output = await new Deno.Command(name, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.code === 0;
  } catch {
    return false;
  }
}

const HAS_NODE = await hasCommand("node");

/** 把真实的 install-git-hooks.mjs 复制进夹具仓库并执行（验证钩子模板本身）。 */
async function installHooks(repo: string): Promise<void> {
  const source = fileURLToPath(
    new URL("./install-git-hooks.mjs", import.meta.url),
  );
  const target = `${repo}/scripts/install-git-hooks.mjs`;
  await Deno.mkdir(`${repo}/scripts`, { recursive: true });
  await Deno.copyFile(source, target);
  const output = await new Deno.Command("node", {
    args: [target],
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    throw new Error(
      `安装 hooks 失败：${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

/** 建一个裸远端并加为 origin；返回远端目录。 */
async function createRemote(repo: string): Promise<string> {
  const remote = await Deno.makeTempDir({ prefix: "noj-branch-remote-" });
  await git(remote, ["init", "-q", "--bare"]);
  await git(repo, ["remote", "add", "origin", remote.replace(/\\/g, "/")]);
  return remote;
}

/** 临时 PATH 前缀（Windows 用 `;`，POSIX 用 `:`）。 */
function prependPath(directory: string, existing: string | undefined): string {
  const separator = Deno.build.os === "windows" ? ";" : ":";
  const base = existing === undefined || existing === "" ? "" : existing;
  return base === "" ? directory : `${directory}${separator}${base}`;
}

/** 写一个假的 deno：记录参数与 stdin，按 NOJ_FAKE_EXIT 退出。 */
async function createFakeDeno(directory: string): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "$NOJ_FAKE_ARGS"`,
    'cat > "$NOJ_FAKE_STDIN"',
    'exit "${NOJ_FAKE_EXIT:-0}"',
    "",
  ].join("\n");
  const path = `${directory}/deno`;
  await Deno.writeTextFile(path, script);
  try {
    await Deno.chmod(path, 0o755);
  } catch {
    // Windows 上没有 posix 权限位，MSYS 默认可执行
  }
}

/** 带分支安全任务的夹具仓库。 */
async function createRepoWithTask(): Promise<string> {
  const repo = await createRepo();
  await writeFile(
    repo,
    "deno.json",
    [
      "{",
      '  "lock": false,',
      '  "tasks": {',
      '    "check:branch-safety": "deno run -A scripts/check-branch-safety.ts"',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await commitAll(repo, "feat(root): 加分支安全自检任务");
  return repo;
}

const TARGET = fixturePath(
  "noj-ui",
  "middleware",
  "default-workspace.global.ts",
);

// ── 检查项 A：静默覆盖 ─────────────────────────────────────────────

Deno.test("检查项 A：目标分支分叉后改过、本分支也改了 → warn", async () => {
  const repo = await createRepo();
  try {
    await writeFile(repo, TARGET, lines(8, "middleware"));
    await commitAll(repo, "feat(ui): 初始中间件");

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    // 本分支把 8 行砍到 3 行（净删除 5 行 → 不是"仅重命名/路径替换"）
    await writeFile(repo, TARGET, lines(3, "middleware"));
    await commitAll(repo, "feat(ui): 重写中间件");

    // 目标分支在分叉后补了重定向逻辑
    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(
      repo,
      TARGET,
      lines(3, "middleware") + "// 大小写归一化\n// destination.query 合并\n",
    );
    await commitAll(repo, "fix(ui): 补上大小写归一化");

    await git(repo, ["checkout", "-q", "feature"]);
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });

    const overwrites = result.findings.filter((finding) =>
      finding.check === "A"
    );
    assertEquals(overwrites.length, 1);
    assertEquals(overwrites[0].level, "warn");
    assertEquals(overwrites[0].path, TARGET);
    assert(
      overwrites[0].message.includes("大小写归一化"),
      `A 检查应列出目标分支的提交信息，实际：${overwrites[0].message}`,
    );
    assertEquals(result.summary.error, 0);
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 A：目标分支没改过的文件不报", async () => {
  const repo = await createRepo();
  try {
    await writeFile(repo, TARGET, lines(8, "middleware"));
    await commitAll(repo, "feat(ui): 初始中间件");

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(repo, TARGET, lines(3, "middleware"));
    await commitAll(repo, "feat(ui): 重写中间件");

    // 目标分支改的是另一个文件
    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "other.ts"),
      "export const other = 1;\n",
    );
    await commitAll(repo, "fix(ui): 改别的文件");

    await git(repo, ["checkout", "-q", "feature"]);
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      result.findings.filter((finding) => finding.check === "A").length,
      0,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 A：本分支删除目标分支改过的文件 → 仍报 warn", async () => {
  const repo = await createRepo();
  try {
    await writeFile(repo, TARGET, lines(6, "middleware"));
    await commitAll(repo, "feat(ui): 初始中间件");

    // 本分支把文件挪走（`--no-renames` 下就是一次删除）
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await Deno.remove(`${repo}/${TARGET}`);
    await commitAll(repo, "refactor(ui): 迁移中间件");

    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(
      repo,
      TARGET,
      lines(6, "middleware") + "// 目标分支改动\n",
    );
    await commitAll(repo, "fix(ui): 目标分支改动");

    await git(repo, ["checkout", "-q", "feature"]);
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const overwrites = result.findings.filter((finding) =>
      finding.check === "A"
    );
    assertEquals(overwrites.length, 1);
    assertEquals(overwrites[0].level, "warn");
    assertEquals(overwrites[0].path, TARGET);
    assert(
      overwrites[0].detail?.includes("已删除") === true,
      `删除场景应提示"已删除"，实际：${overwrites[0].detail}`,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 A：本分支侧只是新增行 → 降为 info", async () => {
  const repo = await createRepo();
  try {
    await writeFile(repo, TARGET, lines(4, "middleware"));
    await commitAll(repo, "feat(ui): 初始中间件");

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    // 只在末尾追加一行：净删除 0 行，不可能覆盖目标分支的既有逻辑
    await writeFile(
      repo,
      TARGET,
      lines(4, "middleware") + "export const extra = true;\n",
    );
    await commitAll(repo, "feat(ui): 追加一段逻辑");

    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(repo, TARGET, lines(4, "middleware") + "// 目标分支改动\n");
    await commitAll(repo, "fix(ui): 目标分支改动");

    await git(repo, ["checkout", "-q", "feature"]);
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const overwrites = result.findings.filter((finding) =>
      finding.check === "A"
    );
    assertEquals(overwrites.length, 1);
    assertEquals(overwrites[0].level, "info");
    assertEquals(result.ok, true);
  } finally {
    await cleanup(repo);
  }
});

// ── 检查项 B：断链引用 ─────────────────────────────────────────────

Deno.test("检查项 B：导入指向不存在的文件 → error", async () => {
  const repo = await createRepo();
  try {
    // 夹具里的假路径同样拆开拼，避免污染本仓库的自检结果
    const missing = ["..", "..", "..", "noj-ui", "utils", "missing.ts"].join(
      "/",
    );
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "broken.test.ts"),
      `import { gone } from "${missing}";\n`,
    );
    await commitAll(repo, "feat(tests): 加一个断链导入");
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const broken = result.findings.filter((finding) => finding.check === "B");
    assertEquals(broken.length, 1);
    assertEquals(broken[0].level, "error");
    assertEquals(
      broken[0].path,
      fixturePath("noj-tests", "e2e", "browser", "broken.test.ts"),
    );
    assertEquals(result.ok, false);
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 B：导入指向存在的文件 → 不报", async () => {
  const repo = await createRepo();
  try {
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "domain-problems.ts"),
      "export const domainAnswerKey = () => 1;\n",
    );
    const real = ["..", "..", "..", "noj-ui", "utils", "domain-problems.ts"]
      .join("/");
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "good.test.ts"),
      `import { domainAnswerKey } from "${real}";\n`,
    );
    await commitAll(repo, "feat(tests): 加一个正常导入");
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      result.findings.filter((finding) => finding.check === "B").length,
      0,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 B：注释里的旧路径不算引用", async () => {
  const repo = await createRepo();
  try {
    const old = ["..", "..", "noj-ui", "utils", "renamed-away.ts"].join("/");
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "commented.test.ts"),
      [
        `// 旧路径已迁移：${old}`,
        `/* import { a } from "${old}"; */`,
        "export const ok = 1;",
        "",
      ].join("\n"),
    );
    await commitAll(repo, "feat(tests): 注释里留旧路径");
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      result.findings.filter((finding) => finding.check === "B").length,
      0,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 B：非测试文件里的字符串路径 → 只报 warn", async () => {
  const repo = await createRepo();
  try {
    const ghost = fixturePath("scripts", "src", "ghost.ts");
    await writeFile(
      repo,
      fixturePath("scripts", "registry.ts"),
      `export const FILES = ["${ghost}"];\n`,
    );
    await commitAll(repo, "feat(root): 加一个路径常量");
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const broken = result.findings.filter((finding) => finding.check === "B");
    assertEquals(broken.length, 1);
    assertEquals(broken[0].level, "warn");
    assertEquals(result.ok, true);
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检查项 B：测试文件里的字符串夹具不作路径检查", async () => {
  const repo = await createRepo();
  try {
    const fixture = fixturePath("noj-ui", "utils", "written-at-runtime.ts");
    await writeFile(
      repo,
      fixturePath("scripts", "check-something_test.ts"),
      `const FIXTURE = "${fixture}";\nDeno.writeTextFile(FIXTURE, "");\n`,
    );
    await commitAll(repo, "test(root): 加夹具路径测试");
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      result.findings.filter((finding) => finding.check === "B").length,
      0,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("引用抽取：注释、块注释与模板插值都不算引用", () => {
  const topLevel = new Set(["noj-ui"]);
  const source = [
    `// import { a } from "~/utils/old.ts";`,
    `/* const path = "~/utils/gone.ts"; */`,
    "const name = 'x';",
    "const runtime = `~/utils/${name}.ts`;",
    `const kept = "~/utils/real.ts";`,
  ].join("\n");
  const references = extractReferences(source, topLevel);
  assertEquals(references.map((reference) => reference.specifier), [
    "~/utils/real.ts",
  ]);
  assertEquals(references[0].kind, "string");
});

Deno.test("别名解析：~/ 映射到 noj-ui，~~/ 映射到仓库根", () => {
  const topLevel = new Set(["noj-ui", "scripts"]);
  assertEquals(
    resolveSpecifier("~/utils/x.ts", "noj-ui/pages/a.vue", topLevel),
    ["noj-ui/utils/x.ts"],
  );
  assertEquals(
    resolveSpecifier("~~/noj-tests/e2e/a.ts", "noj-ui/pages/a.vue", topLevel),
    ["noj-tests/e2e/a.ts"],
  );
  assertEquals(
    resolveSpecifier("vue", "noj-ui/pages/a.vue", topLevel),
    [],
  );
});

Deno.test("字符串解析：仓库根与模块根两种基准都接受", () => {
  const topLevel = new Set(["noj-ui", "scripts", "noj-tests"]);
  // 相对仓库根不成立、相对模块根 noj-tests/ 才成立的那种字符串（真实案例：
  // noj-tests/scripts/test-runner.ts 里记录自己的命令行为 scripts/xxx.ts）
  const candidates = resolveSpecifier(
    fixturePath("scripts", "test-runner.ts"),
    fixturePath("noj-tests", "scripts", "runner.ts"),
    topLevel,
    "string",
  );
  assert(
    candidates.includes(
      fixturePath("noj-tests", "scripts", "test-runner.ts"),
    ),
    `模块根候选缺失：${JSON.stringify(candidates)}`,
  );
});

Deno.test("断链扫描：内容与存在性都从提交树取（内存树，不碰真实文件系统）", async () => {
  const file = fixturePath("scripts", "x.ts");
  const target = fixturePath("noj-ui", "a.ts");
  const source = `const path = "${target}";\n`;

  const present = await checkBrokenReferences({
    tree: memoryTree({ [file]: source, [target]: "" }),
    files: [file],
  });
  assertEquals(present.broken, []);

  const absent = await checkBrokenReferences({
    // 顶层目录 noj-ui 存在，但目标文件不在树里 → 才算断链。
    tree: memoryTree({
      [file]: source,
      [fixturePath("noj-ui", "other.ts")]: "",
    }),
    files: [file],
  });
  assertEquals(absent.broken.length, 1);
  assertEquals(absent.broken[0].kind, "string");

  // 提交树里没有的文件直接跳过，不算扫描失败（旧路径/重命名旧侧）。
  const skipped = await checkBrokenReferences({
    tree: memoryTree({ [file]: source }),
    files: [fixturePath("scripts", "deleted.ts")],
  });
  assertEquals(skipped.broken, []);
  assertEquals(skipped.stats.skippedFiles, 1);
});

// ── 检查项 C：提交签名 ─────────────────────────────────────────────

Deno.test("检查项 C：无签名提交报 error，--ignore-signatures 可跳过", async () => {
  const repo = await createRepo();
  try {
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(
      repo,
      fixturePath("scripts", "feature.ts"),
      "export const feature = 1;\n",
    );
    await commitAll(repo, "feat(root): 夹具提交");

    const strict = await runChecks({ root: repo, base: "main" });
    const signatureFindings = strict.findings.filter((finding) =>
      finding.check === "C"
    );
    assertEquals(signatureFindings.length, 1);
    assertEquals(signatureFindings[0].level, "error");
    assertEquals(strict.ok, false);

    // 本地/CI 无 GPG 时必须能跑：开关打开后不再报签名
    const skipped = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      skipped.findings.filter((finding) => finding.check === "C").length,
      0,
    );
    assertEquals(skipped.ok, true);
  } finally {
    await cleanup(repo);
  }
});

// ── 检查项 D：提交信息 ─────────────────────────────────────────────

Deno.test("检查项 D：docs(conventions) 的 scope 非法 → warn", () => {
  const verdict = validateCommitMessage("docs(conventions): 补充约定");
  assert(verdict !== null);
  assertEquals(verdict.level, "warn");
  assert(
    verdict.reason.includes("scope 不在白名单"),
    `应指出 scope 非法，实际：${verdict.reason}`,
  );
});

Deno.test("检查项 D：docs(root) 合规", () => {
  assertEquals(validateCommitMessage("docs(root): 补充根目录约定"), null);
});

Deno.test("检查项 D：fix: 缺少 scope → error", () => {
  const verdict = validateCommitMessage("fix: 修个问题");
  assert(verdict !== null);
  assertEquals(verdict.level, "error");
  assert(
    verdict.reason.includes("缺少 scope"),
    `应指出缺少 scope，实际：${verdict.reason}`,
  );
});

Deno.test("检查项 D：多 scope 用逗号分隔且不加空格", () => {
  assertEquals(validateCommitMessage("feat(core,ui): 双模块改动"), null);
  assertEquals(validateCommitMessage("chore(deps): 升级依赖"), null);
  const spaced = validateCommitMessage("feat(core, ui): 双模块改动");
  assert(spaced !== null);
  assertEquals(spaced.level, "warn");
});

// ── CLI 参数 ──────────────────────────────────────────────────────

Deno.test("parseArgs：--base 两种写法与开关", () => {
  assertEquals(parseArgs(["--base", "origin/main", "--json"]), {
    base: "origin/main",
    pushedRefs: null,
    json: true,
    ignoreSignatures: false,
    help: false,
  });
  assertEquals(parseArgs(["--base=main"]).base, "main");
  assertEquals(parseArgs(["--ignore-signatures"]).ignoreSignatures, true);
  assertEquals(parseArgs(["--help"]).help, true);
  assertEquals(parseArgs(["--pushed-refs", "-"]).pushedRefs, "-");
  assertEquals(parseArgs(["--pushed-refs=refs.txt"]).pushedRefs, "refs.txt");
  assertEquals(parseArgs([]), {
    base: null,
    pushedRefs: null,
    json: false,
    ignoreSignatures: false,
    help: false,
  });
  assertThrows(() => parseArgs(["--nope"]), Error, "未知参数");
  assertThrows(() => parseArgs(["--pushed-refs"]), Error, "--pushed-refs");
});

// ── pre-push 输入 ─────────────────────────────────────────────────

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_ZERO = "0".repeat(40);

Deno.test("pre-push 输入：解析多行、忽略空行与 CRLF", () => {
  const refs = parsePushedRefs(
    [
      `refs/heads/a ${SHA_A} refs/heads/a ${SHA_ZERO}`,
      "",
      `refs/heads/b ${SHA_B} refs/heads/b ${SHA_A}`,
      "",
    ].join("\r\n"),
  );
  assertEquals(refs.length, 2);
  assertEquals(refs[0], {
    localRef: "refs/heads/a",
    localSha: SHA_A,
    remoteRef: "refs/heads/a",
    remoteSha: SHA_ZERO,
  });
  assertEquals(refs[1].remoteSha, SHA_A);
});

Deno.test("pre-push 输入：字段数或对象 ID 不合法 → 抛错", () => {
  assertThrows(
    () => parsePushedRefs(`refs/heads/a ${SHA_A}`),
    Error,
    "不是 4 个字段",
  );
  assertThrows(
    () => parsePushedRefs(`refs/heads/a not-a-sha refs/heads/a ${SHA_ZERO}`),
    Error,
    "40/64 位十六进制",
  );
});

// ── pre-push：按待推送引用检查 ────────────────────────────────────

Deno.test("多引用：两个分支一起推，任一引用有 error 即整体失败", async () => {
  const repo = await createRepo();
  try {
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "present.ts"),
      "export const present = 1;\n",
    );
    await commitAll(repo, "feat(ui): 加公共工具");
    const baseSha = await headSha(repo);

    await git(repo, ["checkout", "-q", "-b", "feature-good"]);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "good.test.ts"),
      `import { present } from "../../../noj-ui/utils/present.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 加正常用例");

    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["checkout", "-q", "-b", "feature-bad"]);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "bad.test.ts"),
      `import { gone } from "../../../noj-ui/utils/gone.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 加断链用例");

    const goodSha = await headSha(repo, "feature-good");
    const badSha = await headSha(repo, "feature-bad");
    const refsText = [
      refLine(
        "refs/heads/feature-good",
        goodSha,
        "refs/heads/feature-good",
        baseSha,
      ),
      refLine(
        "refs/heads/feature-bad",
        badSha,
        "refs/heads/feature-bad",
        baseSha,
      ),
    ].join("\n");

    const result = await runPushedRefsChecks({
      root: repo,
      base: "main",
      refsText,
      ignoreSignatures: true,
    });
    assertEquals(result.refs.length, 2);
    assertEquals(result.refs[0].local_ref, "refs/heads/feature-good");
    assertEquals(result.refs[0].ok, true);
    assertEquals(result.refs[0].pushed_commits, 1);
    assertEquals(result.refs[1].local_ref, "refs/heads/feature-bad");
    assertEquals(result.refs[1].ok, false);
    assertEquals(result.ok, false);
    assertEquals(result.summary.error, 1);
    const broken = result.refs[1].findings.filter((finding) =>
      finding.check === "B"
    );
    assertEquals(broken.length, 1);
    assertEquals(
      broken[0].path,
      fixturePath("noj-tests", "e2e", "browser", "bad.test.ts"),
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("检出分支与待推送分支不同：读待推送提交的树，而不是工作区", async () => {
  const repo = await createRepo();
  try {
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "present.ts"),
      "export const present = 1;\n",
    );
    await commitAll(repo, "feat(ui): 加公共工具");
    const baseSha = await headSha(repo);

    await git(repo, ["checkout", "-q", "-b", "feature-bad"]);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "bad.test.ts"),
      `import { gone } from "../../../noj-ui/utils/gone.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 加断链用例");
    const featureSha = await headSha(repo);

    // 关键：切回 main。工作区里没有 feature 的测试文件（旧实现会漏掉它）。
    await git(repo, ["checkout", "-q", "main"]);

    const result = await runPushedRefsChecks({
      root: repo,
      base: "main",
      refsText: refLine(
        "refs/heads/feature-bad",
        featureSha,
        "refs/heads/feature-bad",
        baseSha,
      ),
      ignoreSignatures: true,
    });
    const broken = result.refs[0].findings.filter((finding) =>
      finding.check === "B"
    );
    assertEquals(broken.length, 1);
    assertEquals(
      broken[0].path,
      fixturePath("noj-tests", "e2e", "browser", "bad.test.ts"),
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("工作区有未提交改动：内容与存在性仍以提交树为准", async () => {
  const repo = await createRepo();
  try {
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "present.ts"),
      "export const present = 1;\n",
    );
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "case.test.ts"),
      `import { present } from "../../../noj-ui/utils/present.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 初始用例");

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    const ghost = fixturePath("noj-ui", "utils", "ghost.ts");
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "case.test.ts"),
      `import { ghost } from "../../../noj-ui/utils/ghost.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 引用一个还不存在的文件");

    // 工作区里新建 ghost.ts：按工作区判存在会误判为"引用正常"。
    await writeFile(repo, ghost, "export const ghost = 1;\n");

    const committed = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const broken = committed.findings.filter((finding) =>
      finding.check === "B"
    );
    assertEquals(broken.length, 1);
    assertEquals(committed.ok, false);

    // 再把工作区里的用例改回正确导入（未提交）：提交树仍然断链，不能变绿。
    await Deno.remove(`${repo}/${ghost}`);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "case.test.ts"),
      `import { present } from "../../../noj-ui/utils/present.ts";\n`,
    );
    const stillBroken = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      stillBroken.findings.filter((finding) => finding.check === "B").length,
      1,
    );

    // 反过来：干净提交 + 工作区里写坏导入，不应报断链。
    await git(repo, ["checkout", "-q", "--", "."]);
    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "case.test.ts"),
      `import { ghost } from "../../../noj-ui/utils/ghost.ts";\n`,
    );
    const dirtyOnly = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    assertEquals(
      dirtyOnly.findings.filter((finding) => finding.check === "B").length,
      0,
    );
  } finally {
    await cleanup(repo);
  }
});

Deno.test("新分支（remote-sha 全 0）：只检查远端跟踪引用之外的新增提交", async () => {
  const repo = await createRepo();
  try {
    const baseSha = await headSha(repo);
    // 没有真实远端时的替代：手动造一个 origin/main 跟踪引用。
    await git(repo, ["update-ref", "refs/remotes/origin/main", baseSha]);

    await git(repo, ["checkout", "-q", "-b", "feature-new"]);
    await writeFile(
      repo,
      fixturePath("scripts", "feature.ts"),
      "export const feature = 1;\n",
    );
    await commitAll(repo, "wip");
    const featureSha = await headSha(repo);

    const result = await runPushedRefsChecks({
      root: repo,
      base: "main",
      refsText: refLine(
        "refs/heads/feature-new",
        featureSha,
        "refs/heads/feature-new",
        SHA_ZERO,
      ),
      ignoreSignatures: true,
    });
    const ref = result.refs[0];
    assertEquals(ref.pushed_commits, 1);
    const messages = ref.findings.filter((finding) => finding.check === "D");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].sha, featureSha.slice(0, 7));
    assertEquals(ref.summary.error, 0);
    assertEquals(result.ok, true);
  } finally {
    await cleanup(repo);
  }
});

Deno.test("已合并到 base 的引用：跳过检查并给出说明", async () => {
  const repo = await createRepo();
  try {
    const mainSha = await headSha(repo);
    await git(repo, ["checkout", "-q", "-b", "already-merged"]);
    await writeFile(
      repo,
      fixturePath("scripts", "merged.ts"),
      "export const merged = 1;\n",
    );
    await commitAll(repo, "feat(root): 已合并的提交");
    const featureSha = await headSha(repo);
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["merge", "-q", "--ff-only", "already-merged"]);

    const result = await runPushedRefsChecks({
      root: repo,
      base: "main",
      refsText: refLine(
        "refs/heads/already-merged",
        featureSha,
        "refs/heads/already-merged",
        mainSha,
      ),
      ignoreSignatures: true,
    });
    assertEquals(result.refs[0].ok, true);
    assert(result.refs[0].note?.includes("已包含") === true);
    assertEquals(result.refs[0].findings.length, 0);
  } finally {
    await cleanup(repo);
  }
});

Deno.test("CLI：--pushed-refs - 从 stdin 读取引用并以退出码汇总", async () => {
  const repo = await createRepo();
  try {
    await writeFile(
      repo,
      fixturePath("noj-ui", "utils", "present.ts"),
      "export const present = 1;\n",
    );
    await commitAll(repo, "feat(ui): 加公共工具");
    const baseSha = await headSha(repo);

    await git(repo, ["checkout", "-q", "-b", "feature-bad"]);
    await writeFile(
      repo,
      fixturePath("noj-tests", "e2e", "browser", "bad.test.ts"),
      `import { gone } from "../../../noj-ui/utils/gone.ts";\n`,
    );
    await commitAll(repo, "feat(tests): 加断链用例");
    const featureSha = await headSha(repo);

    const script = fileURLToPath(
      new URL("./check-branch-safety.ts", import.meta.url),
    );
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        script,
        "--pushed-refs",
        "-",
        "--base",
        "main",
        "--ignore-signatures",
        "--json",
      ],
      cwd: repo,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        refLine(
          "refs/heads/feature-bad",
          featureSha,
          "refs/heads/feature-bad",
          baseSha,
        ) + "\n",
      ),
    );
    await writer.close();
    const output = await child.output();
    const stdout = new TextDecoder().decode(output.stdout);

    assertEquals(output.code, 1, stdout);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      refs: { findings: { check: string }[] }[];
    };
    assertEquals(parsed.ok, false);
    assertEquals(
      parsed.refs[0].findings.some((finding) => finding.check === "B"),
      true,
    );
  } finally {
    await cleanup(repo);
  }
});

// ── pre-push 钩子（真实 git push，deno 用假程序替代） ─────────────

Deno.test({
  name: "hook：当前分支没有 check:branch-safety 任务 → 打印一行并放行",
  ignore: !HAS_NODE,
  async fn() {
    const repo = await createRepo();
    const remote = await createRemote(repo);
    try {
      await git(repo, ["push", "-q", "origin", "main"]);
      await installHooks(repo);

      // 切到一个没有该任务的分支：钩子仍装在同一处（.git/hooks 共享）。
      await git(repo, ["checkout", "-q", "-b", "old-branch"]);
      await writeFile(
        repo,
        fixturePath("scripts", "old.ts"),
        "export const old = 1;\n",
      );
      await commitAll(repo, "feat(root): 旧分支提交");

      const push = await gitResult(repo, ["push", "origin", "old-branch"]);
      assertEquals(push.code, 0, push.stderr);
      assert(
        push.stderr.includes("没有 check:branch-safety 任务"),
        `应打印跳过说明，实际 stderr：${push.stderr}`,
      );
    } finally {
      await cleanup(repo);
      await cleanup(remote);
    }
  },
});

Deno.test({
  name: "hook：一次推两个分支时把两行 stdin 交给检查器，并按退出码阻断",
  ignore: !HAS_NODE,
  async fn() {
    const repo = await createRepoWithTask();
    const remote = await createRemote(repo);
    const fakeDir = await Deno.makeTempDir({ prefix: "noj-fake-deno-" });
    const captureArgs = `${fakeDir}/args.txt`;
    const captureStdin = `${fakeDir}/stdin.txt`;
    try {
      await git(repo, ["push", "-q", "origin", "main"]);
      await installHooks(repo);

      for (const branch of ["branch-a", "branch-b"]) {
        await git(repo, ["checkout", "-q", "main"]);
        await git(repo, ["checkout", "-q", "-b", branch]);
        await writeFile(
          repo,
          fixturePath("scripts", `${branch}.ts`),
          `export const value = 1;\n`,
        );
        await commitAll(repo, "feat(root): 夹具分支");
      }

      await createFakeDeno(fakeDir);
      const env = {
        ...Deno.env.toObject(),
        PATH: prependPath(fakeDir, Deno.env.get("PATH")),
        NOJ_FAKE_ARGS: captureArgs.replace(/\\/g, "/"),
        NOJ_FAKE_STDIN: captureStdin.replace(/\\/g, "/"),
        NOJ_FAKE_EXIT: "1",
      };
      const failed = await gitResult(
        repo,
        ["push", "origin", "branch-a", "branch-b"],
        env,
      );
      assertEquals(failed.code, 1, `pre-push 应该阻断：${failed.stderr}`);

      const stdin = await Deno.readTextFile(captureStdin);
      const lines = stdin.split("\n").filter((line) => line.trim() !== "");
      assertEquals(lines.length, 2);
      assert(lines.some((line) => line.startsWith("refs/heads/branch-a ")));
      assert(lines.some((line) => line.startsWith("refs/heads/branch-b ")));
      assert(
        lines.every((line) => line.includes(" " + SHA_ZERO)),
        `新分支的 remote-sha 应为全 0：${stdin}`,
      );

      const args = await Deno.readTextFile(captureArgs);
      assert(args.includes("check:branch-safety"), args);
      assert(args.includes("--pushed-refs"), args);
      assert(args.split("\n").includes("-"), args);

      // 同一钩子返回 0 时应放行。
      const passed = await gitResult(
        repo,
        ["push", "origin", "branch-a", "branch-b"],
        { ...env, NOJ_FAKE_EXIT: "0" },
      );
      assertEquals(passed.code, 0, passed.stderr);
    } finally {
      await cleanup(repo);
      await cleanup(remote);
      await cleanup(fakeDir);
    }
  },
});

Deno.test({
  name: "install-git-hooks：worktree 里安装时写入公共 hooks 目录",
  ignore: !HAS_NODE,
  async fn() {
    const repo = await createRepo();
    const base = await Deno.makeTempDir({ prefix: "noj-git-hooks-wt-" });
    const worktree = `${base}/wt`;
    try {
      await git(repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        "wt-branch",
        worktree.replace(/\\/g, "/"),
      ]);
      const source = fileURLToPath(
        new URL("./install-git-hooks.mjs", import.meta.url),
      );
      await Deno.mkdir(`${worktree}/scripts`, { recursive: true });
      await Deno.copyFile(source, `${worktree}/scripts/install-git-hooks.mjs`);

      const output = await new Deno.Command("node", {
        args: [`${worktree}/scripts/install-git-hooks.mjs`],
        cwd: worktree,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        output.code,
        0,
        new TextDecoder().decode(output.stderr),
      );

      const hook = await Deno.readTextFile(`${repo}/.git/hooks/pre-push`);
      assert(hook.includes("--pushed-refs -"), hook);
    } finally {
      await git(repo, [
        "worktree",
        "remove",
        "--force",
        worktree.replace(/\\/g, "/"),
      ]).catch(() => {});
      await cleanup(base);
      await cleanup(repo);
    }
  },
});

Deno.test("检查项 B：含点号的无扩展名导入（.post/.global/.xml）继续探测源码后缀", async () => {
  const tree = memoryTree({
    "noj-ui/tests/server/AuthCookies.spec.ts": [
      `const a = await import("~/server/api/auth/logout.post");`,
      `const b = await import("~/middleware/default-workspace.global");`,
      `const c = await import("~/server/routes/sitemap.xml");`,
      `const d = await import("~/server/api/auth/missing.post");`,
    ].join("\n"),
    "noj-ui/server/api/auth/logout.post.ts": "export default () => {};\n",
    "noj-ui/middleware/default-workspace.global.ts":
      "export default () => {};\n",
    "noj-ui/server/routes/sitemap.xml.ts": "export default () => {};\n",
  });

  const { broken } = await checkBrokenReferences({
    tree,
    files: ["noj-ui/tests/server/AuthCookies.spec.ts"],
  });
  assertEquals(broken.length, 1);
  assertEquals(broken[0].specifier, "~/server/api/auth/missing.post");
});

Deno.test("检查项 A：core.abbrev=4 时仍以完整哈希解析目标分支历史", async () => {
  const repo = await createRepo();
  try {
    await git(repo, ["config", "core.abbrev", "4"]);
    await writeFile(repo, TARGET, lines(8, "middleware"));
    await commitAll(repo, "feat(ui): 初始中间件");

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(repo, TARGET, lines(3, "middleware"));
    await commitAll(repo, "feat(ui): 改写中间件");

    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(repo, TARGET, lines(8, "middleware") + "// main 新增\n");
    await commitAll(repo, "fix(ui): main 侧补丁");

    await git(repo, ["checkout", "-q", "feature"]);
    const result = await runChecks({
      root: repo,
      base: "main",
      ignoreSignatures: true,
    });
    const overwrites = result.findings.filter((finding) =>
      finding.check === "A"
    );
    assertEquals(overwrites.length, 1);
    assertEquals(overwrites[0].path, TARGET);
  } finally {
    await cleanup(repo);
  }
});
