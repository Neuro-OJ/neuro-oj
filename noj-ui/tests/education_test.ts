/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@^1';
import {
  assignmentPhase,
  classroomCan,
  educationCacheKey,
  teachingCellLabel,
  teachingLocalTime,
  teachingScore,
  teachingTrainingId,
  teachingUtcTime,
} from '../utils/education.ts';
import type { Assignment, ClassroomDetail, TeachingCell } from '../utils/education.ts';

Deno.test('教学分数：整数及两位小数精确保存，拒绝超范围和隐式舍入', () => {
  assertEquals(teachingScore('60'), 6000);
  assertEquals(teachingScore('1.14'), 114);
  assertEquals(teachingScore('0.01'), 1);
  assertEquals(teachingScore('100.00'), 10000);
  for (const invalid of ['-1', '100.01', '1.005', 'NaN', '1e2', '']) assertThrows(() => teachingScore(invalid));
});
Deno.test('教学表单：本地时间往返 UTC，题单链接不改变使用域', () => {
  const input = '2026-10-13T13:45:00.000Z';
  assertEquals(teachingUtcTime(teachingLocalTime(input)), input);
  assertEquals(teachingUtcTime(''), null);
  assertThrows(() => teachingUtcTime('invalid'));
  assertEquals(teachingTrainingId('https://noj.example/d/main/trainings/abc'), 'abc');
  assertEquals(teachingTrainingId('/d/school/trainings/def/'), 'def');
  assertThrows(() => teachingTrainingId('/problems/1001'));
});
Deno.test('教学能力：助教固定授权不相互隐含，学生及历史任职不获得管理权限', () => {
  const base = {
    manages_domain: false,
    membership: { role: 'assistant', status: 'active' },
    capabilities: ['feedback:write'],
  } as ClassroomDetail;
  assertEquals(classroomCan(base, 'feedback:write'), true);
  assertEquals(classroomCan(base, 'submissions:read'), false);
  assertEquals(classroomCan(base, 'assignments:manage'), false);
  assertEquals(classroomCan({ ...base, membership: { role: 'student', status: 'active' } }, 'feedback:write'), false);
  assertEquals(classroomCan({ ...base, membership: null }, 'feedback:write'), false);
  assertEquals(classroomCan({ ...base, membership: { role: 'coach', status: 'active' } }, 'help:manage'), true);
});
Deno.test('教学缓存：域、查看者、统计范围、页码和原提交分别隔离', () => {
  const key = educationCacheKey('school-a', 'student-a', 'task', 'on_time', 1);
  for (
    const other of [
      educationCacheKey('school-b', 'student-a', 'task', 'on_time', 1),
      educationCacheKey('school-a', 'student-b', 'task', 'on_time', 1),
      educationCacheKey('school-a', 'student-a', 'task', 'current', 1),
      educationCacheKey('school-a', 'student-a', 'task', 'on_time', 2),
      educationCacheKey('school-a', 'student-a', 'submission-a', 'main.py'),
    ]
  ) assertNotEquals(key, other);
});
Deno.test('教学成绩：过期成绩不可展示，最低分不反推 AC，逾期单独标识', () => {
  const cell = { status: 'achieved', score: 6500, accepted: false, late: false, updating: false } as TeachingCell;
  assertEquals(teachingCellLabel(cell), '65 · 已达标');
  assertEquals(teachingCellLabel({ ...cell, late: true }), '65 · 已达标 · 逾期');
  assertEquals(teachingCellLabel({ ...cell, updating: true, score: 10000 }), '更新中');
  assertEquals(teachingCellLabel({ ...cell, score: null, status: 'unavailable' }), '资源不可用');
});
Deno.test('作业阶段：截止按时窗口与归档分开，边界时刻及提前结束明确显示', () => {
  const task = { state: 'published', deadline_at: '2026-10-13T10:00:00Z', ended_at: null } as Assignment;
  assertEquals(assignmentPhase(task, Date.parse('2026-10-13T09:59:59Z')), '进行中');
  assertEquals(assignmentPhase(task, Date.parse(task.deadline_at!)), '已截止，可继续练习');
  assertEquals(assignmentPhase({ ...task, ended_at: '2026-10-13T09:00:00Z' }), '已提前结束');
  assertEquals(assignmentPhase({ ...task, state: 'archived' }), '已归档');
});
