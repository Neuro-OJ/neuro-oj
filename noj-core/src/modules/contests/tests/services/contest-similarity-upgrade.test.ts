import { assert, assertEquals } from "jsr:@std/assert@^1";
import { detectSimilarPairs, normalizeCodeBlocks } from "../../index.ts";
import { collectSimilarPairs } from "../../services/contest-similarity/detect.ts";

const BUBBLE_SOLUTION = `def solve(n, nums):
    for i in range(n):
        for j in range(0, n - i - 1):
            if nums[j] > nums[j + 1]:
                nums[j], nums[j + 1] = nums[j + 1], nums[j]
    return nums
`;

const COUNTING_SOLUTION = `def solve(count, values):
    table = {}
    for item in values:
        table[item] = table.get(item, 0) + 1
    output = []
    for key in sorted(table):
        output.extend([key] * table[key])
    return output
`;

Deno.test("similarity-upgrade: 前置插入新变量时块级局部归一化抗漂移命中", () => {
  const prepended = `noise_a = 101
noise_b = 202
noise_c = noise_a + noise_b
${BUBBLE_SOLUTION}`;
  const pairs = detectSimilarPairs([
    {
      submission_id: "s-orig",
      user_id: "u1",
      problem_id: "p1",
      language: "python",
      code: BUBBLE_SOLUTION,
    },
    {
      submission_id: "s-prepend",
      user_id: "u2",
      problem_id: "p1",
      language: "python",
      code: prepended,
    },
  ]);
  assertEquals(pairs.length, 1);
  assert(pairs[0]!.similarity >= 0.8, `got ${pairs[0]!.similarity}`);
  assertEquals(pairs[0]!.match_strategy, "block_local");
});

Deno.test("similarity-upgrade: 调换顶层函数定义顺序仍以 ~1.0 命中", () => {
  const fnA = `def helper(arr, x, y):
    if arr[x] > arr[y]:
        arr[x], arr[y] = arr[y], arr[x]
    return arr
`;
  const fnB = `def solve(n, nums):
    for i in range(n):
        for j in range(0, n - i - 1):
            helper(nums, j, j + 1)
    return nums
`;
  const blocks = normalizeCodeBlocks(`${fnA}\n${fnB}`, "python");
  assertEquals(blocks.length, 2);

  const pairs = detectSimilarPairs([
    {
      submission_id: "s-ab",
      user_id: "u1",
      problem_id: "p1",
      language: "python",
      code: `${fnA}\n${fnB}`,
    },
    {
      submission_id: "s-ba",
      user_id: "u2",
      problem_id: "p1",
      language: "python",
      code: `${fnB}\n${fnA}`,
    },
  ]);
  assertEquals(pairs.length, 1);
  assertEquals(pairs[0]!.similarity, 1);
  assertEquals(pairs[0]!.match_strategy, "block_local");
});

Deno.test("similarity-upgrade: 不同算法结构在融合 block_local 后仍不误报", () => {
  const pairs = detectSimilarPairs([
    {
      submission_id: "s-bubble",
      user_id: "u1",
      problem_id: "p1",
      language: "python",
      code: BUBBLE_SOLUTION,
    },
    {
      submission_id: "s-count",
      user_id: "u2",
      problem_id: "p1",
      language: "python",
      code: COUNTING_SOLUTION,
    },
  ]);
  assertEquals(pairs.length, 0);
});

Deno.test("similarity-upgrade: 倒排索引支持 600 份规模并可选 DF 过滤高频模板指纹", () => {
  const ops = ["+", "-", "*", "^", "|"];
  const candidates = Array.from({ length: 600 }, (_, idx) => {
    const opA = ops[idx % ops.length]!;
    const opB = ops[Math.floor(idx / 5) % ops.length]!;
    const branch = idx % 3 === 0
      ? `if acc > ${idx + 10}: acc = acc ${opB} ${idx + 3}`
      : idx % 3 === 1
      ? `while step < ${(idx % 7) + 2}: acc += step + ${idx + 5}; step += 1`
      : `acc = sum((x ${opA} ${idx + 11}) for x in parsed) ${opB} ${idx + 19}`;
    return {
      submission_id: `sub-${idx}`,
      user_id: `user-${idx}`,
      problem_id: "p-scale",
      language: "python",
      // 共享一段模板头部（会被 maxDocFreqRatio 过滤），主体结构与常量各不相同
      code: `def boilerplate_entry(data):
    parsed = [int(x) for x in data.split()]
    acc = ${idx + 1000}
    step = ${idx + 1}
    ${branch}
    for k in range(${idx + 2}, ${idx + 20}):
        acc = (acc ${opA} k ${opB} ${idx + 7}) % ${1000 + idx}
    return parsed, acc
`,
    };
  });

  // 注入一对真实抄袭提交
  candidates.push(
    {
      submission_id: "clone-a",
      user_id: "cheater-1",
      problem_id: "p-scale",
      language: "python",
      code: BUBBLE_SOLUTION,
    },
    {
      submission_id: "clone-b",
      user_id: "cheater-2",
      problem_id: "p-scale",
      language: "python",
      code: BUBBLE_SOLUTION.replaceAll("nums", "arr").replaceAll(
        /\bn\b/g,
        "size_val",
      ),
    },
  );

  const started = performance.now();
  const res = collectSimilarPairs(candidates, {
    threshold: 0.8,
    limit: 200,
    maxDocFreqRatio: 0.5,
  });
  const elapsedMs = performance.now() - started;

  assert(elapsedMs < 2000, `600 份查重耗时过长: ${elapsedMs}ms`);
  assertEquals(res.participating, 602);
  assert(
    res.pairs.some((p) =>
      p.submission_a_id === "clone-a" && p.submission_b_id === "clone-b"
    ),
  );
});
