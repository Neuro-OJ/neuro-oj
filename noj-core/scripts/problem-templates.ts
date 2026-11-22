/**
 * 题目模板（`problem init --template <name>`，P0-2 B）。
 *
 * 本模块**无外部依赖**（只引用同目录的生成模块），由 `noj problems init`
 * （`scripts/problems-init.ts`）与 `noj-cli problem init`（`noj-cli/src/problem/init.ts`）
 * 以相对路径共用，两处 init 的模板内容因此只有一份事实源：
 * `scripts/problem-templates/<name>/`（改动后运行 `gen-problem-templates.ts` 重新嵌入）。
 *
 * 每个模板都带 `submissions/`（满分解、错解、空解与 expect.json），生成后即可
 * `noj-cli problem test` 验题；`submissions/` 不会进入题目包。
 */
import { PROBLEM_TEMPLATE_FILES } from "./problem-templates.generated.ts";

/** 模板名（顺序即帮助文本中的展示顺序）。 */
export const PROBLEM_TEMPLATE_NAMES = [
    "code",
    "prediction",
    "llm",
    "objective",
    "ui",
] as const;

export type ProblemTemplateName = typeof PROBLEM_TEMPLATE_NAMES[number];

/** 模板一句话说明（帮助文本用）。 */
export const PROBLEM_TEMPLATE_DESCRIPTIONS: Record<
    ProblemTemplateName,
    string
> = {
    code: "代码题：双容器函数调用，可见/隐藏用例",
    prediction: "预测提交题：上传 CSV，按隐藏标签算准确率",
    llm: "LLM 工程题：选手构造提示词，评测脚本调用大模型",
    objective: "客观题：单选/多选/判断套卷",
    ui: "界面题：ui.html 填参数，注入脚本模板评测",
};

/** 是否为已知模板名。 */
export function isProblemTemplateName(
    name: string,
): name is ProblemTemplateName {
    return (PROBLEM_TEMPLATE_NAMES as readonly string[]).includes(name);
}

/** 渲染选项：未给出的字段保留模板自带的值。 */
export interface RenderTemplateOptions {
    title?: string;
    difficulty?: string;
}

/** 把 Markdown 首行一级标题替换为题目标题。 */
function retitleMarkdown(content: string, title: string): string {
    return content.startsWith("# ")
        ? content.replace(/^# [^\n]*/, `# ${title}`)
        : content;
}

/**
 * 渲染模板为待写入的文件列表 `[相对路径, 内容]`（按路径排序）。
 *
 * 只改写 `problem.json` 的 `title` / `difficulty` 与题面、README 的首行标题；
 * 其余文件原样输出。
 */
export function renderProblemTemplate(
    name: ProblemTemplateName,
    options: RenderTemplateOptions = {},
): Array<[string, string]> {
    const files = PROBLEM_TEMPLATE_FILES[name];
    if (!files) throw new Error(`未嵌入的题目模板：${name}`);
    return Object.entries(files).map(([path, content]) => {
        if (path === "problem.json") {
            const manifest = JSON.parse(content) as Record<string, unknown>;
            if (options.title !== undefined) manifest.title = options.title;
            if (options.difficulty !== undefined) {
                manifest.difficulty = options.difficulty;
            }
            return [path, `${JSON.stringify(manifest, null, 2)}\n`];
        }
        if (
            options.title !== undefined &&
            (path === "statement.md" || path === "README.md")
        ) {
            return [path, retitleMarkdown(content, options.title)];
        }
        return [path, content];
    });
}
