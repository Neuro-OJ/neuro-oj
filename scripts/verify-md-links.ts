// Markdown 链接门禁。
// 扫描仓库 Markdown 中的相对链接与锚点，检查目标文件和标题锚点是否存在。
import { dirname, resolve } from "node:path";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  ".git",
  ".claude",
  ".opencode",
  ".worktrees",
  "vendor",
  "coverage",
  "superpowers",
]);

export interface ExtractedLink {
  target: string;
  line: number;
}

/** 从 Markdown 文本中提取 [text](target) 与 ![alt](target)。 */
export function extractLinks(content: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const lines = content.split(/\r?\n/);
  const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      links.push({ target: match[1].trim(), line: i + 1 });
    }
  }
  return links;
}

/** 收集 Markdown 文件的标题锚点（显式 {#id} 与自动 slug）。 */
export function collectHeadings(mdPath: string): Set<string> {
  const headings = new Set<string>();
  const text = Deno.readTextFileSync(mdPath);
  const lines = text.split(/\r?\n/);
  const re = /^#{1,6}\s+(.+)$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    const explicit = /^(.+?)\s*\{#([^}]+)\}\s*$/.exec(raw);
    if (explicit) {
      headings.add(explicit[2]);
      headings.add(slugify(explicit[1]));
    } else {
      headings.add(slugify(raw));
    }
  }
  return headings;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

interface ResolvedTarget {
  filePath: string | null;
  fragment: string | null;
}

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|tel:)/.test(target);
}

function splitFragment(target: string): [string, string | null] {
  const idx = target.indexOf("#");
  if (idx < 0) return [target, null];
  return [target.slice(0, idx), target.slice(idx + 1)];
}

/** 解析链接目标为文件路径与锚点；外部或站内绝对路径返回 null。 */
export function resolveTarget(
  fromFile: string,
  target: string,
): ResolvedTarget | null {
  if (isExternal(target)) return null;
  if (target.startsWith("/")) return null;
  const [pathPart, fragment] = splitFragment(target);
  if (pathPart === "") {
    return { filePath: fromFile, fragment };
  }
  return { filePath: resolve(dirname(fromFile), pathPart), fragment };
}

function collectMdFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(root)) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...collectMdFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

/** 扫描 root 下所有 Markdown 链接，返回错误列表。 */
export function verifyMarkdownLinks(root: string): string[] {
  const errors: string[] = [];
  for (const filePath of collectMdFiles(root)) {
    let content: string;
    try {
      content = Deno.readTextFileSync(filePath);
    } catch (err) {
      errors.push(`${filePath}: 读取失败 ${err}`);
      continue;
    }
    for (const link of extractLinks(content)) {
      const resolved = resolveTarget(filePath, link.target);
      if (!resolved) continue;
      if (!resolved.filePath) continue;
      let stat;
      try {
        stat = Deno.statSync(resolved.filePath);
      } catch {
        errors.push(`${filePath}:${link.line}: 目标文件不存在 ${link.target}`);
        continue;
      }
      if (stat.isDirectory) {
        if (resolved.fragment) {
          const indexPath = `${resolved.filePath}/index.md`;
          let indexExists = false;
          try {
            indexExists = Deno.statSync(indexPath).isFile;
          } catch {
            indexExists = false;
          }
          if (!indexExists) {
            errors.push(
              `${filePath}:${link.line}: 目录链接带锚点但无 index.md ${link.target}`,
            );
          } else {
            const headings = collectHeadings(indexPath);
            if (!headings.has(resolved.fragment)) {
              errors.push(
                `${filePath}:${link.line}: 目标锚点不存在 ${link.target}`,
              );
            }
          }
        }
        continue;
      }
      if (!stat.isFile) {
        errors.push(`${filePath}:${link.line}: 目标不是文件 ${link.target}`);
        continue;
      }
      if (resolved.fragment) {
        const headings = collectHeadings(resolved.filePath);
        if (!headings.has(resolved.fragment)) {
          errors.push(
            `${filePath}:${link.line}: 目标锚点不存在 ${link.target}`,
          );
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const root = ".";
  const errors = verifyMarkdownLinks(root);
  if (errors.length > 0) {
    console.error("Markdown 链接检查失败：");
    for (const err of errors.slice(0, 200)) {
      console.error(`- ${err}`);
    }
    if (errors.length > 200) {
      console.error(`... 共 ${errors.length} 个错误`);
    }
    Deno.exit(1);
  }
  console.log("Markdown 链接检查通过");
}
