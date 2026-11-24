import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceProblemConfig } from "./types";
import { collectWorkspaceFiles } from "./zipBuilder";

export const NOJ_DIR = ".noj";
export const PROBLEM_CONFIG_FILE = "problem.json";
export const NOJIGNORE_FILE = ".nojignore";

export const DEFAULT_NOJIGNORE_CONTENT = [
  "# Neuro OJ 打包提交忽略清单",
  ".venv/",
  "__pycache__/",
  ".git/",
  "node_modules/",
  ".noj/",
  "*.pyc",
  "*.vsix",
  "",
].join("\n");

/** 读取工作区 `.noj/problem.json`，不存在或格式不完整时返回 `undefined`。 */
export async function readWorkspaceProblemConfig(
  rootDir: string,
): Promise<WorkspaceProblemConfig | undefined> {
  const target = path.join(rootDir, NOJ_DIR, PROBLEM_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `工作区配置 ${NOJ_DIR}/${PROBLEM_CONFIG_FILE} 不是合法 JSON`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`工作区配置 ${NOJ_DIR}/${PROBLEM_CONFIG_FILE} 格式无效`);
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.serverUrl !== "string" ||
    typeof obj.domainSlug !== "string" ||
    typeof obj.reference !== "string" ||
    typeof obj.versionId !== "string"
  ) {
    throw new Error(
      `工作区配置 ${NOJ_DIR}/${PROBLEM_CONFIG_FILE} 缺少必要字段`,
    );
  }
  const mode = obj.submissionMode;
  const submissionMode =
    mode === "artifact" || mode === "prediction" ? mode : "code";
  const judgeType = obj.judgeType === "oi" ? "oi" : "dual";
  return {
    serverUrl: obj.serverUrl,
    domainSlug: obj.domainSlug,
    reference: obj.reference,
    versionId: obj.versionId,
    version: typeof obj.version === "number" ? obj.version : null,
    entryFile:
      typeof obj.entryFile === "string" && obj.entryFile.trim()
        ? obj.entryFile.trim()
        : "submission.py",
    submissionMode,
    judgeType,
  };
}

/** 写入工作区 `.noj/problem.json`。 */
export async function writeWorkspaceProblemConfig(
  rootDir: string,
  config: WorkspaceProblemConfig,
): Promise<string> {
  const nojDir = path.join(rootDir, NOJ_DIR);
  await fs.mkdir(nojDir, { recursive: true });
  const target = path.join(nojDir, PROBLEM_CONFIG_FILE);
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return target;
}

/** 若工作区不存在 `.nojignore`，写入默认忽略规则；已存在则保留用户配置。 */
export async function ensureNojIgnore(
  rootDir: string,
): Promise<{ path: string; created: boolean }> {
  const target = path.join(rootDir, NOJIGNORE_FILE);
  try {
    await fs.access(target);
    return { path: target, created: false };
  } catch {
    await fs.writeFile(target, DEFAULT_NOJIGNORE_CONTENT, "utf8");
    return { path: target, created: true };
  }
}

/** 推断工作区入口文件名。 */
export function inferEntryFile(
  submissionMode: "code" | "artifact" | "prediction",
): string {
  return submissionMode === "prediction" ? "predictions.csv" : "submission.py";
}

/** 初始化本地题目工作区：落盘 `.noj/problem.json`、`.nojignore` 与模板文件。 */
export async function initProblemWorkspace(
  rootDir: string,
  config: WorkspaceProblemConfig,
  templateContent: string | null,
  options: { overwriteEntry?: boolean } = {},
): Promise<{
  configPath: string;
  ignorePath: string;
  entryPath: string;
  entryCreated: boolean;
}> {
  const configPath = await writeWorkspaceProblemConfig(rootDir, config);
  const ignore = await ensureNojIgnore(rootDir);
  const entryPath = path.join(rootDir, config.entryFile);
  await fs.mkdir(path.dirname(entryPath), { recursive: true });

  let entryExists = false;
  try {
    const existing = await fs.readFile(entryPath, "utf8");
    entryExists = existing.trim().length > 0;
  } catch {
    entryExists = false;
  }

  let entryCreated = false;
  if (!entryExists || options.overwriteEntry) {
    const content =
      templateContent !== null
        ? templateContent
        : config.submissionMode === "prediction"
          ? ""
          : "# Neuro OJ 题目工作区模板\n";
    await fs.writeFile(entryPath, content, "utf8");
    entryCreated = true;
  }

  return {
    configPath,
    ignorePath: ignore.path,
    entryPath,
    entryCreated,
  };
}

/** 检测工作区中的源码文件数量，用于决定是否提供多文件 ZIP 提交选项。 */
export async function listWorkspaceSourceFiles(
  rootDir: string,
): Promise<string[]> {
  const entries = await collectWorkspaceFiles(rootDir, { maxFiles: 500 });
  return entries
    .map((entry) => entry.name)
    .filter((name) => /\.(py|json|yaml|yml|txt|md|toml|sh|csv)$/i.test(name));
}
