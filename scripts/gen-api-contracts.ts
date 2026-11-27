/**
 * 前后端 API 契约同步生成器。
 *
 * 事实源：`noj-core/src/shared/api-contracts/features.ts`
 * 生成目标：
 * - `noj-ui/utils/generated/api-contracts.ts`
 *
 * 各服务 Docker 镜像与编译构建彼此独立（只复制各自目录），因此通过生成物 +
 * CI `--check` 门禁保证零漂移。
 *
 * 用法：
 *   deno run -A scripts/gen-api-contracts.ts          # 生成并同步目标文件
 *   deno run -A scripts/gen-api-contracts.ts --check  # CI：任一目标漂移即失败
 */
import { dirname, join, resolve } from "node:path";

export const CONTRACT_SOURCE_REL = "noj-core/src/shared/api-contracts/features.ts";
export const CONTRACT_TARGETS_REL = [
  "noj-ui/utils/generated/api-contracts.ts",
] as const;

const FORBIDDEN_IMPORT_RE = /^\s*(?:import|export\s+[^;]*\s+from)\b/m;
const FORBIDDEN_RUNTIME_RE = /\b(?:Deno|process)\s*\./;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** 将纯类型契约源渲染为可独立编译的目标文件内容。 */
export function renderGeneratedContract(sourceText: string): string {
  const normalized = sourceText.replaceAll("\r\n", "\n").trimEnd();
  const codeOnly = stripComments(normalized);
  if (FORBIDDEN_IMPORT_RE.test(codeOnly)) {
    throw new Error(
      `${CONTRACT_SOURCE_REL} 不得包含 import/re-export，必须保持零依赖纯契约`,
    );
  }
  if (FORBIDDEN_RUNTIME_RE.test(codeOnly)) {
    throw new Error(
      `${CONTRACT_SOURCE_REL} 不得引用 Deno/process 等运行时全局对象`,
    );
  }
  const header = [
    "// deno-fmt-ignore-file",
    "/* eslint-disable */",
    "/**",
    " * 由 `scripts/gen-api-contracts.ts` 自动生成，禁止手工修改。",
    ` * 事实源：\`${CONTRACT_SOURCE_REL}\``,
    " */",
    "",
  ].join("\n");
  return `${header}${normalized}\n`;
}

export interface SyncContractsResult {
  changed: string[];
  checked: number;
}

export async function syncApiContracts(
  rootDir = ".",
  options: { checkOnly?: boolean } = {},
): Promise<SyncContractsResult> {
  const root = resolve(rootDir);
  const sourcePath = join(root, CONTRACT_SOURCE_REL);
  const sourceText = await Deno.readTextFile(sourcePath);
  const expected = renderGeneratedContract(sourceText);

  const changed: string[] = [];
  for (const rel of CONTRACT_TARGETS_REL) {
    const targetPath = join(root, rel);
    let current: string | null = null;
    try {
      current = await Deno.readTextFile(targetPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (current !== expected) {
      changed.push(rel);
      if (!options.checkOnly) {
        await Deno.mkdir(dirname(targetPath), { recursive: true });
        await Deno.writeTextFile(targetPath, expected);
      }
    }
  }

  return { changed, checked: CONTRACT_TARGETS_REL.length };
}

if (import.meta.main) {
  const checkOnly = Deno.args.includes("--check");
  const { changed, checked } = await syncApiContracts(".", { checkOnly });
  if (checkOnly && changed.length > 0) {
    console.error(
      `❌ API 契约已漂移（共 ${changed.length}/${checked} 个目标不同步）：`,
    );
    for (const rel of changed) console.error(`  - ${rel}`);
    console.error("请运行：deno run -A scripts/gen-api-contracts.ts");
    Deno.exit(1);
  }
  if (checkOnly) {
    console.log(
      `API 契约同步校验通过（${checked} 个下游目标与事实源一致）`,
    );
  } else {
    console.log(
      changed.length === 0
        ? `API 契约已是最新（${checked} 个目标无变更）`
        : `✅ 已更新 ${changed.length} 个 API 契约目标：${changed.join(", ")}`,
    );
  }
}
