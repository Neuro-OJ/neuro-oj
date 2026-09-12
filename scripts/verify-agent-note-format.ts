// Agent Note 格式校验。
// 检查 .agents/notes 下 implemented 记录的分类、路径、状态行和必需章节。

/** 允许的 Agent Note 分类。 */
export const AGENT_NOTE_CLASSES = [
  "feature",
  "bug-fix",
  "simplification",
  "architecture",
  "process",
  "testing",
] as const;

/** implemented 记录必须包含的章节。 */
const REQUIRED_SECTIONS_IMPLEMENTED = [
  "## Problem",
  "## Decision",
  "## Alternatives considered",
  "## Consequences",
] as const;

/** implemented 记录禁止出现的章节。 */
const FORBIDDEN_SECTIONS_IMPLEMENTED = [
  "## Proposal",
  "## Plan",
  "## Migration plan",
  "## Acceptance criteria",
] as const;

/** 校验 Agent Note 相对路径（如 implemented/process/2026-08-28-x.md）。 */
export function verifyAgentNotePath(relativePath: string): string[] {
  const errors: string[] = [];
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length !== 3) {
    errors.push("路径格式应为 implemented/<分类>/yyyy-mm-dd-topic.md");
    return errors;
  }

  if (parts[0] !== "implemented") {
    errors.push("当前仅支持 implemented 目录");
  }

  const cls = parts[1];
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(cls)) {
    errors.push(`分类不在白名单: ${cls}`);
  }

  const filename = parts[2];
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(filename)) {
    errors.push(`文件名不符合 yyyy-mm-dd-topic-title.md: ${filename}`);
  }

  return errors;
}

/** 校验单个 Agent Note 文件内容。 */
export function verifyAgentNote(filePath: string): string[] {
  const errors: string[] = [];
  let text: string;
  try {
    text = Deno.readTextFileSync(filePath);
  } catch (err) {
    errors.push(`读取文件失败: ${err}`);
    return errors;
  }

  const lines = text.split(/\r?\n/);

  if (!lines[0]?.startsWith("# Agent Note: ")) {
    errors.push("第一行必须是 '# Agent Note: <标题>'");
  }

  if (lines[1]?.trim() !== "") {
    errors.push("第二行必须是空行");
  }

  if (lines[2]?.trim() !== "Status: implemented") {
    errors.push("第三行必须是 'Status: implemented'");
  }

  for (const section of REQUIRED_SECTIONS_IMPLEMENTED) {
    if (!text.includes(section)) {
      errors.push(`缺少章节: ${section}`);
    }
  }

  for (const section of FORBIDDEN_SECTIONS_IMPLEMENTED) {
    if (text.includes(section)) {
      errors.push(`implemented 记录禁止包含: ${section}`);
    }
  }

  return errors;
}

/** 递归收集目录下所有 .md 文件路径。 */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...await collectMarkdownFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * 统计 root 下的 Agent Note 数量（排除 README/AGENTS 说明文件）。
 *
 * 门禁自检用：若目录改名/扫描器失效导致"一篇都没扫到"，只报告"格式校验通过"
 * 就是假绿灯（2026-09-12 架构评审 §2.3 同类缺陷）。
 */
export async function countAgentNotes(root: string): Promise<number> {
  let count = 0;
  for (const filePath of await collectMarkdownFiles(root)) {
    const base = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (base === "README.md" || base === "AGENTS.md") continue;
    count++;
  }
  return count;
}

/** 递归扫描 root 下所有 Agent Note 并返回错误列表。 */
export async function verifyAgentNotesTree(root: string): Promise<string[]> {
  const errors: string[] = [];

  for (const filePath of await collectMarkdownFiles(root)) {
    const base = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (base === "README.md" || base === "AGENTS.md") {
      continue;
    }
    const relative = filePath.slice(root.length + 1);
    errors.push(
      ...verifyAgentNotePath(relative).map((e) => `${filePath}: ${e}`),
    );
    errors.push(
      ...verifyAgentNote(filePath).map((e) => `${filePath}: ${e}`),
    );
  }

  return errors;
}

if (import.meta.main) {
  const root = ".agents/notes";
  const notes = await countAgentNotes(root);
  const errors = await verifyAgentNotesTree(root);
  if (errors.length > 0) {
    console.error("Agent Note 格式校验失败：");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    Deno.exit(1);
  }
  // 自检：必须真的扫到 note，否则"通过"无意义（见 countAgentNotes 注释）
  if (notes === 0) {
    console.error(
      `Agent Note 格式校验失败：在 ${root} 下未扫描到任何 Agent Note（目录或扫描器已失效）`,
    );
    Deno.exit(1);
  }
  console.log(`Agent Note 格式校验通过（${notes} 篇）`);
}
