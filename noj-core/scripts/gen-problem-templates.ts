/**
 * 题目模板嵌入生成器（P0-2 B）。
 *
 * 模板的**事实源**是 `scripts/problem-templates/<name>/` 下的真实目录（可直接
 * `noj-cli problem test`）；本脚本把它们嵌入为无依赖的纯数据模块
 * `scripts/problem-templates.generated.ts`，供 `noj problems init --template` 与
 * `noj-cli problem init --template` 共用（noj-cli 以 `deno compile` 单二进制分发，
 * 运行时读不到仓库文件，必须嵌入）。
 *
 * 用法：
 *   deno run -A noj-core/scripts/gen-problem-templates.ts          # 重新生成
 *   deno run -A noj-core/scripts/gen-problem-templates.ts --check  # CI：漂移即失败
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(SCRIPTS_DIR, "problem-templates");
export const GENERATED_PATH = join(
  SCRIPTS_DIR,
  "problem-templates.generated.ts",
);

/** 不嵌入的条目（缓存与系统文件）。 */
const SKIPPED = new Set(["__pycache__", ".DS_Store", ".pytest_cache"]);

/**
 * 读取一个目录树：相对路径（POSIX 分隔）→ UTF-8 文本。
 *
 * 也供 noj-cli 的出题 Skill 嵌入生成器复用。
 */
export async function readTextTree(
  dir: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile) {
        const rel = relative(dir, path).split("\\").join("/");
        try {
          out[rel] = decoder.decode(await Deno.readFile(path));
        } catch {
          throw new Error(`模板文件必须是 UTF-8 文本：${path}`);
        }
      } else {
        throw new Error(`模板中不允许符号链接等特殊条目：${path}`);
      }
    }
  }
  await walk(dir);
  return out;
}

/** 收集全部模板（按名称与路径排序，保证输出稳定）。 */
export async function collectTemplates(
  root = TEMPLATES_DIR,
): Promise<Record<string, Record<string, string>>> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory && !SKIPPED.has(entry.name)) names.push(entry.name);
  }
  names.sort();
  const out: Record<string, Record<string, string>> = {};
  for (const name of names) {
    const files = await readTextTree(join(root, name));
    out[name] = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    );
  }
  return out;
}

/** 渲染生成模块源码（未经 deno fmt）。 */
export function renderModule(
  templates: Record<string, Record<string, string>>,
): string {
  const lines = [
    "// 由 noj-core/scripts/gen-problem-templates.ts 生成，请勿手改。",
    "// 事实源：noj-core/scripts/problem-templates/<name>/；改模板后重新运行生成器。",
    "",
    "/** 模板名 → 相对路径 → 文件内容。 */",
    "export const PROBLEM_TEMPLATE_FILES: Readonly<",
    "  Record<string, Readonly<Record<string, string>>>",
    "> = {",
  ];
  for (const [name, files] of Object.entries(templates)) {
    lines.push(`  ${JSON.stringify(name)}: {`);
    for (const [path, content] of Object.entries(files)) {
      lines.push(`    ${JSON.stringify(path)}: ${JSON.stringify(content)},`);
    }
    lines.push("  },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** 用 deno fmt 规范化源码，使生成结果与仓库格式检查一致。 */
export async function formatTs(source: string): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext", "ts", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const out = await child.output();
  if (!out.success) {
    throw new Error(`deno fmt 失败：${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

/** 生成（或校验）嵌入模块；返回是否与磁盘一致。 */
export async function generate(check: boolean): Promise<boolean> {
  const source = await formatTs(renderModule(await collectTemplates()));
  let current: string | null = null;
  try {
    current = await Deno.readTextFile(GENERATED_PATH);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (current === source) return true;
  if (!check) await Deno.writeTextFile(GENERATED_PATH, source);
  return false;
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const same = await generate(check);
  if (check && !same) {
    console.error(
      "problem-templates.generated.ts 与 scripts/problem-templates/ 不一致，" +
        "请运行 deno run -A noj-core/scripts/gen-problem-templates.ts 后提交",
    );
    Deno.exit(1);
  }
  console.log(
    same
      ? "题目模板嵌入模块已是最新"
      : "已重新生成 problem-templates.generated.ts",
  );
}
