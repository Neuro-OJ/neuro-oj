/**
 * 客观题（objective）全链路 E2E（issue #222）。
 *
 * 覆盖：
 * 1. 建套卷 → 建三题型小题 → 答对/答错提交 → 即时判定落库（objective_submissions）
 * 2. 练习重复提交取最高分；非 owner 不可见答案
 * 3. 竞赛集成：套卷挂入 contest_problems、竞赛内一次性提交、排名计入
 */
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
  isE2E,
  waitForServer,
} from "./helper.ts";

const testSuffix = Date.now().toString(36);

interface PaperData {
  id: string;
  type: string;
  is_objective: boolean;
  number: number;
  owner_id: string;
}
interface QuestionData {
  id: string;
  type: string;
  answer?: string[] | boolean[];
  explanation?: string;
  options: { key: string; text: string }[];
}

let adminToken = "";
let ownerToken = "";
let solverToken = "";
let paperId = "";
let singleId = "";
let multipleId = "";
let judgeId = "";

e2eTest("[e2e/objective] Setup: 管理端 + 出题人 + 答题人", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const owner = await getOrCreateUser(
    "objective_owner",
    `objective_owner_${testSuffix}`,
    `objective_owner_${testSuffix}@test.com`,
  );
  ownerToken = owner.token;
  const solver = await getOrCreateUser(
    "objective_solver",
    `objective_solver_${testSuffix}`,
    `objective_solver_${testSuffix}@test.com`,
  );
  solverToken = solver.token;
});

e2eTest("[e2e/objective] 1. 建套卷 → 建三题型小题 → 即时判定落库", async () => {
  if (!isE2E) return;
  // 1.1 创建客观题套卷（U 型 + is_objective，无需 runtime_config）
  const paperRes = await apiPost("/api/v1/problems", {
    type: "U",
    is_objective: true,
    title: `E2E 客观题套卷 ${testSuffix}`,
    description: "LMCC 成人组模拟卷",
  }, ownerToken);
  if (paperRes.status !== 201) {
    throw new Error(
      `创建套卷失败: ${paperRes.status} ${JSON.stringify(paperRes.body)}`,
    );
  }
  const paper = (paperRes.body as { data: PaperData }).data;
  if (!paper.is_objective) throw new Error("套卷 is_objective 应为 true");
  paperId = paper.id;

  // 1.2 单选小题
  const single = await apiPost(
    `/api/v1/problems/${paperId}/questions`,
    {
      type: "single",
      prompt: "LMCC 全称对应的英文是？",
      options: [
        { key: "A", text: "Large Model Certification of China" },
        { key: "B", text: "大语言模型能力认证" },
      ],
      answer: ["B"],
      explanation: "LMCC = 大语言模型能力认证",
    },
    ownerToken,
  );
  if (single.status !== 201) {
    throw new Error(
      `创建单选失败: ${single.status} ${JSON.stringify(single.body)}`,
    );
  }
  singleId = (single.body as { data: QuestionData }).data.id;

  // 1.3 多选小题
  const multiple = await apiPost(
    `/api/v1/problems/${paperId}/questions`,
    {
      type: "multiple",
      prompt: "以下哪些属于大模型基本素养？",
      options: [
        { key: "A", text: "提示词工程" },
        { key: "B", text: "上下文管理" },
        { key: "C", text: "烘焙技术" },
      ],
      answer: ["A", "B"],
    },
    ownerToken,
  );
  if (multiple.status !== 201) {
    throw new Error(
      `创建多选失败: ${multiple.status} ${JSON.stringify(multiple.body)}`,
    );
  }
  multipleId = (multiple.body as { data: QuestionData }).data.id;

  // 1.4 判断题
  const judge = await apiPost(
    `/api/v1/problems/${paperId}/questions`,
    { type: "judge", prompt: "大语言模型具备逻辑推理能力", answer: [true] },
    ownerToken,
  );
  if (judge.status !== 201) {
    throw new Error(
      `创建判断失败: ${judge.status} ${JSON.stringify(judge.body)}`,
    );
  }
  judgeId = (judge.body as { data: QuestionData }).data.id;

  // 1.5 答对提交 → 即时判定满分
  const okRes = await apiPost(
    `/api/v1/problems/${paperId}/submit`,
    {
      answers: {
        [singleId]: ["B"],
        [multipleId]: ["A", "B"],
        [judgeId]: [true],
      },
    },
    solverToken,
  );
  if (okRes.status !== 201) {
    throw new Error(`提交失败: ${okRes.status} ${JSON.stringify(okRes.body)}`);
  }
  const ok = (okRes.body as { data: Record<string, unknown> }).data;
  if (ok.score !== 100 || ok.score_db !== 10000) {
    throw new Error(`全对应得满分，实际 ${JSON.stringify(ok)}`);
  }
  const details = ok.details as Record<string, { correct: boolean }>;
  if (
    !details[singleId]?.correct || !details[multipleId]?.correct ||
    !details[judgeId]?.correct
  ) {
    throw new Error("三题型均应判对");
  }

  // 1.6 落库验证：提交历史存在且为 finished
  const hist = await apiGet(
    `/api/v1/problems/submissions?paper_id=${paperId}`,
    solverToken,
  );
  if (hist.status !== 200) throw new Error("历史查询失败");
  const histBody =
    (hist.body as { data: { total: number; best_score: number } }).data;
  if (histBody.total !== 1 || histBody.best_score !== 10000) {
    throw new Error(`落库异常: ${JSON.stringify(histBody)}`);
  }
});

e2eTest(
  "[e2e/objective] 2. 答错提交 + 重复提交最高分 + 答案不可见",
  async () => {
    if (!isE2E) return;
    // 2.1 答错 → 0 分（练习可重复提交）
    const badRes = await apiPost(
      `/api/v1/problems/${paperId}/submit`,
      {
        answers: {
          [singleId]: ["A"],
          [multipleId]: ["A"],
          [judgeId]: [false],
        },
      },
      solverToken,
    );
    if (badRes.status !== 201) throw new Error("答错提交应成功");
    const bad = (badRes.body as {
      data: {
        score: number;
        details: Record<string, { expected?: unknown; explanation?: unknown }>;
      };
    }).data;
    if (bad.score !== 0) throw new Error(`全错应 0 分，实际 ${bad.score}`);
    // 练习模式：判定详情含期望答案与解析（可复盘）
    if (bad.details[singleId]?.expected === undefined) {
      throw new Error("练习模式应返回期望答案");
    }
    if (bad.details[singleId]?.explanation === undefined) {
      throw new Error("练习模式应返回解析");
    }

    // 2.2 再提交全对 → 最高分保持 10000（练习取 MAX）
    const best = await apiGet(
      `/api/v1/problems/submissions?paper_id=${paperId}`,
      solverToken,
    );
    const bestBody =
      (best.body as { data: { total: number; best_score: number } }).data;
    if (bestBody.total !== 2 || bestBody.best_score !== 10000) {
      throw new Error(`最高分异常: ${JSON.stringify(bestBody)}`);
    }

    // 2.3 非 owner 公开视图裁剪答案
    const qView = await apiGet(
      `/api/v1/problems/${paperId}/questions`,
      solverToken,
    );
    if (qView.status !== 200) throw new Error("题目查询失败");
    const questions = (qView.body as { data: QuestionData[] }).data;
    for (const q of questions) {
      if (q.answer !== undefined || q.explanation !== undefined) {
        throw new Error("非 owner 不应看到答案与解析");
      }
    }

    // 2.4 owner 视图含答案
    const ownerView = await apiGet(
      `/api/v1/problems/${paperId}/questions`,
      ownerToken,
    );
    const ownerQuestions = (ownerView.body as { data: QuestionData[] }).data;
    if (ownerQuestions.length !== 3 || ownerQuestions[0].answer === undefined) {
      throw new Error("owner 视图应含答案");
    }

    // 2.5 非 owner 编辑小题被拒
    const forbidden = await apiDelete(
      `/api/v1/problems/${paperId}/questions/${singleId}`,
      solverToken,
    );
    if (forbidden.status !== 403) {
      throw new Error(`非 owner 删除应 403，实际 ${forbidden.status}`);
    }

    // 2.6 owner 更新小题解析
    const upd = await apiPut(
      `/api/v1/problems/${paperId}/questions/${singleId}`,
      { explanation: "更新后的解析" },
      ownerToken,
    );
    if (upd.status !== 200) throw new Error("更新小题失败");
  },
);

e2eTest("[e2e/objective] 3. 竞赛集成：一次性提交 + 排名计入", async () => {
  if (!isE2E) return;
  // 3.1 管理员创建 Kaggle 竞赛并挂入套卷
  const now = Date.now();
  const contestRes = await apiPost("/api/v1/admin/contests", {
    title: `E2E 客观题竞赛 ${testSuffix}`,
    start_time: new Date(now - 60 * 60 * 1000).toISOString(),
    end_time: new Date(now + 60 * 60 * 1000).toISOString(),
    type: "kaggle",
    config: {},
    is_public: true,
    affect_global_ranking: false,
    problems: [{ problem_id: paperId, sort_order: 0, label: "A", score: 100 }],
  }, adminToken);
  if (contestRes.status !== 201) {
    throw new Error(
      `创建竞赛失败: ${contestRes.status} ${JSON.stringify(contestRes.body)}`,
    );
  }
  const contestId = (contestRes.body as { data: { id: string } }).data.id;

  // 3.2 注册参赛
  const reg = await apiPost(
    `/api/v1/contests/${contestId}/register`,
    {},
    solverToken,
  );
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`注册失败: ${reg.status}`);
  }

  // 3.3 竞赛内提交（contest_id 携带）→ 判定满分
  const submit = await apiPost(
    `/api/v1/problems/${paperId}/submit`,
    {
      answers: {
        [singleId]: ["B"],
        [multipleId]: ["A", "B"],
        [judgeId]: [true],
      },
      contest_id: contestId,
    },
    solverToken,
  );
  if (submit.status !== 201) {
    throw new Error(
      `竞赛提交失败: ${submit.status} ${JSON.stringify(submit.body)}`,
    );
  }
  const submitted = (submit.body as {
    data: {
      submission_id: string;
      contest_mode: boolean;
      details: Record<string, { expected?: unknown; explanation?: unknown }>;
    };
  }).data;
  if (!submitted.contest_mode) throw new Error("竞赛提交应标记 contest_mode");
  // 竞赛模式：响应不得包含期望答案或解析（防泄题）
  for (const d of Object.values(submitted.details)) {
    if (d.expected !== undefined || d.explanation !== undefined) {
      throw new Error("竞赛模式提交响应不应包含期望答案或解析");
    }
  }

  // 3.4 竞赛内重复提交被拒（一次性）
  const dup = await apiPost(
    `/api/v1/problems/${paperId}/submit`,
    {
      answers: {
        [singleId]: ["B"],
        [multipleId]: ["A", "B"],
        [judgeId]: [true],
      },
      contest_id: contestId,
    },
    solverToken,
  );
  if (dup.status !== 400 && dup.status !== 409) {
    throw new Error(`竞赛重复提交应 4xx，实际 ${dup.status}`);
  }

  // 3.5 竞赛提交详情（本人）：同样不含期望答案与解析（防泄题）
  const subDetail = await apiGet(
    `/api/v1/problems/submissions/${submitted.submission_id}`,
    solverToken,
  );
  if (subDetail.status !== 200) throw new Error("竞赛提交详情查询失败");
  const detailData = (subDetail.body as {
    data: {
      details: Record<string, { expected?: unknown; explanation?: unknown }>;
    };
  }).data;
  for (const d of Object.values(detailData.details)) {
    if (d.expected !== undefined || d.explanation !== undefined) {
      throw new Error("竞赛模式提交详情不应包含期望答案或解析");
    }
  }

  // 3.6 排名计入：满分套卷应计入 total_score
  const ranking = await apiGet(
    `/api/v1/contests/${contestId}/ranking?type=kaggle`,
    adminToken,
  );
  if (ranking.status !== 200) {
    throw new Error(
      `排名查询失败: ${ranking.status} ${JSON.stringify(ranking.body)}`,
    );
  }
  const rows = (ranking.body as { data: Array<{ total_score: number }> }).data;
  if (rows.length === 0 || rows[0].total_score <= 0) {
    throw new Error(
      `客观题提交应计入排名 total_score，实际 ${JSON.stringify(rows)}`,
    );
  }

  // 3.7 未注册用户竞赛提交被拒（403）
  const outsider = await getOrCreateUser(
    "objective_outsider",
    `objective_outsider_${testSuffix}`,
    `objective_outsider_${testSuffix}@test.com`,
  );
  const outsiderSubmit = await apiPost(
    `/api/v1/problems/${paperId}/submit`,
    {
      answers: {
        [singleId]: ["B"],
        [multipleId]: ["A", "B"],
        [judgeId]: [true],
      },
      contest_id: contestId,
    },
    outsider.token,
  );
  if (outsiderSubmit.status !== 403) {
    throw new Error(`未注册用户竞赛提交应 403，实际 ${outsiderSubmit.status}`);
  }
});
