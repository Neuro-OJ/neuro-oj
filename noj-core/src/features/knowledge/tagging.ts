/**
 * AI 打标（P1，默认关闭）：`knowledge.tag` 任务、提示词构造、回填预估与管理 API。
 *
 * 流程见 openspec/changes/add-knowledge-graph/design.md 第 5、6 节。核心约束：
 * - 只有题目发布新版本才投递任务（`problems/services/versioning/publish.ts`，以
 *   字符串任务类型约定，不 import 本目录）；内容 hash 不变、已有人工挂载、
 *   开关关闭时不调用模型；
 * - 发送给模型的内容严格白名单：题型、标题、题面、公开样例、评测模式与
 *   评测器/参考解截断摘要；**绝不发送隐藏测试数据或用户提交**；
 * - 候选知识点只发 `id + 名称`（不含 summary），system 消息在同一图谱版本内
 *   逐字节稳定以命中服务商提示词缓存；
 * - 每月 token 预算封顶：超预算暂停任务到下个自然月，不重试预算类错误。
 */
import { and, eq, sql } from "drizzle-orm";
import { isUserAdmin } from "../../modules/access/contracts/cross-module/identity_services_security_permissions.ts";
import { loadDomainProblemProtection } from "../../modules/access/index.ts";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import type { UserActor } from "../../modules/access/contracts/actor.ts";
import {
  getSetting,
  KNOWLEDGE_TAG_MODEL_ALIAS,
  listLlmGatewayModelAliases,
  platformCompletion,
  PlatformCompletionError,
  queryPlatformUsage,
  recordAudit,
} from "../../modules/platform/index.ts";
import {
  enqueueTaskTx,
  isTaskRescheduleResult,
} from "../../modules/runtime/index.ts";
import type {
  ClaimedTask,
  TaskHandler,
  TaskRescheduleResult,
} from "../../modules/runtime/index.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import {
  knowledgeNodes,
  knowledgeTagRuns,
  problemKnowledge,
  problems,
  problemVersions,
} from "../../shared/db/schema.ts";
import type { AiMappingResult } from "./mappings.ts";
import { applyAiMapping } from "./mappings.ts";
import {
  isWithinWindow,
  nextWindowStart,
  offpeakAvailableAt,
  offpeakNow,
  offpeakView,
  readOffpeakPolicy,
} from "./offpeak.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from "../../shared/base/errors.ts";

/** 任务类型（模块间以字符串约定，避免运行时循环依赖）。 */
export const KNOWLEDGE_TAG_TASK_TYPE = "knowledge.tag";

/** 提示词版本：改提示词或截断上限时递增，便于筛选旧记录重跑。 */
export const TAG_PROMPT_VERSION = "knowledge-tag-v1";

/** 输出 token 上限（只输出一个小 JSON）。 */
export const TAG_MAX_OUTPUT_TOKENS = 300;

/** 题面上限（字符）。 */
export const TAG_DESCRIPTION_LIMIT_CHARS = 4000;
/** 公开样例合计上限（字符）。 */
export const TAG_SAMPLES_LIMIT_CHARS = 1000;
/** 评测器 / 参考解等对比上限（字符）。 */
export const TAG_JUDGE_LIMIT_CHARS = 1000;
/**
 * 合计上限 ≈ 6000 字符（design 第 6 节「默认合计约 2k token」的 3 倍余量：
 * 中文题面按约 0.7 token/字估算，6000 字符 ≈ 4200 token；三档上限分别截断，
 * 保证单次调用的输入成本可预期）。
 */
export const TAG_INPUT_TOTAL_LIMIT_CHARS = TAG_DESCRIPTION_LIMIT_CHARS +
  TAG_SAMPLES_LIMIT_CHARS + TAG_JUDGE_LIMIT_CHARS;

/** 合法输出最多几个次要知识点（与 `MAX_SECONDARY_NODES` 一致）。 */
const MAX_TAG_SECONDARY = 3;

/** 预算暂停时的记录状态。 */
export type TagRunStatus = "succeeded" | "failed" | "skipped" | "budget_paused";

/** 模型调用结果（可注入，测试不得发起真实网络请求）。 */
export interface TagCompletionResult {
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** 模型调用函数签名。 */
export type TagCompleter = (input: {
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  temperature: number;
}) => Promise<TagCompletionResult>;

let completerOverride: TagCompleter | null = null;

/** 测试注入点：传 `null` 恢复默认（网关 `platformCompletion`）。 */
export function setTagCompleterForTest(fn: TagCompleter | null): void {
  completerOverride = fn;
}

/** 默认调用：平台身份经网关，别名 `platform.tagger`。 */
const gatewayCompleter: TagCompleter = async (input) => {
  const result = await platformCompletion({
    purpose: "knowledge.tag",
    model_alias: KNOWLEDGE_TAG_MODEL_ALIAS,
    messages: input.messages,
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    response_format: { type: "json_object" },
  });
  return {
    content: result.content,
    model: result.model,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
  };
};

function completer(): TagCompleter {
  return completerOverride ?? gatewayCompleter;
}

/** 读取布尔设置。 */
function boolSetting(key: string): boolean {
  return getSetting(key)?.value === true;
}

/** 读取整数设置（异常值回落默认）。 */
function intSetting(key: string, fallback: number): number {
  const value = getSetting(key)?.value;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/** 总开关 + AI 打标开关都开启时才允许调用模型。 */
export function isTaggingEnabled(): boolean {
  return boolSetting("knowledge_enabled") &&
    boolSetting("knowledge_ai_tagging_enabled");
}

/** 自动生效阈值（整数 0–100）转 0–1 小数。 */
export function autoAcceptThreshold(): number {
  const value = intSetting("knowledge_auto_accept_threshold", 75);
  return Math.max(0, Math.min(100, value)) / 100;
}

/** 月度 token 预算（输入+输出合计，按自然月）；0 表示暂停所有调用。 */
export function monthlyTokenBudget(): number {
  return Math.max(0, intSetting("knowledge_ai_monthly_token_budget", 2000000));
}

/** 本自然月起点（UTC，按自然月计费周期）。 */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 下个自然月起点（预算暂停的恢复时刻）。 */
export function nextMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// ── 提示词 ──────────────────────────────────────────────

/** 候选知识点：只取 id + 名称，按 id 排序保证逐字节稳定。 */
export async function loadTagCandidates(
  db: DbRoot = getDb(),
): Promise<
  { packVersion: string | null; nodes: { id: string; name: string }[] }
> {
  const rows = await db.select({
    id: knowledgeNodes.id,
    name: knowledgeNodes.name,
    pack_id: knowledgeNodes.pack_id,
  }).from(knowledgeNodes).where(eq(knowledgeNodes.status, "active"));
  // 只保留当前生效包（全表至多一行 active）下的节点；无 active 包时为空。
  const [pack] = await db.execute(
    sql`SELECT id, version FROM knowledge_packs WHERE active = true LIMIT 1`,
  ) as unknown as { id: string; version: string }[];
  const nodes = pack
    ? rows.filter((row) => row.pack_id === pack.id)
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    : [];
  return { packVersion: pack ? `${pack.id}@${pack.version}` : null, nodes };
}

/**
 * system 消息：固定指令 + 全部 active 节点的 `id 名称` 列表。
 *
 * 不含 summary，同一图谱版本内（节点与名称不变）逐字节一致，排在消息最前，
 * 以命中服务商的提示词缓存。
 */
export function buildTagSystemPrompt(
  nodes: readonly { id: string; name: string }[],
): string {
  // 函数内再排序一次：调用方传什么顺序都得到同一字节串（提示词缓存的前提）。
  const lines = [...nodes].map((node) => ({ ...node }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((node) => `${node.id} ${node.name}`).join("\n");
  return [
    "你是算法竞赛题库的知识点归类助手。",
    "从下面给出的候选知识点中，为用户提供的题目选择最合适的主知识点与至多次要知识点。",
    "只能使用候选列表里出现的 id，不得编造 id，不得输出候选列表之外的内容。",
    "只输出一个 JSON 对象，不要输出 Markdown 代码块或其他文字，格式：",
    '{"primary": "<主知识点 id>", "secondary": ["<次要 id>", "..."], "confidence": <0 到 1 之间的小数>, "rationale": "<不超过 80 字的中文理由>"}',
    "要求：primary 必填且只能一个；secondary 最多 3 个、不得包含 primary，没有就输出空数组；confidence 表示你对该主知识点的把握程度。",
    "",
    "候选知识点（id 名称）：",
    lines,
  ].join("\n");
}

/** 截断：超长时截断并标注总长度。 */
export function truncateText(text: string, limit: number): string {
  const value = text ?? "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，原文共 ${value.length} 字符）`;
}

/** user 消息的题型专属部分：只取截断后的配置摘要，不含测试数据。 */
function describeKind(content: Record<string, unknown>): string[] {
  const kind = content.kind;
  if (kind === "objective") {
    const questions = Array.isArray(content.questions)
      ? content.questions.length
      : 0;
    return [`题型：客观题（${questions} 个小题，答案与解析不发送）`];
  }
  if (kind === "oi") {
    const runtime = (content.runtime_config ?? {}) as Record<string, unknown>;
    const judge = typeof runtime.judge === "string"
      ? runtime.judge
      : "未指定评测器";
    return [
      "题型：OI（文件输入输出，隐藏测试数据不发送）",
      `评测器摘要：${truncateText(String(judge), TAG_JUDGE_LIMIT_CHARS)}`,
    ];
  }
  const mode = typeof content.submission_mode === "string"
    ? content.submission_mode
    : "未指定";
  return [`题型：AI 评测（提交模式 ${mode}）`];
}

/**
 * user 消息：题目内容（严格白名单 + 分段截断）。
 *
 * 题面、样例、评测器摘要分别按常量截断，合计不超过
 * `TAG_INPUT_TOTAL_LIMIT_CHARS`；不包含隐藏测试数据、用户提交与参考解原文。
 */
export function buildTagUserPrompt(
  content: Record<string, unknown>,
): string {
  const samples = Array.isArray(content.samples) ? content.samples : [];
  const sampleText = samples.map((sample, index) => {
    const record = (sample ?? {}) as Record<string, unknown>;
    const input = typeof record.input === "string" ? record.input : "";
    const output = typeof record.output === "string" ? record.output : "";
    return `样例 ${index + 1}：\n输入：${input}\n输出：${output}`;
  }).join("\n");
  return [
    `标题：${typeof content.title === "string" ? content.title : ""}`,
    ...describeKind(content),
    "题面：",
    truncateText(
      typeof content.description === "string" ? content.description : "",
      TAG_DESCRIPTION_LIMIT_CHARS,
    ),
    "公开样例：",
    truncateText(sampleText, TAG_SAMPLES_LIMIT_CHARS),
  ].join("\n");
}

// ── 内容与校验 ───────────────────────────────────────────

/** 无 buffer 依赖的 hex 编码。 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 打标内容 hash：题型、标题、题面、样例、评测模式、评测器/参考解摘要。
 *
 * 只覆盖发送给模型的字段，因此「发出去的内容」不变即跳过；不含隐藏测试数据。
 */
export async function computeTagContentHash(
  content: Record<string, unknown>,
): Promise<string> {
  const payload = [
    buildTagUserPrompt(content),
    typeof content.submission_mode === "string"
      ? `mode:${content.submission_mode}`
      : "",
    typeof content.kind === "string" ? `kind:${content.kind}` : "",
    TAG_PROMPT_VERSION,
  ].join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return toHex(new Uint8Array(digest));
}

/** 解析并校验模型输出；不合法返回错误说明。 */
export function parseTagResult(
  raw: string,
  activeIds: ReadonlySet<string>,
): { ok: true; value: AiMappingResult } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "输出不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "输出必须是 JSON 对象" };
  }
  const record = parsed as Record<string, unknown>;
  const primary = record.primary;
  if (typeof primary !== "string" || primary.trim() === "") {
    return { ok: false, error: "primary 必须是非空字符串" };
  }
  if (!activeIds.has(primary.trim())) {
    return { ok: false, error: `primary 不是 active 知识点：${primary}` };
  }
  const secondaryRaw = record.secondary ?? [];
  if (!Array.isArray(secondaryRaw)) {
    return { ok: false, error: "secondary 必须是数组" };
  }
  const secondary: string[] = [];
  for (const item of secondaryRaw) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, error: "secondary 含非字符串条目" };
    }
    const id = item.trim();
    if (id === primary.trim()) {
      return { ok: false, error: "secondary 不能包含 primary" };
    }
    if (!activeIds.has(id)) {
      return { ok: false, error: `secondary 不是 active 知识点：${id}` };
    }
    if (!secondary.includes(id)) secondary.push(id);
  }
  if (secondary.length > MAX_TAG_SECONDARY) {
    return { ok: false, error: `secondary 最多 ${MAX_TAG_SECONDARY} 个` };
  }
  const confidence = record.confidence;
  if (
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
  ) {
    return { ok: false, error: "confidence 必须是 0–1 之间的小数" };
  }
  return {
    ok: true,
    value: { primary: primary.trim(), secondary, confidence },
  };
}

// ── 运行记录 ─────────────────────────────────────────────

async function recordRun(
  input: {
    problemId: string;
    versionId: string | null;
    contentHash: string;
    model: string;
    status: TagRunStatus;
    error?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    rawOutput?: unknown;
  },
  db: DbRoot = getDb(),
): Promise<void> {
  await db.insert(knowledgeTagRuns).values({
    id: crypto.randomUUID(),
    problem_id: input.problemId,
    version_id: input.versionId,
    content_hash: input.contentHash,
    model: input.model,
    prompt_version: TAG_PROMPT_VERSION,
    input_tokens: input.inputTokens ?? 0,
    output_tokens: input.outputTokens ?? 0,
    status: input.status,
    error: input.error ?? null,
    raw_output: input.rawOutput ?? null,
    created_at: new Date().toISOString(),
  });
}

// ── 任务 ────────────────────────────────────────────────

/** 任务返回摘要。 */
export interface TagTaskOutcome {
  status: TagRunStatus | "not_published" | "disabled" | "rate_limited";
  [key: string]: unknown;
}

/** 上游限流类错误：抛出交由任务框架退避重试（不写 failed 记录）。 */
function isThrottleError(error: unknown): boolean {
  if (!(error instanceof PlatformCompletionError)) return false;
  return error.code === "RATE_LIMITED" ||
    error.code === "PROVIDER_RATE_LIMITED" ||
    error.status === 429;
}

/** 预算/配额类错误：不重试，按预算暂停处理。 */
function isBudgetError(error: unknown): boolean {
  if (!(error instanceof PlatformCompletionError)) return false;
  return error.code === "QUOTA_EXCEEDED" ||
    error.code === "INSUFFICIENT_QUOTA" ||
    error.code === "BUDGET_EXCEEDED" ||
    error.code === "platform_quota_exceeded" ||
    error.code === "platform_budget_exceeded";
}

/** 预算暂停结果。 */
function budgetPaused(
  problemId: string,
  now = new Date(),
): TaskRescheduleResult {
  return {
    __task_control: "reschedule",
    availableAt: nextMonthStart(now).toISOString(),
    payload: { problem_id: problemId },
  };
}

/** 读取月度用量（input+output）。 */
export async function readMonthlyUsage(now: Date = new Date()) {
  const summary = await queryPlatformUsage("knowledge.tag", monthStart(now));
  return {
    ...summary,
    total_tokens: summary.input_tokens + summary.output_tokens,
  };
}

/**
 * `knowledge.tag` 处理器（target = 题目）。
 *
 * 任一步决定不调用模型时，写一条 `skipped` / `budget_paused` 记录后成功返回；
 * 开关关闭时连记录都不写（任务几乎不会被投递，避免刷无效审计）。
 */
export const knowledgeTagHandler: TaskHandler = async (
  task: ClaimedTask,
): Promise<TagTaskOutcome | TaskRescheduleResult> => {
  const problemId = task.targetId;
  // 1. 开关：不调用、不写记录。
  if (!isTaggingEnabled()) return { status: "disabled" };

  // 2. 当前已发布版本。
  const db = getDb();
  const [version] = await db.select({
    id: problemVersions.id,
    content: problemVersions.content,
  }).from(problemVersions)
    .innerJoin(problems, eq(problems.latest_version_id, problemVersions.id))
    .where(and(
      eq(problemVersions.problem_id, problemId),
      eq(problems.id, problemId),
    )).limit(1);
  if (!version) return { status: "not_published" };
  const content = (version.content ?? {}) as Record<string, unknown>;
  const contentHash = await computeTagContentHash(content);

  // 3. 同 hash 已成功过 → skipped。
  const [previous] = await db.select({ id: knowledgeTagRuns.id })
    .from(knowledgeTagRuns).where(and(
      eq(knowledgeTagRuns.problem_id, problemId),
      eq(knowledgeTagRuns.content_hash, contentHash),
      eq(knowledgeTagRuns.status, "succeeded"),
    )).limit(1);
  if (previous) {
    await recordRun({
      problemId,
      versionId: version.id,
      contentHash,
      model: "",
      status: "skipped",
      error: "content_hash_unchanged",
    }, db);
    return { status: "skipped", reason: "content_hash_unchanged" };
  }

  // 4. 人工挂载优先。
  const [human] = await db.select({ node_id: problemKnowledge.node_id })
    .from(problemKnowledge).where(and(
      eq(problemKnowledge.problem_id, problemId),
      eq(problemKnowledge.source, "human"),
    )).limit(1);
  if (human) {
    await recordRun({
      problemId,
      versionId: version.id,
      contentHash,
      model: "",
      status: "skipped",
      error: "human_mapping_exists",
    }, db);
    return { status: "skipped", reason: "human_mapping_exists" };
  }

  // 5. 低峰时段：默认只在低峰时段调用模型（不调用、不写记录，直接顺延）。
  const offpeak = readOffpeakPolicy();
  const now = offpeakNow();
  if (offpeak.enabled && !isWithinWindow(now, offpeak.window)) {
    return {
      __task_control: "reschedule",
      availableAt: nextWindowStart(now, offpeak.window).toISOString(),
      payload: { problem_id: problemId },
    };
  }

  // 6. 月度预算。
  const budget = monthlyTokenBudget();
  if (budget === 0) {
    await recordRun({
      problemId,
      versionId: version.id,
      contentHash,
      model: "",
      status: "budget_paused",
      error: "budget_zero",
    }, db);
    return budgetPaused(problemId);
  }
  const usage = await readMonthlyUsage();
  if (usage.total_tokens >= budget) {
    await recordRun({
      problemId,
      versionId: version.id,
      contentHash,
      model: "",
      status: "budget_paused",
      error: `monthly_budget_exhausted:${usage.total_tokens}/${budget}`,
    }, db);
    return budgetPaused(problemId);
  }

  // 7. 构造提示词（system 固定在前以命中提示词缓存）。
  const candidates = await loadTagCandidates(db);
  const activeIds = new Set(candidates.nodes.map((node) => node.id));
  const messages = [
    {
      role: "system" as const,
      content: buildTagSystemPrompt(candidates.nodes),
    },
    { role: "user" as const, content: buildTagUserPrompt(content) },
  ];

  // 8/9. 调用 + 校验；非法输出再调用一次，仍非法记 failed。
  const threshold = autoAcceptThreshold();
  let lastError = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";
  let rawOutput: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: TagCompletionResult;
    try {
      result = await completer()({
        messages,
        max_tokens: TAG_MAX_OUTPUT_TOKENS,
        temperature: 0,
      });
    } catch (error) {
      if (isThrottleError(error)) {
        // 限流：抛出交由任务框架退避重试，不写终态记录。
        return { status: "rate_limited" } as TagTaskOutcome;
      }
      if (isBudgetError(error)) {
        await recordRun({
          problemId,
          versionId: version.id,
          contentHash,
          model,
          status: "budget_paused",
          error: error instanceof PlatformCompletionError
            ? error.code
            : "budget",
          inputTokens,
          outputTokens,
        }, db);
        return budgetPaused(problemId);
      }
      if (
        error instanceof PlatformCompletionError &&
        error.code === "MODEL_ALIAS_NOT_CONFIGURED"
      ) {
        await recordRun({
          problemId,
          versionId: version.id,
          contentHash,
          model,
          status: "skipped",
          error: "MODEL_ALIAS_NOT_CONFIGURED（网关未配置 platform.tagger）",
        }, db);
        return {
          status: "skipped",
          reason: "model_alias_not_configured",
        } as TagTaskOutcome;
      }
      await recordRun({
        problemId,
        versionId: version.id,
        contentHash,
        model,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        inputTokens,
        outputTokens,
      }, db);
      return { status: "failed" } as TagTaskOutcome;
    }
    inputTokens += result.input_tokens;
    outputTokens += result.output_tokens;
    rawOutput = { attempt, content: result.content };
    if (result.model) model = result.model;
    const parsed = parseTagResult(result.content, activeIds);
    if (parsed.ok) {
      // 9. 落库。
      const applied = await applyAiMapping(
        problemId,
        version.id,
        parsed.value,
        threshold,
      );
      await recordRun({
        problemId,
        versionId: version.id,
        contentHash,
        model,
        status: "succeeded",
        inputTokens,
        outputTokens,
        rawOutput,
      }, db);
      return {
        status: "succeeded",
        outcome: applied.outcome,
        attempts: attempt + 1,
      } as TagTaskOutcome;
    }
    lastError = parsed.error;
  }
  await recordRun({
    problemId,
    versionId: version.id,
    contentHash,
    model,
    status: "failed",
    error: lastError,
    inputTokens,
    outputTokens,
    rawOutput,
  }, db);
  return { status: "failed" };
};

/**
 * 任务类型约定的说明：发布流程（`problems/services/versioning/publish.ts`）以
 * 字符串任务类型 `knowledge.tag` 投递、去重键 `tag:<versionId>`，不 import
 * 本目录；两边字段必须保持一致（测试覆盖发布投递）。
 */

// ── 回填预估 ────────────────────────────────────────────

/**
 * 字符 → token 的换算系数（估算）：中文为主，约 0.7 token/字；纯英文约 0.25。
 * 这里取偏保守的 0.7，只用于回填前的量级预估，不用于计费。
 */
export const ESTIMATE_TOKENS_PER_CHAR = 0.7;

/** 待打标题目（已发布、无人工挂载、最新内容没有成功的打标记录）。 */
export interface BackfillCandidate {
  problem_id: string;
  version_id: string;
  content_hash: string;
  domain_id: string | null;
  owner_id: string;
  user_chars: number;
}

/** 单个题目 user 内容字符数（用于平均输入长度估算）。 */
function userContentChars(content: Record<string, unknown>): number {
  return buildTagUserPrompt(content).length;
}

/**
 * 统计待回填题目。
 *
 * 口径：`problems.latest_version_id` 非空（已发布）；不存在 `source='human'`
 * 的挂载；最新版本的内容 hash 没有对应的 `succeeded` 记录。保密保护期题目
 * 不计入（不对它们调用模型）。
 */
export async function listBackfillCandidates(
  db: DbRoot = getDb(),
): Promise<BackfillCandidate[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS problem_id, v.id AS version_id, v.content AS content,
           p.domain_id AS domain_id, p.owner_id AS owner_id
    FROM problems p
    JOIN problem_versions v ON v.id = p.latest_version_id
    LEFT JOIN problem_knowledge pk
      ON pk.problem_id = p.id AND pk.source = 'human'
    WHERE pk.problem_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_tag_runs r
        WHERE r.problem_id = p.id AND r.status = 'succeeded'
      )
  `) as unknown as {
    problem_id: string;
    version_id: string;
    content: Record<string, unknown>;
    domain_id: string | null;
    owner_id: string;
  }[];
  const result: BackfillCandidate[] = [];
  for (const row of rows) {
    const content = (row.content ?? {}) as Record<string, unknown>;
    result.push({
      problem_id: row.problem_id,
      version_id: row.version_id,
      content_hash: await computeTagContentHash(content),
      domain_id: row.domain_id,
      owner_id: row.owner_id,
      user_chars: userContentChars(content),
    });
  }
  return result;
}

/** 回填预估结果。 */
export interface TagEstimate {
  expected_count: number;
  avg_user_chars: number;
  prefix_chars: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
  monthly_budget: number;
  estimated_cost: number | null;
  cost_note: string;
  /** 低峰时段策略：回填任务同样在低峰时段执行。 */
  offpeak: { enabled: boolean; window: string; next_start: string | null };
}

/** 生成回填预估。 */
export async function estimateBackfill(
  db: DbRoot = getDb(),
): Promise<TagEstimate> {
  const candidates = await listBackfillCandidates(db);
  const { nodes } = await loadTagCandidates(db);
  const prefixChars = buildTagSystemPrompt(nodes).length;
  const count = candidates.length;
  const avgUser = count === 0 ? 0 : Math.round(
    candidates.reduce((sum, item) => sum + item.user_chars, 0) / count,
  );
  const inputTokens = Math.ceil(
    (prefixChars + avgUser) * ESTIMATE_TOKENS_PER_CHAR,
  ) * count;
  const outputTokens = TAG_MAX_OUTPUT_TOKENS * count;
  return {
    offpeak: offpeakView(),
    expected_count: count,
    avg_user_chars: avgUser,
    prefix_chars: prefixChars,
    estimated_input_tokens: inputTokens,
    estimated_output_tokens: outputTokens,
    estimated_total_tokens: inputTokens + outputTokens,
    monthly_budget: monthlyTokenBudget(),
    estimated_cost: null,
    cost_note:
      "网关仅上报历史调用的实际估算费用（按 Provider 单价），未暴露未来调用的单价，故费用为 null；可用 /tagging/usage 的 cost 与 token 比值估算单价。",
  };
}

// ── 管理 API 支撑 ────────────────────────────────────────

/** 用量视图（`GET /admin/knowledge/tagging/usage`）。 */
export interface TagUsageView {
  month_start: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
  cost: number;
  budget: number;
  remaining: number;
  ai_tagging_enabled: boolean;
  model_alias: string;
  /** 别名是否已在网关配置；网关不可达时为 null。 */
  alias_configured: boolean | null;
  gateway_error: string | null;
  /** 低峰时段策略与下次开始时刻（关闭时 next_start 为 null）。 */
  offpeak: { enabled: boolean; window: string; next_start: string | null };
}

/** 读取用量（网关用量 + 开关 + 别名配置）。 */
export async function readTagUsage(
  now: Date = new Date(),
): Promise<TagUsageView> {
  const month = monthStart(now);
  let usage = { input_tokens: 0, output_tokens: 0, requests: 0, cost: 0 };
  let gatewayError: string | null = null;
  try {
    const summary = await queryPlatformUsage("knowledge.tag", month);
    usage = summary;
  } catch (error) {
    gatewayError = error instanceof Error ? error.message : String(error);
  }
  let aliasConfigured: boolean | null = null;
  try {
    const aliases = await listLlmGatewayModelAliases();
    aliasConfigured = aliases.some((alias) =>
      alias.alias === KNOWLEDGE_TAG_MODEL_ALIAS
    );
  } catch (error) {
    gatewayError = gatewayError ??
      (error instanceof Error ? error.message : String(error));
  }
  const budget = monthlyTokenBudget();
  const total = usage.input_tokens + usage.output_tokens;
  return {
    month_start: month.toISOString(),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: total,
    requests: usage.requests,
    cost: usage.cost,
    budget,
    remaining: Math.max(0, budget - total),
    ai_tagging_enabled: isTaggingEnabled(),
    model_alias: KNOWLEDGE_TAG_MODEL_ALIAS,
    alias_configured: aliasConfigured,
    gateway_error: gatewayError,
    offpeak: offpeakView(now),
  };
}

/**
 * 回填投递。
 *
 * 请求体必须带 `confirm: true` 与预估时返回的 `expected_count`；实际待打标数与
 * `expected_count` 偏差超过 10% 时 409 要求重新预估。按题目去重投递。
 *
 * @param actor 发起人（实例管理员，由路由断言）；用于审计
 */
export async function backfillKnowledgeTags(
  actor: UserActor,
  input: { confirm?: unknown; expected_count?: unknown },
  meta: { ipAddress: string } = { ipAddress: "" },
): Promise<{ enqueued: number; expected_count: number; actual_count: number }> {
  if (input.confirm !== true) {
    throw new BadRequestError("回填须显式确认：请求体带 confirm: true");
  }
  const expected = Number(input.expected_count);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new BadRequestError("expected_count 必须是非负整数（来自预估接口）");
  }
  if (!isTaggingEnabled()) {
    throw new ForbiddenError("AI 打标未开启，不能回填");
  }
  const db = getDb();
  const candidates = await listBackfillCandidates(db);

  // 保密保护期题目不投递（不对保护期题目调用模型）。
  const byDomain = new Map<string, string[]>();
  for (const item of candidates) {
    if (!item.domain_id) continue;
    const list = byDomain.get(item.domain_id) ?? [];
    list.push(item.problem_id);
    byDomain.set(item.domain_id, list);
  }
  const protectedIds = new Set<string>();
  for (const [domainId, ids] of byDomain) {
    const refs = await loadDomainProblemProtection(domainId, ids);
    for (const id of ids) {
      if ((refs.get(id) ?? []).length > 0) protectedIds.add(id);
    }
  }
  const targets = candidates.filter((item) =>
    !protectedIds.has(item.problem_id)
  );

  const actual = targets.length;
  const drifted = expected === 0
    ? actual !== 0
    : Math.abs(actual - expected) / expected > 0.1;
  if (drifted) {
    throw new ConflictError(
      `待打标题目数已变化（预估 ${expected}，实际 ${actual}），请重新预估后确认`,
    );
  }

  const enqueuedIds: string[] = [];
  // 低峰时段：不在时段内时直接排到下一个时段开始，避免白天反复领取再顺延。
  const availableAt = offpeakAvailableAt(offpeakNow());
  await db.transaction(async (tx) => {
    for (const item of targets) {
      await enqueueTaskTx(tx, {
        taskType: KNOWLEDGE_TAG_TASK_TYPE,
        targetKind: "problem",
        targetId: item.problem_id,
        dedupeKey: `tag:${item.version_id}`,
        ...(availableAt ? { availableAt } : {}),
        payload: {
          problem_id: item.problem_id,
          version_id: item.version_id,
        },
      });
      enqueuedIds.push(item.problem_id);
    }
  });
  await recordAudit(
    actor,
    meta,
    "knowledge.mapping.update",
    {
      action: "knowledge.mapping.update",
      operation: "knowledge.tag.backfill",
      expected_count: expected,
      enqueued: enqueuedIds.length,
      protected_skipped: candidates.length - actual,
    },
    { type: "knowledge_backfill", id: "knowledge.tag" },
  );
  return {
    enqueued: enqueuedIds.length,
    expected_count: expected,
    actual_count: actual,
  };
}

/** 管理 API 鉴权：实例管理员。 */
export async function requireTagAdmin(userId: string): Promise<void> {
  if (!(await isUserAdmin(userId))) {
    throw new ForbiddenError("需要管理员权限");
  }
}

/** 供路由使用：从已认证用户 ID 构造 actor。 */
export function tagAdminActor(userId: string): UserActor {
  return userActorFromAuthenticatedId(userId);
}

/** 类型守卫：便于测试断言 handler 返回值。 */
export { isTaskRescheduleResult };
