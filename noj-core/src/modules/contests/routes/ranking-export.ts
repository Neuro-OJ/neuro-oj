/**
 * 比赛正式成绩导出与相似度查询的 HTTP 辅助函数（域比赛路由共用）。
 *
 * 自旧管理端 `/api/v1/admin/contest` 迁入；格式、分数换算与 CSV 注入防护保持不变。
 */
import { BadRequestError } from "../../../shared/base/errors.ts";
import { scoreFromDb } from "../../evaluations/types/index.ts";
import { MAX_SIMILAR_PAIR_LIMIT } from "../services/contest-similarity.ts";
import type { KaggleRankingRow } from "../types/contests.ts";

/** 解析 `threshold` 查询参数：缺省时返回 undefined，由服务层套用默认阈值。 */
export function parseSimilarityThreshold(
    raw: string | undefined,
): number | undefined {
    const text = raw?.trim();
    if (!text) return undefined;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
        throw new BadRequestError("threshold 必须为大于 0 且不超过 1 的小数");
    }
    return value;
}

/** 解析 `limit` 查询参数：缺省时返回 undefined，由服务层套用默认上限。 */
export function parseSimilarityLimit(
    raw: string | undefined,
): number | undefined {
    const text = raw?.trim();
    if (!text) return undefined;
    const value = Number(text);
    if (
        !Number.isInteger(value) || value < 1 || value > MAX_SIMILAR_PAIR_LIMIT
    ) {
        throw new BadRequestError(
            `limit 必须为 1 到 ${MAX_SIMILAR_PAIR_LIMIT} 之间的整数`,
        );
    }
    return value;
}

/**
 * 构造正式成绩快照的 JSON 响应体（latest 与按版本导出共用）。
 *
 * 抽出的理由：两条导出路径若各写一份字段组装，改动时极易只更新其中一处，
 * 导致「最新版」与「历史版」的导出结构漂移。
 *
 * **分数换算**：与 CSV 导出同口径——快照以 ×100 整数存储，导出统一换算为
 * 展示分数（`scoreFromDb`），使 JSON 与 CSV、以及页面榜单三者一致。
 */
export function buildRankingSnapshotJson(
    contestId: string,
    snapshot: {
        version: number;
        note: string;
        created_by: string | null;
        created_at: string;
        rows: unknown;
    },
) {
    const rows = Array.isArray(snapshot.rows)
        ? (snapshot.rows as KaggleRankingRow[]).map((row) => ({
            ...row,
            total_score: scoreFromDb(row.total_score),
            problem_scores: (row.problem_scores ?? []).map((s) => ({
                ...s,
                best_score: s.best_score === null
                    ? null
                    : scoreFromDb(s.best_score),
            })),
        }))
        : snapshot.rows;
    return {
        data: {
            contest_id: contestId,
            version: snapshot.version,
            note: snapshot.note,
            created_by: snapshot.created_by,
            created_at: snapshot.created_at,
            // 分数已换算为展示量纲（÷100）；rank/attempts 等计数值原样。
            rows,
        },
    };
}

/**
 * 构造正式成绩快照的 CSV 文本（latest 与按版本导出共用）。
 *
 * 逐行输出每人的总分与**逐题明细**（题目标签、最好成绩、提交次数、最后得分时间），
 * 便于运营直接做成绩核对与归档，无需再解析 JSON 列。
 *
 * **分数换算**：快照表以 ×100 整数存储（`scoreToDb`），而榜单与题面展示的是
 * 除以 100 后的分数（`noj-ui/components/feature/contest/ContestRanking.vue` 的
 * `score()`）。导出是给人核对/归档用的，必须与**看到的分数一致**，因此这里对
 * `total_score` 与 `best_score` 套用 `scoreFromDb()`；否则满分 100 的题目在
 * 导出文件里会显示成 10000，任何以导出为准的归档与下游重排都会被静默污染。
 * `rank` / `attempts` 是计数值，不参与换算。
 *
 * 安全：单元格经 `csvCell` 处理——以 `= + - @ \t \r` 开头的内容加 `'` 前缀，
 * 防止导出文件在 Excel 中被当作公式执行（CSV 注入）。
 */
export function* buildRankingCsv(snapshot: {
    version: number;
    rows: unknown;
}): Generator<string> {
    const rows = (snapshot.rows ?? []) as KaggleRankingRow[];
    const header = [
        "版本",
        "排名",
        "用户",
        "总分",
        "最后提交时间",
        "题目标签",
        "题目最好成绩",
        "题目提交次数",
        "该题最后得分时间",
    ];
    // 逐行 yield：配合 csvResponse 的流式写出，峰值内存与总行数无关。
    yield header.join(",") + "\n";
    for (const row of rows) {
        const scores = row.problem_scores ?? [];
        if (scores.length === 0) {
            // 无题目明细时仍输出一行，避免该用户整行消失（总分本身是有效信息）
            yield [
                snapshot.version,
                row.rank,
                row.username,
                scoreFromDb(row.total_score),
                row.last_submission_at ?? "",
                "",
                "",
                "",
                "",
            ].map(csvCell).join(",") + "\n";
            continue;
        }
        // 每人每题一行：便于在表格软件中直接按题目透视，而不是把明细塞进一个 JSON 单元格
        for (const score of scores) {
            yield [
                snapshot.version,
                row.rank,
                row.username,
                scoreFromDb(row.total_score),
                row.last_submission_at ?? "",
                score.label,
                score.best_score === null
                    ? "待处理"
                    : scoreFromDb(score.best_score),
                score.attempts,
                score.last_best_at ?? "",
            ].map(csvCell).join(",") + "\n";
        }
    }
}

/**
 * 解析 `latest.<json|csv>` 或 `<版本号>.<json|csv>` 形式的导出文件名。
 *
 * 只接受 `latest` 或纯数字版本号 + 受支持的扩展名；其余一律 400。
 * **不做「不匹配就回退到最新版」**——静默回退会让运营误以为导出的是历史版本。
 *
 * @returns `version` 为 undefined 表示最新版
 */
export function parseSnapshotFile(file: string | undefined): {
    version: number | undefined;
    format: "json" | "csv";
} {
    const matched = /^(latest|\d+)\.(json|csv)$/.exec(file ?? "");
    if (!matched) {
        throw new BadRequestError(
            "导出路径必须形如 latest.json、latest.csv、<版本号>.json 或 <版本号>.csv",
            "VALIDATION_ERROR",
        );
    }
    const format = matched[2] as "json" | "csv";
    if (matched[1] === "latest") return { version: undefined, format };
    const version = Number(matched[1]);
    if (!Number.isSafeInteger(version) || version < 1) {
        throw new BadRequestError(
            "版本号必须是不小于 1 的整数",
            "VALIDATION_ERROR",
        );
    }
    return { version, format };
}

/**
 * 以 UTF-8 BOM + 附件头**流式**返回 CSV（BOM 保证 Excel 正确识别中文）。
 *
 * 流式而非一次性字符串：成绩单随参赛人数线性增长，一万人 × 十题的明细是十万行级
 * 数据；拼成单个字符串会把这些数据在内存里复制多份（原始行数组 + 行数组 + 拼接后
 * 的大字符串 + BOM 前缀再拼一次），管理员一次导出就能显著推高常驻内存。
 * 这里逐行生成、逐块写回，峰值内存与总行数无关。
 *
 * 缓存策略：响应含全员成绩（个人数据），且随重测/新版本变化，明确禁止任何缓存。
 */
export function csvResponse(
    chunkIter: Iterable<string>,
    filename: string,
): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            // BOM 必须先于任何内容，否则 Excel 会把中文识别成乱码
            controller.enqueue(encoder.encode("\uFEFF"));
            for (const chunk of chunkIter) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            // 全员成绩属个人数据且随时可变，禁止浏览器/代理缓存
            "Cache-Control": "private, no-store",
        },
    });
}

/**
 * CSV 单元格转义（防注入 + 保行框）。
 *
 * 注入防护：Excel / Sheets / LibreOffice 会把以 `=` `+` `-` `@` 开头的内容当公式
 * 执行，**制表符与回车同样能起到前置分隔作用**（`\t=cmd`、`\r=cmd` 实测可绕过
 * 只查 `^[=+\-@]` 的旧实现），故一并纳入前缀判定。
 *
 * 行框保护：`\r` 也必须触发引号包裹——行是用 `\n` 连接的，未包裹的 `\r` 会让
 * 单元格内容在解析端断行，破坏列对齐。
 *
 * 数值不参与前缀判定：`-0`、`-1` 这类负数是合法数据，不该被加上 `'`。
 */
function csvCell(value: unknown): string {
    if (typeof value === "number") return String(value);
    let text = String(value ?? "");
    // 前导空白也可能被表格软件忽略后仍按公式解析，故按「去掉前导空白后的首字符」判定
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
