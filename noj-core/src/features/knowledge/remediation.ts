/**
 * 评测错因与知识图谱补强联动（衔接 PR #792 `evaluation-feedback`）。
 *
 * 根据题目的主/次挂载知识点、当前用户的未掌握前置链，以及评测反馈暴露的
 * `badcases.error_type` 和低分分项指标（`metrics`），为提交或自测页面提供
 * 精准的可学习节点与原始讲解入口，并严格沿用题目比赛保密保护口径。
 */
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import {
  type KnowledgeGraphNode,
  type KnowledgeGraphView,
  readKnowledgeGraph,
} from "./graph.ts";
import { type KnowledgeViewer, readProblemKnowledge } from "./mappings.ts";
import {
  diagnoseNode,
  loadUserMastery,
  loadUserPlacementIds,
  type MasteryState,
} from "./mastery.ts";

/** 错因分类规则：关键字（小写） -> 优先映射的知识节点 ID（按权重排前）。 */
const SIGNAL_NODE_RULES: ReadonlyArray<{
  keywords: readonly string[];
  nodeIds: readonly string[];
}> = [
  {
    keywords: [
      "format",
      "json",
      "schema",
      "parse",
      "structure",
      "syntax",
      "regex",
      "格式",
      "解析",
      "结构化",
    ],
    nodeIds: [
      "llm-infer.structured-output",
      "llm-app.tool-use",
      "prog.python-data-structures",
    ],
  },
  {
    keywords: [
      "tool",
      "function",
      "call",
      "agent",
      "argument",
      "工具",
      "调用",
      "智能体",
    ],
    nodeIds: [
      "llm-app.tool-use",
      "llm-app.agent-applications",
      "llm-infer.structured-output",
    ],
  },
  {
    keywords: [
      "reason",
      "logic",
      "cot",
      "math",
      "step",
      "inference",
      "推理",
      "逻辑",
      "步骤",
    ],
    nodeIds: [
      "llm-app.chain-of-thought",
      "llm-app.reasoning-concepts",
      "llm-eval.evaluation-process",
    ],
  },
  {
    keywords: [
      "hallucination",
      "ground",
      "faith",
      "citation",
      "rag",
      "retriev",
      "context",
      "幻觉",
      "检索",
      "召回",
    ],
    nodeIds: [
      "llm-app.rag",
      "llm-app.vector-retrieval",
      "llm-eval.ranking-metrics",
    ],
  },
  {
    keywords: [
      "token",
      "trunc",
      "length",
      "context_len",
      "decode",
      "sampl",
      "timeout",
      "截断",
      "超长",
      "采样",
    ],
    nodeIds: [
      "llm.tokenizers",
      "llm-infer.sampling-strategies",
      "llm-infer.kv-cache",
    ],
  },
  {
    keywords: [
      "loss",
      "grad",
      "converge",
      "nan",
      "optim",
      "lr",
      "learning_rate",
      "损失",
      "梯度",
      "收敛",
    ],
    nodeIds: [
      "dl.loss-functions",
      "dl.optimizers",
      "dl.backpropagation",
    ],
  },
  {
    keywords: [
      "overfit",
      "generaliz",
      "leak",
      "split",
      "regular",
      "过拟合",
      "泛化",
      "泄露",
    ],
    nodeIds: [
      "ml.regularization",
      "data.split",
      "data.normalization",
    ],
  },
  {
    keywords: [
      "shape",
      "dim",
      "matrix",
      "tensor",
      "broadcast",
      "conv",
      "维度",
      "张量",
      "矩阵",
      "卷积",
    ],
    nodeIds: [
      "math.linear-algebra",
      "prog.numpy",
      "cv.convolution",
    ],
  },
  {
    keywords: [
      "accuracy",
      "f1",
      "precision",
      "recall",
      "auc",
      "metric",
      "eval",
      "准确率",
      "评测",
    ],
    nodeIds: [
      "llm-eval.evaluation-process",
      "llm-eval.benchmarks",
      "data.normalization",
    ],
  },
  {
    keywords: [
      "lora",
      "peft",
      "finetune",
      "fine_tune",
      "sft",
      "微调",
      "对齐",
    ],
    nodeIds: [
      "llm-train.lora",
      "llm-train.pretraining-objectives",
    ],
  },
];

/** 补强建议节点归因来源。 */
export type RemediationReason =
  | "problem_primary"
  | "problem_secondary"
  | "missing_prerequisite"
  | "feedback_signal";

/** 单条补强推荐节点。 */
export interface RemediationNodeItem {
  node_id: string;
  name: string;
  area: string;
  summary: string;
  has_doc: boolean;
  reason: RemediationReason;
  matched_signals: string[];
  state: MasteryState;
  placed: boolean;
}

/** 题目补强联动视图（`GET /knowledge/problems/:problemId/remediation`）。 */
export interface ProblemRemediationView {
  problem_id: string;
  items: RemediationNodeItem[];
}

/** 解析逗号分隔的信号参数列表，去重截断到最多 20 条。 */
export function parseFeedbackSignalParam(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim().slice(0, 80);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 纯函数：把 `badcases.error_type` 与薄弱能力维度关键字映射到图谱节点。
 *
 * 只返回 `graph` 中仍激活的节点，按命中信号数降序排列。
 */
export function matchSignalsToNodes(
  signals: readonly string[],
  graph: Pick<KnowledgeGraphView, "nodes">,
  limit = 4,
): Array<{ node: KnowledgeGraphNode; matchedSignals: string[] }> {
  if (signals.length === 0) return [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const scoreMap = new Map<
    string,
    { score: number; signals: Set<string> }
  >();

  for (const signal of signals) {
    const lower = signal.toLowerCase();
    for (const rule of SIGNAL_NODE_RULES) {
      if (!rule.keywords.some((kw) => lower.includes(kw))) continue;
      rule.nodeIds.forEach((nodeId, idx) => {
        if (!byId.has(nodeId)) return;
        const weight = Math.max(1, rule.nodeIds.length - idx);
        const entry = scoreMap.get(nodeId) ??
          { score: 0, signals: new Set<string>() };
        entry.score += weight;
        entry.signals.add(signal);
        scoreMap.set(nodeId, entry);
      });
    }
  }

  return [...scoreMap.entries()]
    .map(([nodeId, entry]) => ({
      node: byId.get(nodeId)!,
      score: entry.score,
      matchedSignals: [...entry.signals],
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.matchedSignals.length - a.matchedSignals.length ||
      Number(Boolean(b.node.doc)) - Number(Boolean(a.node.doc)) ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
    )
    .slice(0, limit)
    .map(({ node, matchedSignals }) => ({ node, matchedSignals }));
}

/**
 * 读取题目错因补强列表（严格复用 `readProblemKnowledge` 的保密门禁）。
 *
 * 题目不存在或处于保护期且查看者无编辑权时返回 `null`。
 */
export async function readProblemRemediation(
  problemId: string,
  viewer: KnowledgeViewer,
  options: {
    errorTypes?: readonly string[];
    weakMetrics?: readonly string[];
  } = {},
  db: DbRoot = getDb(),
): Promise<ProblemRemediationView | null> {
  const mapping = await readProblemKnowledge(problemId, viewer);
  if (!mapping) return null;

  const graph = await readKnowledgeGraph();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const [mastery, placedIds] = viewer.userId
    ? await Promise.all([
      loadUserMastery(viewer.userId, db),
      loadUserPlacementIds(viewer.userId, db),
    ])
    : [new Map(), new Set<string>()];

  const items: RemediationNodeItem[] = [];
  const seen = new Set<string>();

  const pushNode = (
    node: KnowledgeGraphNode | undefined,
    reason: RemediationReason,
    matchedSignals: string[] = [],
  ) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    items.push({
      node_id: node.id,
      name: node.name,
      area: node.area,
      summary: node.summary,
      has_doc: Boolean(node.doc),
      reason,
      matched_signals: matchedSignals,
      state: mastery.get(node.id)?.state ?? "none",
      placed: placedIds.has(node.id),
    });
  };

  // 1. 登录用户在主知识点上有未掌握前置时，把缺失前置排在最前面
  if (viewer.userId && mapping.primary) {
    const diag = await diagnoseNode(viewer.userId, mapping.primary.node_id, db);
    if (diag) {
      for (const prereq of diag.missing_prerequisites.slice(0, 2)) {
        pushNode(nodeById.get(prereq.node_id), "missing_prerequisite");
      }
    }
  }

  // 2. 题目的主知识点与次要知识点
  if (mapping.primary) {
    pushNode(nodeById.get(mapping.primary.node_id), "problem_primary");
  }
  for (const sec of mapping.secondary) {
    pushNode(nodeById.get(sec.node_id), "problem_secondary");
  }

  // 3. 结合评测反馈 error_type / 薄弱分项 metrics 匹配补强节点
  const signals = [
    ...(options.errorTypes ?? []),
    ...(options.weakMetrics ?? []),
  ];
  for (const matched of matchSignalsToNodes(signals, graph, 4)) {
    pushNode(matched.node, "feedback_signal", matched.matchedSignals);
  }

  return {
    problem_id: problemId,
    items: items.slice(0, 8),
  };
}
