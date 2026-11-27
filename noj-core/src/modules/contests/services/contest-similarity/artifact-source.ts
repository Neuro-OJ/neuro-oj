// 产物 ZIP 内 Python 源码提取与确定性拼接（供复核与代码查重）。

import { DEFAULT_MAX_RAW_CODE_CHARS } from "./lexicon.ts";

const IGNORED_PATH_SEGMENTS = new Set([
  "__pycache__",
  ".venv",
  "venv",
  ".git",
  "node_modules",
  "tests",
  "test",
]);

function isExcludedPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.toLowerCase().endsWith(".py")) return true;
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.some((part) => IGNORED_PATH_SEGMENTS.has(part))) return true;
  const base = parts[parts.length - 1] ?? "";
  return base.startsWith("test_") || base.endsWith("_test.py");
}

/**
 * 过滤产物 ZIP 中的虚拟环境、缓存、测试及非 `.py` 文件，按路径字典序确定性拼接源码，
 * 并截断至 `maxChars`（默认 `DEFAULT_MAX_RAW_CODE_CHARS`）。
 */
export function extractSortablePythonSource(
  files: Record<string, string>,
  maxChars: number = DEFAULT_MAX_RAW_CODE_CHARS,
): string {
  const paths = Object.keys(files)
    .filter((p) => !isExcludedPath(p))
    .sort((a, b) => a.localeCompare(b));

  const chunks: string[] = [];
  let total = 0;
  for (const path of paths) {
    const content = files[path];
    if (typeof content !== "string" || !content.trim()) continue;
    const piece = `# file: ${path}\n${content}\n`;
    if (total + piece.length >= maxChars) {
      chunks.push(piece.slice(0, Math.max(0, maxChars - total)));
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }
  return chunks.join("");
}
