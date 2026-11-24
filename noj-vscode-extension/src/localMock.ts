import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { extractSourceLocations } from "./feedbackAdapter";
import type {
  EvaluationBadcase,
  EvaluationDimensionScore,
  EvaluationFeedback,
  LlmTraceEntry,
  MockLlmConfig,
} from "./types";
import { packWorkspaceZip } from "./zipBuilder";

/** 粗略估算文本 Token 数（约 4 字符 = 1 token）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

/** 读取工作区 `.noj/mock-llm.json` 配置（不存在时返回空配置）。 */
export async function loadMockLlmConfig(
  workspaceRoot: string | undefined,
): Promise<MockLlmConfig> {
  if (!workspaceRoot) return {};
  const target = path.join(workspaceRoot, ".noj", "mock-llm.json");
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as MockLlmConfig;
  } catch {
    return {};
  }
}

function matchMockRule(
  promptText: string,
  config: MockLlmConfig,
): { reply: string; delayMs: number; model?: string } {
  const lower = promptText.toLowerCase();
  for (const rule of config.rules ?? []) {
    if (!rule || typeof rule.reply !== "string") continue;
    if (!rule.match || lower.includes(rule.match.toLowerCase())) {
      return {
        reply: rule.reply,
        delayMs: rule.delayMs ?? config.defaultDelayMs ?? 0,
        model: rule.model,
      };
    }
  }
  const reply =
    config.defaultReply ??
    `[Neuro OJ Mock LLM] ${promptText.trim().slice(0, 200) || "ok"}`;
  return { reply, delayMs: config.defaultDelayMs ?? 0 };
}

function extractChatPromptText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length > 0) {
    return messages
      .map((msg) => {
        if (!msg || typeof msg !== "object") return "";
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((part) =>
              part && typeof part === "object"
                ? String((part as Record<string, unknown>).text ?? "")
                : "",
            )
            .join(" ");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof body.input === "string") return body.input;
  return JSON.stringify(body.input ?? "");
}

export interface LocalLlmMockServer {
  readonly port: number;
  readonly baseUrl: string;
  getTraces(): LlmTraceEntry[];
  close(): Promise<void>;
}

/** 启动内置轻量 OpenAI-compatible Mock HTTP Server 并记录调用 Trace。 */
export async function startLocalLlmMockServer(
  config: MockLlmConfig = {},
): Promise<LocalLlmMockServer> {
  const serverStartAt = Date.now();
  const traces: LlmTraceEntry[] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "mock-gpt-4o-mini",
              object: "model",
              owned_by: "neuro-oj-mock",
            },
          ],
        }),
      );
      return;
    }

    const isChat =
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" ||
        url.pathname === "/chat/completions");
    const isResponses =
      req.method === "POST" && url.pathname === "/v1/responses";

    if (!isChat && !isResponses) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Mock route not found" } }));
      return;
    }

    const reqStart = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      return;
    }

    const promptText = extractChatPromptText(body);
    const matched = matchMockRule(promptText, config);
    if (matched.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, matched.delayMs));
    }

    const model =
      matched.model ??
      (typeof body.model === "string" && body.model
        ? body.model
        : "mock-gpt-4o-mini");
    const promptTokens = estimateTokens(promptText);
    const completionTokens = estimateTokens(matched.reply);
    const totalTokens = promptTokens + completionTokens;
    const durationMs = Math.max(1, Date.now() - reqStart);

    traces.push({
      index: traces.length + 1,
      model,
      startedAtMs: Math.max(0, reqStart - serverStartAt),
      durationMs,
      promptTokens,
      completionTokens,
      totalTokens,
      status: "ok",
      requestPreview: promptText.slice(0, 400),
      responsePreview: matched.reply.slice(0, 400),
    });

    if (isResponses) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `resp_mock_${traces.length}`,
          object: "response",
          model,
          output_text: matched.reply,
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        }),
      );
      return;
    }

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const chunkPayload = {
        id: `chatcmpl_mock_${traces.length}`,
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: matched.reply },
            finish_reason: "stop",
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_mock_${traces.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: matched.reply },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法获取本地 Mock HTTP Server 监听端口");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getTraces: () => [...traces],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** 检测本机是否安装并可执行 `noj-judge`。 */
export async function isLocalJudgeAvailable(
  binary = "noj-judge",
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(binary, ["run-local", "--help"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** 构造用于 `noj-judge run-local` 的同构 `JudgeTask` JSON。 */
export function buildLocalJudgeTask(params: {
  code: string;
  fileName: string;
  submissionMode?: "code" | "artifact" | "prediction";
  judgeType?: "dual" | "oi";
  gatewayUrl?: string;
}): Record<string, unknown> {
  const mode = params.submissionMode ?? "code";
  const judgeType = params.judgeType ?? "dual";
  const runtimeConfig =
    judgeType === "oi"
      ? {
          backend: "native",
          time_limit_ms: 2000,
          memory_limit_mb: 256,
          subtasks: [],
        }
      : {
          evaluator: {
            image: "python",
            command: ["python3", "evaluate.py"],
            time_limit_ms: 30000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "python",
            time_limit_ms: 10000,
            memory_limit_mb: 512,
          },
        };

  return {
    submission_id: `local-${Date.now()}`,
    problem_id: "local-problem",
    user_id: "local-user",
    submission_mode: mode,
    judge_type: judgeType,
    download_url: null,
    runtime_config: runtimeConfig,
    language: "python3",
    code: params.code,
    file_name: params.fileName,
    llm: {
      gateway_url: params.gatewayUrl ?? "mock://echo",
      eval_token: "noj-local-mock",
      provider_id: "mock",
      allowed_models: ["mock-gpt-4o-mini"],
    },
  };
}

/** 轨道 A：调用本机 `noj-judge run-local` 运行本地容器评测。 */
export async function runLocalJudgeTrack(options: {
  binary: string;
  title: string;
  code: string;
  fileName: string;
  workspaceRoot?: string;
  submissionMode?: "code" | "artifact" | "prediction";
  judgeType?: "dual" | "oi";
  supportPackagePath?: string;
  mockServer?: LocalLlmMockServer;
  allowNetwork?: boolean;
}): Promise<EvaluationFeedback> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-vscode-local-"));
  try {
    const gatewayUrl =
      options.allowNetwork && options.mockServer
        ? `http://host.docker.internal:${options.mockServer.port}/v1`
        : "mock://echo";
    const task = buildLocalJudgeTask({
      code: options.code,
      fileName: options.fileName,
      submissionMode: options.submissionMode,
      judgeType: options.judgeType,
      gatewayUrl,
    });
    const taskPath = path.join(tempDir, "task.json");
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf8");

    const args = ["run-local", "--task", taskPath];
    if (options.supportPackagePath) {
      args.push("--support-package", options.supportPackagePath);
    }
    if (options.submissionMode === "artifact" && options.workspaceRoot) {
      const zip = await packWorkspaceZip(options.workspaceRoot);
      const zipPath = path.join(tempDir, "artifact.zip");
      await fs.writeFile(zipPath, zip.buffer);
      args.push("--artifact", zipPath);
    }
    if (options.allowNetwork) {
      args.push("--allow-network");
    }

    const exec = await execProcess(options.binary, args, {
      cwd: options.workspaceRoot,
      timeoutMs: 120_000,
    });

    const parsed = parseLocalJudgeOutput(exec.stdout);
    const traces = options.mockServer?.getTraces() ?? [];
    if (!parsed) {
      const combined = [exec.stdout, exec.stderr].filter(Boolean).join("\n");
      return {
        source: "local_mock",
        title: options.title,
        status: exec.exitCode === 0 ? "finished" : "error",
        score: null,
        maxScore: 100,
        summary: `noj-judge 退出码 ${exec.exitCode}`,
        output: combined || "noj-judge 未返回结构化结果",
        dimensions: [],
        badcases: [],
        traces,
        locations: extractSourceLocations(combined),
      };
    }

    const result = (parsed.result ?? {}) as Record<string, unknown>;
    const rawScore = typeof result.score === "number" ? result.score : null;
    const output =
      typeof result.output === "string" ? result.output : exec.stderr;
    const details =
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : undefined;
    return buildLocalFeedbackFromDetails({
      title: options.title,
      status:
        (typeof result.status === "string" ? result.status : undefined) ??
        (exec.exitCode === 0 ? "finished" : "error"),
      score: rawScore !== null ? Number((rawScore / 100).toFixed(2)) : null,
      timeMs:
        typeof parsed.wall_ms === "number"
          ? parsed.wall_ms
          : typeof result.time_ms === "number"
            ? result.time_ms
            : null,
      memoryKb: typeof result.memory_kb === "number" ? result.memory_kb : null,
      summary:
        typeof parsed.error === "string"
          ? parsed.error
          : Array.isArray(parsed.notes) && parsed.notes.length > 0
            ? parsed.notes.join("；")
            : "noj-judge run-local 执行完成",
      output,
      details,
      traces,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** 轨道 B：零 Docker 轻量 Python 调试（优先 `.noj/local_eval.py`，否则直接执行当前脚本）。 */
export async function runPythonMockTrack(options: {
  pythonBinary: string;
  title: string;
  entryFilePath: string;
  workspaceRoot?: string;
  sampleInput?: string;
  mockServer: LocalLlmMockServer;
}): Promise<EvaluationFeedback> {
  const cwd = options.workspaceRoot ?? path.dirname(options.entryFilePath);
  const localEvalPath = path.join(cwd, ".noj", "local_eval.py");
  let hasLocalEval = false;
  try {
    await fs.access(localEvalPath);
    hasLocalEval = true;
  } catch {
    hasLocalEval = false;
  }

  const targetScript = hasLocalEval ? localEvalPath : options.entryFilePath;
  const startedAt = Date.now();
  const exec = await execProcess(options.pythonBinary, [targetScript], {
    cwd,
    stdinText: options.sampleInput,
    timeoutMs: 60_000,
    env: {
      OPENAI_BASE_URL: options.mockServer.baseUrl,
      OPENAI_API_BASE: options.mockServer.baseUrl,
      NOJ_LLM_GATEWAY_URL: options.mockServer.baseUrl,
      OPENAI_API_KEY: "noj-local-mock",
      NOJ_ENTRY_FILE: path.relative(cwd, options.entryFilePath),
      NOJ_SUBMISSION_FILE: options.entryFilePath,
      NOJ_SAMPLE_INPUT: options.sampleInput ?? "",
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const traces = options.mockServer.getTraces();

  const structured = parseStructuredLocalStdout(exec.stdout);
  const combinedOutput = [
    exec.stdout.trim(),
    exec.stderr.trim() ? `[stderr]\n${exec.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (structured) {
    const rawScore =
      typeof structured.score === "number" ? structured.score : null;
    const score =
      rawScore !== null && rawScore > 100
        ? Number((rawScore / 100).toFixed(2))
        : rawScore;
    return buildLocalFeedbackFromDetails({
      title: options.title,
      status:
        typeof structured.status === "string"
          ? structured.status
          : exec.exitCode === 0
            ? "finished"
            : "error",
      score,
      timeMs: elapsedMs,
      memoryKb: null,
      summary:
        typeof structured.summary === "string"
          ? structured.summary
          : hasLocalEval
            ? "已完成 .noj/local_eval.py 本地验证"
            : "已完成本地 Mock 运行",
      output: combinedOutput,
      details: structured,
      traces,
    });
  }

  const ok = exec.exitCode === 0;
  return {
    source: "local_mock",
    title: options.title,
    status: ok ? "finished" : "error",
    score: ok ? 100 : 0,
    maxScore: 100,
    summary: hasLocalEval
      ? `.noj/local_eval.py 退出码 ${exec.exitCode}`
      : `Python 本地 Mock 运行退出码 ${exec.exitCode}`,
    output: combinedOutput || "(无标准输出)",
    timeMs: elapsedMs,
    memoryKb: null,
    metering: summarizeTraces(traces),
    dimensions: [],
    badcases: ok
      ? []
      : [
          {
            caseId: "local-run",
            status: "RE",
            input: options.sampleInput,
            actual: exec.stderr || exec.stdout,
            message: `进程退出码 ${exec.exitCode}`,
            location: extractSourceLocations(exec.stderr || exec.stdout)[0],
          },
        ],
    traces,
    locations: extractSourceLocations(combinedOutput),
  };
}

function summarizeTraces(
  traces: readonly LlmTraceEntry[],
): EvaluationFeedback["metering"] | undefined {
  if (traces.length === 0) return undefined;
  const promptTokens = traces.reduce((sum, t) => sum + t.promptTokens, 0);
  const completionTokens = traces.reduce(
    (sum, t) => sum + t.completionTokens,
    0,
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: null,
    callCount: traces.length,
  };
}

function parseLocalJudgeOutput(
  stdout: string,
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseStructuredLocalStdout(
  stdout: string,
): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].startsWith("__NOJ_RESULT__:")
      ? lines[i].slice("__NOJ_RESULT__:".length).trim()
      : lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildLocalFeedbackFromDetails(params: {
  title: string;
  status: string;
  score: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  summary: string;
  output: string;
  details?: Record<string, unknown>;
  traces: LlmTraceEntry[];
}): EvaluationFeedback {
  const dimensions: EvaluationDimensionScore[] = Array.isArray(
    params.details?.dimensions,
  )
    ? (params.details!.dimensions as Array<Record<string, unknown>>)
        .filter(
          (d) => d && typeof d.name === "string" && typeof d.score === "number",
        )
        .map((d) => ({
          name: String(d.name),
          score: Number(d.score),
          maxScore: typeof d.max_score === "number" ? d.max_score : 100,
        }))
    : [];

  const rawCases = Array.isArray(params.details?.badcases)
    ? params.details!.badcases
    : Array.isArray(params.details?.cases)
      ? params.details!.cases
      : [];
  const badcases: EvaluationBadcase[] = [];
  for (let i = 0; i < rawCases.length; i++) {
    const c = rawCases[i] as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    const status = String(c.status ?? "FAIL");
    if (
      Array.isArray(params.details?.cases) &&
      /^(AC|PASS|PASSED|OK)$/i.test(status)
    ) {
      continue;
    }
    const msg = typeof c.message === "string" ? c.message : undefined;
    badcases.push({
      caseId: String(c.case_id ?? c.id ?? `#${i + 1}`),
      status,
      input: typeof c.input === "string" ? c.input : undefined,
      expected:
        typeof c.expected === "string"
          ? c.expected
          : typeof c.expected_output === "string"
            ? c.expected_output
            : undefined,
      actual:
        typeof c.actual === "string"
          ? c.actual
          : typeof c.actual_output === "string"
            ? c.actual_output
            : undefined,
      message: msg,
      location: msg ? extractSourceLocations(msg)[0] : undefined,
    });
  }

  return {
    source: "local_mock",
    title: params.title,
    status: params.status,
    score: params.score,
    maxScore: 100,
    summary: params.summary,
    output: params.output,
    timeMs: params.timeMs,
    memoryKb: params.memoryKb,
    metering: summarizeTraces(params.traces),
    dimensions,
    badcases,
    traces: params.traces,
    locations: extractSourceLocations(params.output),
  };
}

function execProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdinText?: string;
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`本地进程执行超时（>${options.timeoutMs / 1000}s）`));
    }, options.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    if (options.stdinText !== undefined) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}
