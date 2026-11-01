/**
 * 客观题练习全链路 E2E（域入口）。
 *
 * 0.11 删除了无域 `/api/v1/problems/**` 写路径，作者侧改为：
 *   建卷 POST /domains/main/problems
 *   → 草稿 PUT /domains/main/problems/:reference/draft（If-Match revision）
 *   → 发布 POST /domains/main/problems/:reference/publish
 * 作答侧：POST /domains/main/problems/:reference/objective-submissions。
 *
 * 覆盖：建卷 → 草稿写两题 → 发布 → 一题答对一题答错 → 分数与逐题判定；
 * 并验证非编辑者不能写草稿。
 */

import {
  api,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  getOrCreateUser,
} from "../helper.ts";

const PREFIX = "/api/v1/domains/main/problems";

interface CreatedPaper {
  problem_id: string;
  number: number;
  draft_revision: number;
}

interface SubmitResult {
  score: number;
  details?: { questions?: Array<{ key: string; correct: boolean }> };
}

e2eTest("objective e2e: 域建卷→草稿→发布→作答即时判定", async () => {
  const adminToken = await getAdminToken();
  const suffix = Date.now().toString(36);
  const owner = await getOrCreateUser(
    "objective_owner",
    `objective_owner_${suffix}`,
    `objective_owner_${suffix}@test.com`,
  );
  const answerer = await getOrCreateUser(
    "objective_answerer",
    `objective_answerer_${suffix}`,
    `objective_answerer_${suffix}@test.com`,
  );

  // 域写权限：作者与答题者都进入 main 域并拿到编辑器角色（域入口要求 submission:create）
  for (
    const token of [owner.token, answerer.token]
  ) {
    const me = await apiGet("/api/v1/auth/me", token);
    const id = (me.body as { data: { id: string } }).data.id;
    const granted = await apiPut(`/api/v1/domains/main/members/${id}/roles`, {
      roles: ["editor"],
    }, adminToken);
    if (granted.status !== 200) {
      throw new Error(`授予域角色失败: ${JSON.stringify(granted.body)}`);
    }
  }

  // 1. 建客观题套卷
  const title = `E2E 客观题卷 ${suffix}`;
  const created = await apiPost(PREFIX, {
    title,
    description: "客观题域入口用例",
    is_objective: true,
  }, owner.token);
  if (created.status !== 201) {
    throw new Error(
      `建卷失败: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  const paper = created.body as CreatedPaper;
  const paperPath = `${PREFIX}/${paper.number}`;

  // 2. 写草稿：单选 + 判断
  const questions = [
    {
      key: "q-single",
      sort_order: 0,
      type: "single",
      prompt: "HTTP 状态码 201 表示？",
      options: [
        { key: "A", text: "已接受" },
        { key: "B", text: "已创建" },
      ],
      answer: ["B"],
      explanation: "",
    },
    {
      key: "q-judge",
      sort_order: 1,
      type: "judge",
      prompt: "客观题判定在 core 内即时完成。",
      options: [],
      answer: [true],
      explanation: "",
    },
  ];
  const draft = await apiPut(
    `${paperPath}/draft`,
    {
      content: {
        kind: "objective",
        title,
        description: "客观题域入口用例",
        samples: [],
        questions,
      },
    },
    owner.token,
    { "If-Match": String(paper.draft_revision) },
  );
  if (draft.status !== 200) {
    throw new Error(
      `写草稿失败: ${draft.status} ${JSON.stringify(draft.body)}`,
    );
  }
  const draftBody = draft.body as {
    revision?: number;
    draft_revision?: number;
  };
  const revision = draftBody.revision ?? draftBody.draft_revision;
  if (typeof revision !== "number") {
    throw new Error(`草稿未回传 revision: ${JSON.stringify(draft.body)}`);
  }

  // 3. 发布
  const published = await api("POST", `${paperPath}/publish`, {
    body: { change_note: "E2E 首次发布" },
    token: owner.token,
    headers: { "If-Match": String(revision) },
  });
  if (published.status !== 200) {
    throw new Error(
      `发布失败: ${published.status} ${JSON.stringify(published.body)}`,
    );
  }

  // 4. 作答：一题对一题错 → 50 分
  const submission = await apiPost(`${paperPath}/objective-submissions`, {
    answers: { "q-single": ["B"], "q-judge": [false] },
  }, answerer.token);
  if (submission.status !== 201) {
    throw new Error(
      `交卷失败: ${submission.status} ${JSON.stringify(submission.body)}`,
    );
  }
  const result = (submission.body as { data: SubmitResult }).data;
  if (result.score !== 50) {
    throw new Error(`一题对一题错应得 50 分，实际 ${result.score}`);
  }

  // 5. 非编辑者写草稿被拒（域权限）
  const forbidden = await apiPut(
    `${paperPath}/draft`,
    {
      content: {
        kind: "objective",
        title,
        description: "篡改",
        samples: [],
        questions,
      },
    },
    answerer.token,
    { "If-Match": String(revision + 1) },
  );
  if (forbidden.status !== 403) {
    throw new Error(`非编辑者写草稿应 403，实际 ${forbidden.status}`);
  }

  // 6. 发布后可读详情（版本快照）
  const detail = await apiGet(`${paperPath}`, answerer.token);
  if (detail.status !== 200) {
    throw new Error(`读套卷详情失败: ${detail.status}`);
  }
});
