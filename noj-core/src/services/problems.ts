/**
 * 题目服务
 *
 * 提供题目的业务逻辑。当前使用内存存储。
 */

import type { Problem, ProblemSummary, CreateProblemInput } from "../types/problems.ts";

/** 内存存储的题目数据 */
const problemsStore: Map<string, Problem> = new Map();

/** 自增 ID 计数器 */
let nextId = 1;

/**
 * 获取题目列表
 */
export function listProblems(): ProblemSummary[] {
  const problems: ProblemSummary[] = [];
  for (const p of problemsStore.values()) {
    problems.push({
      id: p.id,
      title: p.title,
      difficulty: p.difficulty,
      time_limit_ms: p.time_limit_ms,
      memory_limit_mb: p.memory_limit_mb,
    });
  }
  return problems;
}

/**
 * 根据 ID 获取题目详情
 */
export function getProblem(id: string): Problem | undefined {
  return problemsStore.get(id);
}

/**
 * 根据 ID 获取题目摘要
 */
export function getProblemSummary(id: string): ProblemSummary | undefined {
  const p = problemsStore.get(id);
  if (!p) return undefined;
  return {
    id: p.id,
    title: p.title,
    difficulty: p.difficulty,
    time_limit_ms: p.time_limit_ms,
    memory_limit_mb: p.memory_limit_mb,
  };
}

/**
 * 创建题目
 */
export function createProblem(input: CreateProblemInput): Problem {
  const id = String(nextId++);
  const problem: Problem = {
    id,
    title: input.title,
    description: input.description,
    difficulty: input.difficulty,
    time_limit_ms: input.time_limit_ms,
    memory_limit_mb: input.memory_limit_mb,
    judge_image: input.judge_image,
    judge_command: input.judge_command,
    support_package_path: input.support_package_path,
  };
  problemsStore.set(id, problem);
  return problem;
}

/**
 * 初始化示例题目
 */
export function initSampleProblems(): void {
  nextId = 1001;

  // Hello World 示例题
  const helloWorld: Problem = {
    id: "1001",
    title: "Hello World",
    description: `## Hello World

编写一个程序，输出 "Hello, World!"。

### 输入

无

### 输出

Hello, World!

### 示例输出

Hello, World!`,
    difficulty: "easy",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    judge_image: "python:3.11",
    judge_command: "python evaluate.py",
  };
  problemsStore.set(helloWorld.id, helloWorld);

  // A+B Problem
  const abProblem: Problem = {
    id: "1002",
    title: "A+B Problem",
    description: `## A+B Problem

给定两个整数 a 和 b，输出 a+b 的结果。

### 输入

两个整数 a 和 b，用空格分隔。

### 输出

a+b 的结果。

### 示例输入

1 2

### 示例输出

3`,
    difficulty: "easy",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    judge_image: "python:3.11",
    judge_command: "python evaluate.py",
  };
  problemsStore.set(abProblem.id, abProblem);
}