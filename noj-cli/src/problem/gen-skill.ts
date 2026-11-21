/**
 * AI 出题 Skill 嵌入生成器（P0-2 C）。
 *
 * Skill 的**事实源**是 `noj-cli/skills/noj-problem-setter/`（可直接阅读与评审的
 * Markdown）；noj-cli 以 `deno compile` 单二进制分发，运行时读不到仓库文件，
 * 因此把它嵌入为纯数据模块 `src/problem/skill.generated.ts`，由
 * `noj-cli problem skill` 写入出题仓库。
 *
 * 用法：
 *   deno run -A noj-cli/src/problem/gen-skill.ts          # 重新生成
 *   deno run -A noj-cli/src/problem/gen-skill.ts --check  # CI：漂移即失败
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatTs,
    readTextTree,
} from "../../../noj-core/scripts/gen-problem-templates.ts";

const PROBLEM_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_SOURCE_DIR = join(
    PROBLEM_DIR,
    "..",
    "..",
    "skills",
    "noj-problem-setter",
);
export const SKILL_GENERATED_PATH = join(PROBLEM_DIR, "skill.generated.ts");

/** 渲染生成模块源码（未经 deno fmt）。 */
export function renderSkillModule(files: Record<string, string>): string {
    const lines = [
        "// 由 noj-cli/src/problem/gen-skill.ts 生成，请勿手改。",
        "// 事实源：noj-cli/skills/noj-problem-setter/；改动后重新运行生成器。",
        "",
        "/** Skill 相对路径 → 文件内容。 */",
        "export const PROBLEM_SETTER_SKILL_FILES: Readonly<Record<string, string>> = {",
    ];
    for (const path of Object.keys(files).sort()) {
        lines.push(
            `  ${JSON.stringify(path)}: ${JSON.stringify(files[path])},`,
        );
    }
    lines.push("};", "");
    return lines.join("\n");
}

/** 生成（或校验）嵌入模块；返回是否与磁盘一致。 */
export async function generateSkill(check: boolean): Promise<boolean> {
    const files = await readTextTree(SKILL_SOURCE_DIR);
    if (!files["SKILL.md"]) {
        throw new Error(`Skill 缺少 SKILL.md：${SKILL_SOURCE_DIR}`);
    }
    const source = await formatTs(renderSkillModule(files));
    let current: string | null = null;
    try {
        current = await Deno.readTextFile(SKILL_GENERATED_PATH);
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    if (current === source) return true;
    if (!check) await Deno.writeTextFile(SKILL_GENERATED_PATH, source);
    return false;
}

if (import.meta.main) {
    const check = Deno.args.includes("--check");
    const same = await generateSkill(check);
    if (check && !same) {
        console.error(
            "skill.generated.ts 与 noj-cli/skills/noj-problem-setter/ 不一致，" +
                "请运行 deno run -A noj-cli/src/problem/gen-skill.ts 后提交",
        );
        Deno.exit(1);
    }
    console.log(
        same ? "出题 Skill 嵌入模块已是最新" : "已重新生成 skill.generated.ts",
    );
}
