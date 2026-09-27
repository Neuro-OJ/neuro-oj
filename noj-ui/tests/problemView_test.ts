/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  formatMemoryLimit,
  formatTimeLimit,
  problemTypeLabel,
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
  // 无保密关联（或后端未下发该字段）时为空数组，横幅不渲染
  assertEquals(view.contest_secrecy, []);
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
  assertEquals(toContestProblemView({ ...baseContest(), is_objective: true }).is_objective, true);
  assertEquals(toContestProblemView({ ...baseContest(), is_objective: undefined }).is_objective, false);
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
