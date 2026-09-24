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
  problemTypeLabel,
  submissionModeLabel,
  toContestProblemView,
  toProblemView,
} from '../utils/problemView.ts';

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
    is_objective: false,
    submission_mode: 'code',
    artifact_max_size_mb: null,
    tags: [{ id: 't1', name: '模拟', kind: 'problem' }],
    has_hidden_algorithm_tags: true,
    runtime_config: { evaluator: { time_limit_ms: 1000, memory_limit_mb: 256 } },
  });

  assertEquals(view.display_id, 'P1000');
  assertEquals(view.owner_username, 'alice');
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
  assertEquals(toContestProblemView({ ...baseContest(), is_objective: true }).is_objective, true);
  assertEquals(toContestProblemView({ ...baseContest(), is_objective: undefined }).is_objective, false);
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
  assertEquals(problemTypeLabel('U'), '用户题库');
  assertEquals(problemTypeLabel('T'), '主题库');
  assertEquals(problemTypeLabel(undefined), '主题库');
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
