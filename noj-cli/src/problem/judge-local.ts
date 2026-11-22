/**
 * `noj-cli problem test` 的核心逻辑：题包 → 生产同款 JudgeTask → `noj-judge run-local`。
 *
 * 设计说明见 `dev-docs/design/problem-local-test.md`（方案 2）。要点：
 * - **不在 CLI 中编排容器**：执行全部交给 `noj-judge run-local`（Worker 同一入口）；
 * - **任务构造复用 core**：`validateBundleManifest`（补全 runtime_config 缺省值）、
 *   `prepareJudgeTask`（含界面题脚本注入）与生产同一实现，避免漂移；
 * - 客观题生产上不经 judge，这里同样直接用 core 的 `judgePaper` 判分；
 * - 网络默认关闭，LLM 题默认可用 `mock://` 网关离线验题。
 */
import { basename, extname, join, resolve } from "@std/path";
import { zipSync } from "fflate";
import {
    BUNDLE_METADATA_ENTRIES,
    type ProblemBundleManifest,
    validateObjectiveQuestions,
} from "../../../noj-core/src/modules/problems/types/problem-bundle.ts";
import { isOiRuntimeConfig } from "../../../noj-core/src/modules/problems/types/runtime-config.ts";
import { prepareJudgeTask } from "../../../noj-core/src/modules/evaluations/services/prepare-judge-task.ts";
import {
    type JudgeTask,
    type JudgeTaskLlm,
    toJudgeSubmissionMode,
} from "../../../noj-core/src/modules/evaluations/types/index.ts";
import { judgePaper } from "../../../noj-core/src/modules/evaluations/services/objective/objective-judge.ts";
import { collectBundleEntries, shouldExclude } from "./pack.ts";
import { validatePredictionFile } from "../../../noj-core/src/modules/evaluations/services/submissions/prediction-format.ts";

/** 预测文件头校验读取的字节数（足以覆盖 pickle / zip / npy 魔数）。 */
const PREDICTION_HEAD_BYTES = 64;

/** 默认参考解答目录（`submission*` 不会进入题目包，见 pack.ts）。 */
export const DEFAULT_SUBMISSIONS_DIR = "submissions";
/** 默认断言文件（位于参考解答目录内）。 */
export const DEFAULT_EXPECT_FILE = "expect.json";
/** noj-judge 本地评测子命令。 */
export const RUN_LOCAL_SUBCOMMAND = "run-local";
/** 离线 LLM mock 网关（SDK 回显最后一条 user 消息）。 */
export const LLM_MOCK_GATEWAY = "mock://echo";

/**
 * 构造 mock 网关地址：题目声明的单次评测预算经查询串传给 SDK mock
 * （`max_calls` / `max_tokens`），超出时与真实网关一样返回 429 out_of_usage。
 * 不改动 JudgeTask 协议字段。
 */
export function mockGatewayUrl(
    budget: { max_calls?: number; max_tokens?: number } | undefined,
): string {
    const params = new URLSearchParams();
    if (budget?.max_calls !== undefined) {
        params.set("max_calls", String(budget.max_calls));
    }
    if (budget?.max_tokens !== undefined) {
        params.set("max_tokens", String(budget.max_tokens));
    }
    const query = params.toString();
    return query === "" ? LLM_MOCK_GATEWAY : `${LLM_MOCK_GATEWAY}?${query}`;
}

/** 一个参考解答。 */
export interface SolutionSpec {
    /** 名称（断言引用，缺省为去扩展名的文件名）。 */
    name: string;
    /** 文件或目录的绝对路径。 */
    path: string;
}

/** 断言比较符。 */
export type ExpectOp = "=" | ">=" | "<=" | ">" | "<";

/** 一条分数断言（分数口径 0-100）。 */
export interface Expectation {
    name: string;
    op: ExpectOp;
    value: number;
    /** 原始文本，便于报告。 */
    raw: string;
}

/** 解析 `name=100` / `name>=90` / `name<60` 形式的断言。 */
export function parseExpectation(raw: string): Expectation {
    const m = /^([A-Za-z0-9_.-]+)\s*(>=|<=|=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(
        raw.trim(),
    );
    if (!m) {
        throw new Error(
            `断言格式非法：${raw}（示例：good=100、partial>=50、wrong<60）`,
        );
    }
    const value = Number(m[3]);
    if (value < 0 || value > 100) {
        throw new Error(`断言分数必须在 0-100 之间：${raw}`);
    }
    return {
        name: m[1]!,
        op: m[2] as ExpectOp,
        value,
        raw: `${m[1]}${m[2]}${m[3]}`,
    };
}

/** 分数是否满足断言（`=` 允许 0.005 的浮点误差，分数本身精确到 0.01）。 */
export function checkExpectation(score: number, e: Expectation): boolean {
    switch (e.op) {
        case "=":
            return Math.abs(score - e.value) < 0.005;
        case ">=":
            return score >= e.value;
        case "<=":
            return score <= e.value;
        case ">":
            return score > e.value;
        case "<":
            return score < e.value;
    }
}

/**
 * 解析 `expect.json`：`{"good": "=100", "empty": "=0", "wrong": "<60"}`，
 * 值也可以是数字（等价于 `=`）。
 */
export function parseExpectFile(text: string): Expectation[] {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new Error(`expect.json 不是合法 JSON：${(err as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("expect.json 必须是 {解答名: 断言} 对象");
    }
    return Object.entries(raw as Record<string, unknown>).map(([name, v]) => {
        if (typeof v === "number") return parseExpectation(`${name}=${v}`);
        if (typeof v === "string") {
            return parseExpectation(`${name}${v.trim()}`);
        }
        throw new Error(`expect.json 中 ${name} 的断言必须是字符串或数字`);
    });
}

/** 解析 `--solution path[@name]`；名称缺省为去扩展名的文件名。 */
export function parseSolutionArg(raw: string, cwd: string): SolutionSpec {
    // 名称写在末尾 `@name`（断言用 `name=分数`，避免与之混淆）
    const at = raw.lastIndexOf("@");
    const path = at > 0 ? raw.slice(0, at) : raw;
    const explicit = at > 0 ? raw.slice(at + 1) : undefined;
    if (explicit !== undefined && !/^[A-Za-z0-9_.-]+$/.test(explicit)) {
        throw new Error(`解答名称非法：${explicit}`);
    }
    const abs = resolve(cwd, path);
    const name = explicit ?? basename(abs, extname(abs));
    return { name, path: abs };
}

/** 列出参考解答目录中的解答（跳过 expect.json / README.md / 隐藏文件）。 */
export async function discoverSolutions(dir: string): Promise<SolutionSpec[]> {
    const out: SolutionSpec[] = [];
    for await (const entry of Deno.readDir(dir)) {
        if (entry.name.startsWith(".") || entry.name === "__pycache__") {
            continue;
        }
        if (entry.name === DEFAULT_EXPECT_FILE || entry.name === "README.md") {
            continue;
        }
        const path = join(dir, entry.name);
        out.push({
            name: entry.isDirectory
                ? entry.name
                : basename(path, extname(path)),
            path,
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 构建支持包：与 `pack` 同一排除规则，再按导入流程剥离 problem.json /
 * statement.md（生产支持包同样不含这两项）。
 */
export async function buildSupportPackage(dir: string): Promise<Uint8Array> {
    const metadata = new Set<string>(BUNDLE_METADATA_ENTRIES);
    const entries = Object.fromEntries(
        Object.entries(await collectBundleEntries(dir)).filter(([rel]) =>
            !shouldExclude(rel) && !metadata.has(rel)
        ),
    );
    return zipSync(entries, { level: 6 });
}

/** 把目录打成 zip（artifact 提交）。 */
export async function zipDirectory(dir: string): Promise<Uint8Array> {
    const entries: Record<string, Uint8Array> = {};
    async function walk(current: string, prefix: string): Promise<void> {
        for await (const entry of Deno.readDir(current)) {
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory) {
                if (entry.name === "__pycache__") continue;
                await walk(join(current, entry.name), rel);
            } else if (entry.isFile) {
                entries[rel] = await Deno.readFile(join(current, entry.name));
            }
        }
    }
    await walk(dir, "");
    return zipSync(entries, { level: 6 });
}

/** LLM 执行方式。 */
export type LlmMode =
    | { kind: "none" }
    | { kind: "mock" }
    | { kind: "gateway"; url: string; token: string };

/** 本地运行选项。 */
export interface LocalRunOptions {
    judgeBin: string;
    allowNetwork: boolean;
    network?: string;
    llm: LlmMode;
}

/** 单个解答的运行结果。 */
export interface SolutionReport {
    name: string;
    path: string;
    /** 0-100，保留两位小数。 */
    score: number;
    status: string;
    /** Solution 累计耗时（ms，judge 口径）。 */
    time_ms: number | null;
    /** 端到端墙钟耗时（ms，含容器启动）。 */
    wall_ms: number;
    /** stderr 摘要（最后若干行）。 */
    stderr: string;
    notes: string[];
    /** 执行失败（judge 进程或评测环境错误）。 */
    error: string | null;
    details?: unknown;
}

/** 提取 judge 输出中的 stderr 尾部摘要。 */
export function stderrSummary(output: string, maxLines = 8): string {
    const sep = "--- STDERR ---";
    const idx = output.indexOf(sep);
    const tail = idx >= 0 ? output.slice(idx + sep.length) : "";
    const lines = tail.split("\n").map((l) => l.trimEnd()).filter((l) =>
        l !== ""
    );
    return lines.slice(-maxLines).join("\n").slice(-1500);
}

/** 由文件扩展名推断 OI 语言。 */
export function oiLanguageFor(path: string): "c" | "cc" {
    const ext = extname(path).toLowerCase();
    if (ext === ".c") return "c";
    if ([".cc", ".cpp", ".cxx"].includes(ext)) return "cc";
    throw new Error(`OI 解答只支持 .c / .cc / .cpp：${path}`);
}

/** 构造 LLM 任务字段（与生产 `JudgeTaskLlm` 同形）。 */
export function buildLlmTask(
    manifest: ProblemBundleManifest,
    mode: LlmMode,
): JudgeTaskLlm | undefined {
    if (!manifest.llm || mode.kind === "none") return undefined;
    const models = manifest.llm.models && manifest.llm.models.length > 0
        ? manifest.llm.models
        : ["default"];
    return mode.kind === "mock"
        ? {
            gateway_url: mockGatewayUrl(manifest.llm),
            eval_token: "local",
            provider_id: "local",
            allowed_models: models,
        }
        : {
            gateway_url: mode.url,
            eval_token: mode.token,
            provider_id: "local",
            allowed_models: models,
        };
}

/** 一次评测的输入（已读入内存）。 */
export interface PreparedSubmission {
    task: JudgeTask;
    /** 产物文件字节（artifact zip / prediction 文件）。 */
    artifact?: Uint8Array;
}

/** 读取解答并构造生产同款 JudgeTask。 */
export async function prepareSubmission(
    problemDir: string,
    manifest: ProblemBundleManifest,
    solution: SolutionSpec,
    llm: LlmMode,
): Promise<PreparedSubmission> {
    const stat = await Deno.stat(solution.path);
    const runtime = manifest.runtime_config!;
    const mode = manifest.submission_mode ?? "code";
    const base = {
        attempt_id: crypto.randomUUID(),
        problem_version_id: "local",
        submission_id: `local-${solution.name}-${
            crypto.randomUUID().slice(0, 8)
        }`,
        problem_id: "local",
        user_id: "local",
        priority: "high" as const,
        runtime_config: runtime,
    };

    if (isOiRuntimeConfig(runtime)) {
        if (!stat.isFile) {
            throw new Error(`OI 解答必须是源文件：${solution.path}`);
        }
        return {
            task: prepareJudgeTask({
                ...base,
                submission_mode: "code",
                language: oiLanguageFor(solution.path),
                code: await Deno.readTextFile(solution.path),
                file_name: basename(solution.path),
            }),
        };
    }

    const llmTask = buildLlmTask(manifest, llm);
    const judgeMode = toJudgeSubmissionMode(mode);
    if (mode === "prediction") {
        // 与生产预测提交接口一致：只接受单个文件，并复用 core 的文件名/文件头校验。
        if (!stat.isFile) {
            throw new Error(`预测题解答必须是单个预测文件：${solution.path}`);
        }
        const artifact = await Deno.readFile(solution.path);
        const fileName = basename(solution.path);
        validatePredictionFile(
            fileName,
            artifact.subarray(0, PREDICTION_HEAD_BYTES),
        );
        return {
            task: prepareJudgeTask({
                ...base,
                submission_mode: judgeMode,
                language: "python3",
                code: "",
                file_name: fileName,
                llm: llmTask,
            }),
            artifact,
        };
    }
    if (mode === "artifact") {
        const artifact = stat.isDirectory
            ? await zipDirectory(solution.path)
            : await Deno.readFile(solution.path);
        return {
            task: prepareJudgeTask({
                ...base,
                submission_mode: judgeMode,
                language: "python3",
                code: "",
                file_name: stat.isDirectory
                    ? `${solution.name}.zip`
                    : basename(solution.path),
                llm: llmTask,
            }),
            artifact,
        };
    }

    if (!stat.isFile) throw new Error(`解答必须是文件：${solution.path}`);
    const code = await Deno.readTextFile(solution.path);
    if (mode === "ui") {
        const templateName = manifest.template ?? "template.py";
        const scriptTemplate = await Deno.readTextFile(
            join(problemDir, templateName),
        );
        return {
            task: prepareJudgeTask({
                ...base,
                submission_mode: judgeMode,
                language: "ui",
                code,
                script_template: scriptTemplate,
                file_name: "params.json",
                llm: llmTask,
            }),
        };
    }
    return {
        task: prepareJudgeTask({
            ...base,
            submission_mode: judgeMode,
            language: "python3",
            code,
            file_name: basename(solution.path),
            llm: llmTask,
        }),
    };
}

/** `noj-judge run-local` 的输出封套。 */
interface LocalJudgeOutput {
    result: {
        status: string;
        score: number;
        output: string;
        details: unknown;
        time_ms?: number;
    };
    wall_ms: number;
    notes: string[];
    error?: string;
}

/** judge 二进制不可用（环境问题，按用法错误处理）。 */
export class JudgeUnavailableError extends Error {}

/** 定位 noj-judge：显式参数 → NOJ_JUDGE_BIN → PATH 上的 noj-judge。 */
export function resolveJudgeBin(explicit?: string): string {
    return explicit ?? Deno.env.get("NOJ_JUDGE_BIN") ?? "noj-judge";
}

/** 调用 `noj-judge run-local` 执行一个任务。 */
export async function runLocalJudge(
    prepared: PreparedSubmission,
    supportPackage: string | null,
    options: LocalRunOptions,
    scratch: string,
): Promise<LocalJudgeOutput> {
    const taskPath = join(scratch, `${prepared.task.submission_id}.task.json`);
    await Deno.writeTextFile(taskPath, JSON.stringify(prepared.task));
    const args = [
        RUN_LOCAL_SUBCOMMAND,
        "--task",
        taskPath,
    ];
    if (supportPackage) args.push("--support-package", supportPackage);
    if (prepared.artifact) {
        const artifactPath = join(
            scratch,
            `${prepared.task.submission_id}.artifact`,
        );
        await Deno.writeFile(artifactPath, prepared.artifact);
        args.push("--artifact", artifactPath);
    }
    if (options.allowNetwork) {
        args.push("--allow-network");
        if (options.network) args.push("--network", options.network);
    }
    let out: Deno.CommandOutput;
    try {
        out = await new Deno.Command(options.judgeBin, {
            args,
            env: JUDGE_ISOLATION_ENV,
            stdout: "piped",
            stderr: "piped",
        }).output();
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            throw new JudgeUnavailableError(
                `找不到 noj-judge（${options.judgeBin}）。请用 --judge-bin 或 NOJ_JUDGE_BIN 指定，` +
                    "或在仓库内执行 cargo build --release --manifest-path noj-judge/Cargo.toml",
            );
        }
        throw err;
    }
    const stdout = new TextDecoder().decode(out.stdout).trim();
    const stderr = new TextDecoder().decode(out.stderr).trim();
    if (out.code === 2) {
        throw new JudgeUnavailableError(
            `noj-judge 不支持 run-local 或参数有误（请更新 noj-judge）：${stderr}`,
        );
    }
    if (out.code !== 0) {
        throw new Error(
            `noj-judge run-local 失败（退出码 ${out.code}）：${stderr}`,
        );
    }
    const lastLine = stdout.split("\n").pop() ?? "";
    try {
        return JSON.parse(lastLine) as LocalJudgeOutput;
    } catch {
        throw new Error(
            `noj-judge run-local 输出不是 JSON：${stdout.slice(-500)}`,
        );
    }
}

/**
 * 传给 noj-judge 的兜底环境：run-local 不需要 Redis，指向不可达地址可保证
 * 即使误用了不认识 `run-local` 的旧版二进制，它也无法连上队列消费任务。
 */
const JUDGE_ISOLATION_ENV: Record<string, string> = {
    REDIS_URL: "redis://127.0.0.1:1/0",
};

/** 探测超时：新版 `run-local --help` 立即返回，超时即视为不兼容。 */
const JUDGE_PROBE_TIMEOUT_MS = 10_000;

/** `run-local --help` 输出中必须出现的标记。 */
export const RUN_LOCAL_USAGE_MARKER = "noj-judge run-local";

/**
 * 运行评测前确认 judge 支持 `run-local`。
 *
 * 旧版 noj-judge 忽略命令行参数、直接启动 Worker 主循环；探测时额外把 Docker
 * 也指向不存在的 socket，并在超时后强制结束，确保探测本身不可能消费队列。
 */
export async function probeJudge(judgeBin: string): Promise<void> {
    let child: Deno.ChildProcess;
    try {
        child = new Deno.Command(judgeBin, {
            args: [RUN_LOCAL_SUBCOMMAND, "--help"],
            env: {
                ...JUDGE_ISOLATION_ENV,
                JUDGE_DOCKER_HOST:
                    "unix:///nonexistent/noj-problem-test-probe.sock",
            },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        }).spawn();
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            throw new JudgeUnavailableError(
                `找不到 noj-judge（${judgeBin}）。请用 --judge-bin 或 NOJ_JUDGE_BIN 指定，` +
                    "或在仓库内执行 cargo build --release --manifest-path noj-judge/Cargo.toml",
            );
        }
        throw err;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try {
            child.kill("SIGKILL");
        } catch {
            // 进程已退出
        }
    }, JUDGE_PROBE_TIMEOUT_MS);
    const out = await child.output().finally(() => clearTimeout(timer));
    const stdout = new TextDecoder().decode(out.stdout);
    if (
        timedOut || out.code !== 0 || !stdout.includes(RUN_LOCAL_USAGE_MARKER)
    ) {
        throw new JudgeUnavailableError(
            `${judgeBin} 不支持 run-local（可能是旧版 noj-judge），请更新后重试`,
        );
    }
}

/**
 * 客观题判分：解答文件为 `{"<key 或从 1 开始的序号>": [答案...]}`，
 * 与生产一样调用 core 的 `judgePaper`。
 */
export async function judgeObjective(
    problemDir: string,
    solution: SolutionSpec,
): Promise<SolutionReport> {
    const started = performance.now();
    const questions = validateObjectiveQuestions(
        JSON.parse(await Deno.readTextFile(join(problemDir, "questions.json"))),
    );
    const raw = JSON.parse(await Deno.readTextFile(solution.path)) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
            `客观题解答必须是 {题号: 答案数组} 对象：${solution.path}`,
        );
    }
    const answers = raw as Record<string, unknown>;
    const judged = judgePaper({
        questions: questions.map((q, i) => ({
            id: q.key ?? String(i + 1),
            type: q.type,
            answer: q.answer,
            explanation: q.explanation ?? "",
        })),
        answers: Object.fromEntries(
            Object.entries(answers).map((
                [k, v],
            ) => [k, Array.isArray(v) ? v : [v]]),
        ) as Record<string, (string | boolean)[]>,
    });
    return {
        name: solution.name,
        path: solution.path,
        score: judged.score / 100,
        status: "finished",
        time_ms: null,
        wall_ms: Math.round(performance.now() - started),
        stderr: "",
        notes: [],
        error: null,
        details: {
            correct_count: judged.correct_count,
            total_count: judged.total_count,
        },
    };
}

/** 运行一个解答（客观题走 core 判分，其余走 noj-judge run-local）。 */
export async function runSolution(
    problemDir: string,
    manifest: ProblemBundleManifest,
    solution: SolutionSpec,
    supportPackage: string | null,
    options: LocalRunOptions,
    scratch: string,
): Promise<SolutionReport> {
    if (manifest.kind === "objective") {
        return await judgeObjective(problemDir, solution);
    }
    const prepared = await prepareSubmission(
        problemDir,
        manifest,
        solution,
        options.llm,
    );
    const out = await runLocalJudge(
        prepared,
        supportPackage,
        options,
        scratch,
    );
    return {
        name: solution.name,
        path: solution.path,
        score: Math.round(out.result.score) / 100,
        status: out.result.status,
        time_ms: out.result.time_ms ?? null,
        wall_ms: out.wall_ms,
        stderr: stderrSummary(out.result.output ?? ""),
        notes: out.notes ?? [],
        error: out.error ?? null,
        details: out.result.details,
    };
}
