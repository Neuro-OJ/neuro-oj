/**
 * `noj-cli problem` 子命令（#514）。
 *
 * 三种模式：TUI 引导（默认）、`--no-interactive`（自动化）、`--json`（机器可读）。
 * 退出码遵循 #517 的分层：0 通过 / 1 校验失败 / 2 用法错误。
 */
import { dirname, join, relative, resolve } from "@std/path";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../exit_codes.ts";
import { UsageError } from "../util/args.ts";
import { type BundleFiles, lintBundle, type LintFinding } from "./lint.ts";
import { packBundle } from "./pack.ts";
import { initProblemScaffold, validateSlug } from "./init.ts";
import {
  normalizeServer,
  parsePushTarget,
  pushBundle,
  PushError,
  pushErrorHint,
  type PushResult,
  resolveToken,
} from "./push.ts";
import { guideProblemInit } from "./tui.ts";
import { realIO } from "../tui/io.ts";
import { zipSync } from "fflate";

/** problem 子命令选项。 */
export interface ProblemArgs {
  sub: string;
  /** 目标目录（lint/pack 的位置参数）。 */
  dir?: string;
  /** pack 输出目录。 */
  out?: string;
  /** lint: SHOULD 计入退出码。 */
  strict: boolean;
  /** 机器可读输出。 */
  json: boolean;
  /** init: 跳过 TUI 引导。 */
  noInteractive: boolean;
  /** init 选项。 */
  slug?: string;
  title?: string;
  type?: string;
  difficulty?: string;
  judgeType?: "dual" | "oi";
  /** push: 平台地址（缺省读 NOJ_SERVER）。 */
  server?: string;
  /** push: 导入后立即发布。 */
  publish: boolean;
  /** push: 目标题目（题号或 ID），更新既有题目而非新建（仅单个题包时可用）。 */
  problem?: string;
  /** push: 全部位置参数（`路径` 或 `路径=题号`），一次登录依次推送。 */
  targets?: string[];
}

/** 解析 problem 子命令参数。 */
export function parseProblemArgs(args: string[]): ProblemArgs {
  const out: ProblemArgs = {
    sub: args[0] ?? "",
    strict: false,
    json: false,
    noInteractive: false,
    publish: false,
  };
  const positional: string[] = [];
  const takeValue = (name: string, i: number): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${name} 需要一个值`);
    }
    return v;
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--out":
        out.out = takeValue("--out", i);
        i++;
        break;
      case "--dir":
        // init 用 --dir 指定输出根目录；lint/pack 用位置参数或本选项
        out.dir = takeValue("--dir", i);
        i++;
        break;
      case "--title":
        out.title = takeValue("--title", i);
        i++;
        break;
      case "--type":
        out.type = takeValue("--type", i);
        i++;
        break;
      case "--difficulty":
        out.difficulty = takeValue("--difficulty", i);
        i++;
        break;
      case "--judge-type": {
        const value = takeValue("--judge-type", i);
        if (value !== "dual" && value !== "oi") {
          throw new UsageError("--judge-type 仅支持 dual/oi");
        }
        out.judgeType = value;
        i++;
        break;
      }
      case "--server":
        out.server = takeValue("--server", i);
        i++;
        break;
      case "--publish":
        out.publish = true;
        break;
      case "--problem":
        out.problem = takeValue("--problem", i);
        i++;
        break;
      case "--strict":
        out.strict = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--no-interactive":
        out.noInteractive = true;
        break;
      default:
        if (a.startsWith("--")) {
          throw new UsageError(`未知选项: ${a}`);
        }
        positional.push(a);
    }
  }
  if (positional.length > 0) out.slug = positional[0];
  // init 的第一个位置参数是 slug，lint/pack 的是 dir。
  //
  // **只有位置参数存在时才覆盖 --dir**（评审修正）：早先无条件赋值，
  // 使 `problem lint --dir <别的题包>` 把 out.dir 覆盖成 undefined，
  // 随后静默回落到 cwd 并返回 0——既忽略用户显式指定的目录，
  // 又给出假阳性结果（校验/打包的其实是当前目录）。
  if (out.sub === "lint" || out.sub === "pack" || out.sub === "push") {
    if (positional.length > 0) out.dir = positional[0];
    out.slug = undefined;
  }
  if (out.sub === "push") out.targets = positional;
  return out;
}

/** 目录存在且确为目录。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** 读取题目包目录为文件快照（文本文件进 texts，全部条目进 names）。 */
export async function readBundleFiles(dir: string): Promise<BundleFiles> {
  const texts: Record<string, string> = {};
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function walk(current: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "__pycache__" || entry.name === ".git") continue;
        await walk(join(current, entry.name), rel);
        continue;
      }
      if (!entry.isFile) continue;
      names.push(rel);
      try {
        const bytes = await Deno.readFile(join(current, entry.name));
        texts[rel] = decoder.decode(bytes);
      } catch {
        // 二进制文件：只登记名字，不读内容
      }
    }
  }

  await walk(dir, "");
  return { texts, names: names.sort() };
}

/** 渲染人类可读的 lint 报告。 */
export function formatLintReport(findings: LintFinding[]): string {
  if (findings.length === 0) return "校验通过：未发现问题。";
  const errors = findings.filter((f) => f.level === "error");
  const warns = findings.filter((f) => f.level === "warn");
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`错误（${errors.length}）:`);
    for (const f of errors) {
      lines.push(`  [${f.rule}] ${f.file ?? "-"}: ${f.message}`);
    }
  }
  if (warns.length > 0) {
    lines.push(`警告（${warns.length}）:`);
    for (const f of warns) {
      lines.push(`  [${f.rule}] ${f.file ?? "-"}: ${f.message}`);
    }
  }
  return lines.join("\n");
}

/** 执行 `problem lint`。 */
export async function runProblemLint(args: ProblemArgs): Promise<number> {
  const dir = resolve(args.dir ?? Deno.cwd());
  if (!(await isDirectory(dir))) {
    throw new UsageError(`目录不存在或不是目录：${dir}`);
  }
  const files = await readBundleFiles(dir);
  const report = lintBundle(files);

  const failed = report.hasError || (args.strict && report.hasWarn);
  if (args.json) {
    console.log(JSON.stringify(
      {
        pass: !failed,
        dir,
        strict: args.strict,
        findings: report.findings,
      },
      null,
      2,
    ));
  } else {
    console.log(formatLintReport(report.findings));
    if (report.hasWarn && !args.strict) {
      console.log("提示: 警告不影响退出码；用 --strict 可将其计入。");
    }
  }
  return failed ? EXIT_FAILURE : EXIT_OK;
}

/**
 * 从题目目录路径取产物 slug（最后一段目录名）。
 *
 * 平台无关：Windows 路径（`C:\work\a-plus-b`）与 POSIX 路径（`/w/a-plus-b`）
 * 都得到 `a-plus-b`。评审 P1：早先用 `dir.split("/")`，在 Windows 上会把
 * 整条路径当成 slug，`join(outDir, slug + ".zip")` 因而写入错误位置。
 */
export function bundleSlug(dir: string): string {
  // 同时按两种分隔符切分并丢弃空段：既兼容宿主平台，也兼容跨平台传入的路径。
  const parts = dir.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  // 盘符根（如 "C:"）不构成合法 slug，回退到稳定默认名。
  if (last === undefined || /^[A-Za-z]:$/.test(last)) return "bundle";
  return last;
}

/** 目录打包结果：lint 报告 + 打包产物（lint 有错误时为 null，不产出包）。 */
export interface DirectoryPackResult {
  report: ReturnType<typeof lintBundle>;
  pack: ReturnType<typeof packBundle> | null;
}

/**
 * 校验并打包题目目录（`problem pack` 与 `problem push` 共用）。
 *
 * 打包前先 lint：有错误直接返回、不产出包，避免产出/上传不可导入的包。
 */
export async function packDirectory(dir: string): Promise<DirectoryPackResult> {
  if (!(await isDirectory(dir))) {
    throw new UsageError(`目录不存在或不是目录：${dir}`);
  }
  const report = lintBundle(await readBundleFiles(dir));
  if (report.hasError) return { report, pack: null };

  const entries: Record<string, Uint8Array> = {};
  async function collect(current: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "__pycache__" || entry.name === ".git") continue;
        await collect(join(current, entry.name), rel);
        continue;
      }
      if (!entry.isFile) continue;
      entries[rel] = await Deno.readFile(join(current, entry.name));
    }
  }
  await collect(dir, "");
  // 注意：模板文件（manifest.template，缺省 template.py）**保留在包内**——
  // 平台导入题目包时从这里取编辑器初始代码，不再依赖服务器本地 problems-src。
  return { report, pack: packBundle({ entries }) };
}

/** 执行 `problem pack`。 */
export async function runProblemPack(args: ProblemArgs): Promise<number> {
  const dir = resolve(args.dir ?? Deno.cwd());
  const { report, pack: result } = await packDirectory(dir);
  if (!result) {
    console.error(formatLintReport(report.findings));
    return EXIT_FAILURE;
  }

  const outDir = resolve(args.out ?? join(dirname(dir), "packages"));
  await Deno.mkdir(outDir, { recursive: true });
  // 产物以**题目目录名（slug）**命名，而非父目录名——父目录是所有题共享的根。
  // 评审 P1（Windows）：必须 path-aware，不能用 dir.split("/")——
  // Windows 上 resolve 返回反斜杠路径（C:\work\problems\a-plus-b），
  // 按 "/" 切分会把整条路径当成 slug，产物名与输出位置都会出错。
  const slug = bundleSlug(dir);
  const outFile = join(outDir, `${slug}.zip`);
  await Deno.writeFile(outFile, result.data);

  if (args.json) {
    console.log(JSON.stringify(
      {
        pass: true,
        output: outFile,
        bytes: result.data.length,
        included: result.included,
        excluded: result.excluded,
      },
      null,
      2,
    ));
  } else {
    console.log(`已打包: ${outFile}（${result.data.length} 字节）`);
    console.log(
      `  包含 ${result.included.length} 个条目，排除 ${result.excluded.length} 个`,
    );
    for (const name of result.excluded) console.log(`    - ${name}`);
  }
  return EXIT_OK;
}

/** 读取一个推送目标：.zip 原样读取；目录先 lint 再内存打包（有错误返回 null）。 */
async function loadPushBundle(
  path: string,
): Promise<{ name: string; data: Uint8Array } | null> {
  const target = resolve(path);
  if (target.toLowerCase().endsWith(".zip")) {
    try {
      return { name: bundleSlug(target), data: await Deno.readFile(target) };
    } catch {
      throw new UsageError(`无法读取题目包：${target}`);
    }
  }
  const { report, pack } = await packDirectory(target);
  if (!pack) {
    console.error(`${target}：`);
    console.error(formatLintReport(report.findings));
    return null;
  }
  return { name: `${bundleSlug(target)}.zip`, data: pack.data };
}

/** 单个推送目标的结果（`--json` 输出）。 */
type PushOutcome =
  & { target: string; pass: boolean }
  & Partial<PushResult>
  & { status?: number; code?: string; error?: string; hint?: string | null };

/**
 * 执行 `problem push`：校验打包（或直接读取 .zip）后推送到平台。
 *
 * 位置参数可以有多个：`路径` 新建题目，`路径=题号` 更新该题；全部题包先完成本地
 * 校验（任一失败则不上传），然后**只登录一次**依次推送，单个失败不影响其余。
 */
export async function runProblemPush(args: ProblemArgs): Promise<number> {
  const server = args.server ?? Deno.env.get("NOJ_SERVER");
  if (!server) {
    throw new UsageError(
      "problem push: 需要 --server <平台地址>（或设置 NOJ_SERVER），例如 --server https://noj.example.com",
    );
  }
  // 先校验地址（非本机必须 HTTPS），再读目录/打包：用法错误应尽早失败
  normalizeServer(server);

  const rawTargets = args.targets?.length ? args.targets : [Deno.cwd()];
  if (args.problem && rawTargets.length > 1) {
    throw new UsageError(
      "--problem 只能配合单个题包使用；推送多个题包时请写成 路径=题号",
    );
  }
  const targets = rawTargets.map((raw) => {
    const t = parsePushTarget(raw);
    return rawTargets.length === 1 && args.problem
      ? { ...t, problem: args.problem }
      : t;
  });

  // 全部题包先在本地校验 / 打包：任何一个有问题都不上传，避免推了一半
  const bundles: { name: string; data: Uint8Array }[] = [];
  for (const t of targets) {
    const bundle = await loadPushBundle(t.path);
    if (!bundle) return EXIT_FAILURE;
    bundles.push(bundle);
  }

  const interactive = !args.noInteractive && Deno.stdin.isTerminal();
  const deps = {
    fetch,
    io: interactive ? realIO() : null,
    envToken: Deno.env.get("NOJ_TOKEN"),
  };
  const outcomes: PushOutcome[] = [];
  const report = (outcome: PushOutcome, isUpdate = false) => {
    outcomes.push(outcome);
    if (args.json) return;
    if (outcome.pass) {
      const label = outcome.display_id ?? outcome.id;
      const state = outcome.published
        ? (outcome.published.unchanged
          ? `内容未变化，沿用 V${outcome.published.version}`
          : `已发布 V${outcome.published.version}`)
        : "草稿，核对后发布即可作答";
      console.log(
        `${isUpdate ? "已更新" : "已导入"} ${label}${
          outcome.title ? `《${outcome.title}》` : ""
        }（${state}）`,
      );
      console.log(`  编辑页：${outcome.edit_url}`);
    } else {
      console.error(`推送失败（${outcome.target}）：${outcome.error}`);
      if (outcome.hint) console.error(`  提示：${outcome.hint}`);
    }
  };
  const failure = (target: string, err: PushError): PushOutcome => ({
    target,
    pass: false,
    status: err.status,
    code: err.code,
    error: err.message,
    hint: pushErrorHint(err),
  });

  let token: string;
  try {
    token = await resolveToken(server, deps);
  } catch (err) {
    if (!(err instanceof PushError)) throw err;
    report(failure("登录", err));
    if (args.json) printPushJson(outcomes);
    return EXIT_FAILURE;
  }

  for (const [i, t] of targets.entries()) {
    try {
      const result = await pushBundle(
        {
          server,
          bundle: bundles[i]!,
          publish: args.publish,
          problem: t.problem,
        },
        { ...deps, envToken: token },
      );
      report({ target: t.path, pass: true, ...result }, !!t.problem);
    } catch (err) {
      if (!(err instanceof PushError)) throw err;
      report(failure(t.path, err));
    }
  }
  if (args.json) printPushJson(outcomes);
  return outcomes.every((o) => o.pass) ? EXIT_OK : EXIT_FAILURE;
}

/** `--json`：单个目标输出对象（与旧格式一致），多个目标输出 `{pass, results}`。 */
function printPushJson(outcomes: PushOutcome[]): void {
  const body = outcomes.length === 1
    ? outcomes[0]
    : { pass: outcomes.every((o) => o.pass), results: outcomes };
  console.log(JSON.stringify(body, null, 2));
}

/**
 * 执行 `problem init`。
 *
 * 双模式（issue #514 P6）：
 * - **TUI 引导**（默认，stdin 是 TTY 且未给 `--no-interactive`）：
 *   复用既有 PromptIO/widgets，缺什么问什么，全部带默认值；
 * - **自动化**（`--no-interactive` 或非 TTY）：不提问，缺参直接报用法错误。
 *
 * 参数/取值错误一律返回 `EXIT_USAGE`(2)，与运行失败区分（#517 E9）。
 */
export async function runProblemInit(args: ProblemArgs): Promise<number> {
  const interactive = !args.noInteractive && Deno.stdin.isTerminal();

  let answers: {
    slug?: string;
    title?: string;
    type?: string;
    difficulty?: string;
    judgeType?: "dual" | "oi";
  } = {
    slug: args.slug,
    title: args.title,
    type: args.type,
    difficulty: args.difficulty,
    judgeType: args.judgeType,
  };

  if (interactive) {
    try {
      answers = {
        ...(await guideProblemInit(realIO(), answers)),
        judgeType: args.judgeType,
      };
    } catch (err) {
      // 用户在确认环节取消：不是错误，用 0 退出（与常见 CLI 一致）
      if ((err as Error).message === "已取消") {
        console.log("已取消。");
        return EXIT_OK;
      }
      throw err;
    }
  }

  const slug = answers.slug;
  if (!slug) {
    console.error(
      "problem init: 需要 <slug>（例如 noj-cli problem init a-plus-b --type P）",
    );
    return EXIT_USAGE;
  }

  // 参数/取值非法属**用法错误**（退出码 2），而非运行失败
  try {
    validateSlug(slug);
    if (
      answers.type !== undefined && answers.type !== "U" && answers.type !== "P"
    ) {
      throw new UsageError(`--type 仅支持 U/P，收到 "${answers.type}"`);
    }
    if (
      answers.difficulty !== undefined &&
      !["easy", "medium", "hard"].includes(answers.difficulty)
    ) {
      throw new UsageError(
        `--difficulty 仅支持 easy/medium/hard，收到 "${answers.difficulty}"`,
      );
    }
    if (
      answers.judgeType !== undefined &&
      answers.judgeType !== "dual" && answers.judgeType !== "oi"
    ) {
      throw new UsageError(
        `--judge-type 仅支持 dual/oi，收到 "${answers.judgeType}"`,
      );
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError((err as Error).message);
  }

  const result = await initProblemScaffold({
    slug,
    title: answers.title,
    type: answers.type,
    difficulty: answers.difficulty,
    judgeType: answers.judgeType,
    root: args.dir,
  });
  console.log(`已生成题目骨架：${result.dir}`);
  for (const f of result.files) console.log(`  + ${f}`);
  console.log(
    `\n下一步：补齐题面/判分/用例，然后运行 noj-cli problem lint ${result.dir}`,
  );
  return EXIT_OK;
}

/** 分发 `problem <子命令>`。 */
export async function runProblem(args: ProblemArgs): Promise<number> {
  switch (args.sub) {
    case "lint":
      return await runProblemLint(args);
    case "pack":
      return await runProblemPack(args);
    case "init":
      return await runProblemInit(args);
    case "push":
      return await runProblemPush(args);
    default:
      console.error("problem: 需要子命令 init/lint/pack/push");
      console.error("运行 'noj-cli problem --help' 查看用法。");
      return EXIT_USAGE;
  }
}

/** 相对路径工具（供测试与调试）。 */
export function relPath(from: string, to: string): string {
  return relative(from, to);
}
export { zipSync };
