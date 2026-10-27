/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  ARTIFACT_FILE_ACCEPT,
  formatMemoryLimit,
  formatTimeLimit,
  isPredictionView,
  PREDICTION_FILE_ACCEPT,
  predictionHint,
  problemJudgeTypeLabel,
  problemTypeLabel,
  submissionModeLabel,
  toContestProblemView,
  toDomainProblemView,
  toProblemView,
} from '../utils/problemView.ts';

Deno.test('problemView: 域题目保留来源题号、作答版本与已裁剪的标签', () => {
  const view = toDomainProblemView({
    reference: {
      problem_id: 'source',
      source_domain_id: 'main',
      source_domain_slug: 'main',
      number: 1001,
      qualified_ref: 'main:1001',
      display_ref: 'main:1001',
      is_shared: true,
    },
    binding_id: 'school-binding',
    policy_revision: 2,
    effective_version_mode: 'exact',
    version_id: 'published-v2',
    answer_version_id: 'published-v2',
    required_version_id: 'published-v2',
    version: 2,
    can_edit: false,
    difficulty: 'easy',
    judge_backend: 'oi-native',
    owner: { id: 'author', username: 'alice', avatar_url: null },
    tags: [{ id: 'topic', name: '基础', kind: 'problem' }],
    has_hidden_algorithm_tags: true,
    limits: { time_limit_ms: 1000, memory_limit_mb: 256 },
    content: { kind: 'oi', title: '共享加法', description: '题面', samples: [] },
  });
  assertEquals(view.display_id, 'main:1001');
  assertEquals(view.id, 'source');
  assertEquals(view.effective_version_policy, { mode: 'exact', version_id: 'published-v2' });
  assertEquals(view.judge_backend, 'oi-native');
  assertEquals(view.time_limit_ms, 1000);
  assertEquals(view.owner_username, 'alice');
  assertEquals(view.tags.map((tag) => tag.id), ['topic']);
  assertEquals(view.has_hidden_algorithm_tags, true);
});

Deno.test('problemView: 独立题目资源映射为统一视图', () => {
  const view = toProblemView({
    id: 'uuid-1',
    display_id: 'P1000',
    title: 'A+B Problem',
    description: '# 题面',
    difficulty: 'easy',
    type: 'U',
    owner_id: 'owner-1',
    owner_username: 'alice',
    owner_avatar_url: '/avatars/alice.png',
    is_objective: false,
    submission_mode: 'code',
    artifact_max_size_mb: null,
    tags: [{ id: 't1', name: '模拟', kind: 'problem' }],
    has_hidden_algorithm_tags: true,
    runtime_config: {
      evaluator: { time_limit_ms: 1000, memory_limit_mb: 256 },
    },
  });

  assertEquals(view.display_id, 'P1000');
  assertEquals(view.owner_username, 'alice');
  assertEquals(view.owner_avatar_url, '/avatars/alice.png');
  assertEquals(view.time_limit_ms, 1000);
  assertEquals(view.memory_limit_mb, 256);
  assertEquals(view.tags, [{ id: 't1', name: '模拟', kind: 'problem' }]);
  assertEquals(view.has_hidden_algorithm_tags, true);
});

Deno.test('problemView: 独立题目缺省字段降级为空而非崩溃', () => {
  const view = toProblemView({
    id: 'uuid-2',
    display_id: 'P2',
    title: '题',
    description: '',
    difficulty: 'hard',
    type: 'T',
    owner_id: 'owner-2',
    is_objective: true,
  });

  assertEquals(view.owner_username, null);
  assertEquals(view.submission_mode, 'code');
  assertEquals(view.artifact_max_size_mb, null);
  assertEquals(view.tags, []);
  assertEquals(view.has_hidden_algorithm_tags, false);
  assertEquals(view.time_limit_ms, null);
  assertEquals(view.memory_limit_mb, null);
  // 无保密关联（或后端未下发该字段）时为空数组，横幅不渲染
  assertEquals(view.contest_secrecy, []);
  // 未下发版本字段（旧响应）→ 全部降级为 null/false，界面按"未发布"呈现
  assertEquals(view.version_id, null);
  assertEquals(view.version, null);
  assertEquals(view.latest_version_id, null);
  assertEquals(view.latest_version, null);
  assertEquals(view.effective_version_policy, null);
  assertEquals(view.is_latest, false);
});

Deno.test('problemView: 作答版本字段透传（题库有效策略 / 竞赛固定版本）', () => {
  const practice = toProblemView({
    id: 'uuid-v1',
    display_id: 'P1001',
    title: '版本化题',
    description: '题面',
    difficulty: 'easy',
    type: 'P',
    owner_id: 'owner-1',
    is_objective: false,
    version_id: 'v-old',
    version: 3,
    latest_version_id: 'v-new',
    latest_version: 5,
    effective_version_policy: { mode: 'exact', version_id: 'v-old' },
    is_latest: false,
  });
  assertEquals(practice.version_id, 'v-old');
  assertEquals(practice.version, 3);
  assertEquals(practice.latest_version_id, 'v-new');
  assertEquals(practice.latest_version, 5);
  assertEquals(practice.effective_version_policy, {
    mode: 'exact',
    version_id: 'v-old',
  });
  assertEquals(practice.is_latest, false);

  const contest = toContestProblemView({
    ...baseContest(),
    version_id: 'v-pinned',
    version: 2,
  });
  assertEquals(contest.version_id, 'v-pinned');
  assertEquals(contest.version, 2);
  // 竞赛固定版本与题库最新版无关：接口不下发 latest_*，界面不得提示"有更新版本"
  assertEquals(contest.latest_version_id, null);
  assertEquals(contest.latest_version, null);
  assertEquals(contest.effective_version_policy, null);
  assertEquals(contest.is_latest, false);

  // 迁移期尚未固定版本的存量竞赛题：version_id 为 null
  assertEquals(toContestProblemView(baseContest()).version_id, null);
});

Deno.test('problemView: 公开赛保密提示字段透传（仅所有者/管理员会收到）', () => {
  const view = toProblemView({
    id: 'uuid-secret',
    display_id: 'P9',
    title: '保密题',
    description: '题面',
    difficulty: 'easy',
    type: 'P',
    owner_id: 'owner-9',
    is_objective: false,
    contest_secrecy: [
      { public_id: 'ct-1', title: '春季公开赛' },
      { public_id: 'ct-2', title: '夏季公开赛' },
    ],
  });

  assertEquals(view.contest_secrecy, [
    { public_id: 'ct-1', title: '春季公开赛' },
    { public_id: 'ct-2', title: '夏季公开赛' },
  ]);
});

Deno.test('problemView: 竞赛题目资源映射，id 取 problem_id 且无时限信息', () => {
  const view = toContestProblemView({
    problem_id: 'uuid-3',
    display_id: 'A',
    title: '竞赛题',
    description: '题面',
    difficulty: 'medium',
    submission_mode: 'artifact',
    artifact_max_size_mb: 64,
  });

  assertEquals(view.id, 'uuid-3');
  assertEquals(view.display_id, 'A');
  assertEquals(view.submission_mode, 'artifact');
  assertEquals(view.artifact_max_size_mb, 64);
  assertEquals(view.is_objective, false);
  assertEquals(view.owner_username, null);
  // 竞赛接口不返回 runtime_config：时限/内存必须以 null 表达，禁止用 0 顶替
  assertEquals(view.time_limit_ms, null);
  assertEquals(view.memory_limit_mb, null);
});

Deno.test('problemView: 客观题判定只认显式 true（后端字段可能缺失）', () => {
  assertEquals(
    toContestProblemView({ ...baseContest(), is_objective: true }).is_objective,
    true,
  );
  assertEquals(
    toContestProblemView({ ...baseContest(), is_objective: undefined })
      .is_objective,
    false,
  );
});

Deno.test('problemView: prediction 模式映射并在竞赛视图保留', () => {
  const standalone = toProblemView({
    id: 'uuid-p',
    display_id: 'P9',
    title: '预测题',
    description: '题面',
    difficulty: 'hard',
    type: 'U',
    owner_id: 'owner-p',
    is_objective: false,
    submission_mode: 'prediction',
    artifact_max_size_mb: 128,
    runtime_config: { evaluator: { time_limit_ms: 2000, memory_limit_mb: 1024 } },
  });
  assertEquals(standalone.submission_mode, 'prediction');
  assertEquals(standalone.artifact_max_size_mb, 128);
  assertEquals(isPredictionView(standalone), true);

  const contest = toContestProblemView({
    problem_id: 'uuid-pc',
    display_id: 'C',
    title: '竞赛预测题',
    description: '',
    difficulty: 'medium',
    submission_mode: 'prediction',
    artifact_max_size_mb: 64,
  });
  assertEquals(contest.submission_mode, 'prediction');
  assertEquals(isPredictionView(contest), true);
});

Deno.test('problemView: isPrediction 只认显式 prediction，缺省与 artifact 均为 false', () => {
  assertEquals(isPredictionView(toProblemView({ ...baseProblem(), submission_mode: undefined })), false);
  assertEquals(isPredictionView(toProblemView({ ...baseProblem(), submission_mode: 'artifact' })), false);
  assertEquals(isPredictionView(toProblemView({ ...baseProblem(), submission_mode: 'prediction' })), true);
});

Deno.test('problemView: 提交模式文案与预测 accept 白名单', () => {
  assertEquals(submissionModeLabel('code'), '代码提交');
  assertEquals(submissionModeLabel('artifact'), '产物提交');
  assertEquals(submissionModeLabel('prediction'), '预测提交');
  assertEquals(submissionModeLabel(undefined), '代码提交');
  // prediction 是单文件而非 zip：accept 不得包含 zip，且覆盖后端白名单扩展名
  assertEquals(PREDICTION_FILE_ACCEPT.includes('.zip'), false);
  for (const ext of ['.csv', '.tsv', '.jsonl', '.json', '.txt', '.npy', '.npz', '.parquet']) {
    assertEquals(PREDICTION_FILE_ACCEPT.includes(ext), true);
  }
  assertEquals(ARTIFACT_FILE_ACCEPT.includes('.zip'), true);
  assertEquals(predictionHint().includes('本地 GPU'), true);
});

Deno.test('problemView: 类型文案与空值兜底', () => {
  assertEquals(problemTypeLabel('U'), '题库');
  assertEquals(problemTypeLabel('T'), '题库');
  assertEquals(problemTypeLabel(undefined), '题库');
});

Deno.test('problemView: 时限/内存文案占位一致', () => {
  assertEquals(formatTimeLimit(1000), '1000ms');
  assertEquals(formatTimeLimit(null), '—');
  assertEquals(formatMemoryLimit(256), '256MB');
  assertEquals(formatMemoryLimit(null), '—');
});

function baseContest() {
  return {
    problem_id: 'uuid-4',
    display_id: 'B',
    title: '题',
    description: '',
    difficulty: 'easy',
  };
}

function baseProblem() {
  return {
    id: 'uuid-5',
    display_id: 'C',
    title: '题',
    description: '',
    difficulty: 'easy',
    type: 'U',
    owner_id: 'owner-5',
    is_objective: false,
  };
}
Deno.test('problemView: OI 后端公开字段在独立页与竞赛页保留，缺失时不猜测后端', () => {
  for (const backend of ['oi-native', 'oi-wasm'] as const) {
    const view = toContestProblemView({
      ...baseContest(),
      judge_type: 'oi',
      judge_backend: backend,
    });
    assertEquals(view.judge_backend, backend);
    assertEquals(problemJudgeTypeLabel(view), 'OI 题');
    const standalone = toProblemView({
      ...baseContest(),
      id: 'uuid-oi',
      type: 'P',
      owner_id: 'owner',
      is_objective: false,
      judge_type: 'oi',
      judge_backend: backend,
    });
    assertEquals(standalone.judge_backend, backend);
    assertEquals(problemJudgeTypeLabel(standalone), 'OI 题');
  }
  assertEquals(
    problemJudgeTypeLabel({ is_objective: false, judge_type: 'dual' }),
    'AI 题',
  );
  assertEquals(
    problemJudgeTypeLabel({ is_objective: true, judge_type: 'dual' }),
    '客观题',
  );
  assertEquals(problemJudgeTypeLabel({ is_objective: false }), null);
  assertEquals(toContestProblemView(baseContest()).judge_backend, null);
});
