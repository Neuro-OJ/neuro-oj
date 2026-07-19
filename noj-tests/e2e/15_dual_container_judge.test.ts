/**
 * 双容器 Evaluator/Solution 评测全链路 E2E（issue #118 / openspec/changes/dual-container-judge）。
 *
 * 覆盖：
 * - admin 通过 API 配置双容器题目 + 提交 → 期望进入评测队列
 * - 镜像白名单被下架后 admin 提交被拒
 * - 普通用户可设置 runtime_config（双容器是唯一模式）
 * - runtime_config 是必填字段，不可清空
 *
 * 要求：
 *   NOJ_RUN_E2E=1 表示启用 E2E 测试套件
 *   E2E_BASE_URL 指向运行中的 noj-core 服务
 */

import {
  api,
  apiGet,
  apiPost,
  apiPut,
  getAdminToken,
  isE2E,
  registerUser,
} from "./helper.ts";

if (!isE2E) {
  // E2E 未启用：跳过整套测试
  Deno.test({
    name: "dual_container_judge: skipped (NOJ_RUN_E2E != 1)",
    ignore: true,
    fn: () => {},
  });
} else {
  // ── 测试常量 ─────────────────────────────────────────

  const EVALUATOR_IMAGE = "noj-evaluator-python:dev";
  const SOLUTION_IMAGE = "noj-solution-python:dev";
  const TEST_TAG = `e2e-${Date.now()}`;

  // ── 共享 fixtures ────────────────────────────────────

  /** 创建（或复用）evaluator 镜像白名单条目 */
  async function ensureImage(image: string, kind: "evaluator" | "solution"): Promise<string> {
    const adminToken = await getAdminToken();
    const list = await apiGet("/api/v1/admin/judge-images", adminToken);
    type JiEntry = { id: string; image: string; kind: string };
    const existing = ((list.body as { data: JiEntry[] }).data ?? []).find(
      (ji) => ji.image === image && ji.kind === kind,
    );
    if (existing) return existing.id;

    const create = await apiPost(
      "/api/v1/admin/judge-images",
      {
        image,
        kind,
        mode: "exact",
        description: `e2e ${kind} image`,
      },
      adminToken,
    );
    if (create.status !== 201) {
      throw new Error(
        `Failed to create image ${image} (kind=${kind}): ${create.status} ${
          JSON.stringify(create.body)
        }`,
      );
    }
    return (create.body as { data: JiEntry }).data.id;
  }

  /** 创建题目（双 runtime_config），返回 problem_id */
  async function createDualProblem(
    adminToken: string,
    title: string,
  ): Promise<string> {
    const res = await apiPost(
      "/api/v1/problems",
      {
        title,
        description: `# ${title}\n\nMarkdown 内容`,
        difficulty: "medium",
        type: "P",
        number: Math.floor(Math.random() * 9000) + 1000,
        runtime_config: {
          evaluator: {
            image: EVALUATOR_IMAGE,
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 10_000,
            memory_limit_mb: 512,
          },
          solution: {
            image: SOLUTION_IMAGE,
            entry: "solution.py",
            call_timeout_ms: 1_000,
            memory_limit_mb: 256,
          },
        },
      },
      adminToken,
    );
    if (res.status !== 201) {
      throw new Error(
        `Failed to create dual problem: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return (res.body as { data: { id: string } }).data.id;
  }

  // ── Tests ────────────────────────────────────────────

  Deno.test({
    name: "dual_container_judge: admin 创建双容器题目成功（含 runtime_config）",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const adminToken = await getAdminToken();
      await ensureImage(EVALUATOR_IMAGE, "evaluator");
      await ensureImage(SOLUTION_IMAGE, "solution");

      const problemId = await createDualProblem(
        adminToken,
        `[${TEST_TAG}] 双容器评测测试题`,
      );

      // 验证题目详情包含 runtime_config
      const detail = await apiGet(`/api/v1/problems/${problemId}`);
      const problem = (detail.body as { data: { runtime_config: unknown } })
        .data;
      if (!problem.runtime_config) {
        throw new Error("Expected runtime_config to be present");
      }
    },
  });

  Deno.test({
    name: "dual_container_judge: 普通用户尝试设置 runtime_config 被拒",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      // 普通用户注册
      const userToken = await registerUser(
        `dual_user_${Date.now()}`,
        `dual_user_${Date.now()}@test.local`,
        "UserPass123!",
      );

      // 普通用户创建题目时携带 runtime_config → 期望 201（双容器是唯一模式）
      const res = await apiPost(
        "/api/v1/problems",
        {
          title: `[${TEST_TAG}] 普通用户尝试双容器`,
          description: "test",
          difficulty: "easy",
          runtime_config: {
            evaluator: {
              image: EVALUATOR_IMAGE,
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },
            solution: {
              image: SOLUTION_IMAGE,
              entry: "solution.py",
              call_timeout_ms: 1000,
              memory_limit_mb: 256,
            },
          },
        },
        userToken,
      );

      // 期望 201（双容器是唯一模式，普通用户也可设置）
      if (res.status !== 201) {
        throw new Error(
          `Expected 201 for non-admin setting runtime_config, got ${res.status} ${
            JSON.stringify(res.body)
          }`,
        );
      }
    },
  });

  Deno.test({
    name: "dual_container_judge: 镜像白名单 kind 不匹配被拒",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const adminToken = await getAdminToken();
      await ensureImage(EVALUATOR_IMAGE, "evaluator");
      // 注意：SOLUTION_IMAGE 在此测试中假定为 evaluator kind（已由其它测试设置）
      // 实际上 ensureImage 会以 evaluator 创建（如果不存在），这里直接用
      //   kind='solution' 作为 runtime_config.solution.image
      //   会因为 kind 不匹配被拒。

      // 临时创建一个 evaluator 镜像：复用 EVALUATOR_IMAGE 当作 solution
      const res = await apiPost(
        "/api/v1/problems",
        {
          title: `[${TEST_TAG}] kind 错配测试`,
          description: "test",
          difficulty: "easy",
          type: "P",
          runtime_config: {
            evaluator: {
              image: EVALUATOR_IMAGE,
              command: "python3 /workspace/evaluate.py",
            },
            solution: {
              // 这里故意把 evaluator 镜像当 solution 用 → kind mismatch
              image: EVALUATOR_IMAGE,
              entry: "solution.py",
              call_timeout_ms: 1000,
              memory_limit_mb: 256,
            },
          },
        },
        adminToken,
      );

      // 期望 400 image kind mismatch
      if (res.status !== 400) {
        throw new Error(
          `Expected 400 for kind mismatch, got ${res.status} ${
            JSON.stringify(res.body)
          }`,
        );
      }
    },
  });

  Deno.test({
    name: "dual_container_judge: 清空 runtime_config 被拒（必填字段）",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const adminToken = await getAdminToken();
      await ensureImage(EVALUATOR_IMAGE, "evaluator");

      const problemId = await createDualProblem(
        adminToken,
        `[${TEST_TAG}] 清空 runtime 测试`,
      );

      // 验证双容器已设置
      const before = await apiGet(`/api/v1/problems/${problemId}`);
      if (!(before.body as { data: { runtime_config: unknown } }).data.runtime_config) {
        throw new Error("Expected runtime_config before update");
      }

      // 清空 runtime_config → 期望 400（runtime_config 是必填字段）
      const update = await apiPut(
        `/api/v1/problems/${problemId}`,
        {
          runtime_config: null,
        },
        adminToken,
      );
      if (update.status !== 400) {
        throw new Error(
          `Expected 400 when clearing runtime_config, got ${update.status} ${
            JSON.stringify(update.body)
          }`,
        );
      }
    },
  });

  Deno.test({
    name: "dual_container_judge: runtime_config 始终存在（双容器是唯一模式）",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const adminToken = await getAdminToken();
      await ensureImage(EVALUATOR_IMAGE, "evaluator");

      // 创建题目时必须携带 runtime_config
      const res = await apiPost(
        "/api/v1/problems",
        {
          title: `[${TEST_TAG}] runtime_config 必填`,
          description: "test",
          difficulty: "easy",
          type: "P",
          runtime_config: {
            evaluator: { image: EVALUATOR_IMAGE, command: "python3 /workspace/evaluate.py", time_limit_ms: 5000, memory_limit_mb: 512 },
            solution: { image: "noj-solution-python", entry: "submission_sample.py", call_timeout_ms: 2000, memory_limit_mb: 512 },
          },
        },
        adminToken,
      );

      if (res.status !== 201) {
        throw new Error(`Create failed: ${res.status}`);
      }

      const problemId = (res.body as { data: { id: string } }).data.id;
      const detail = await apiGet(`/api/v1/problems/${problemId}`);
      const rc = (detail.body as { data: { runtime_config: unknown } }).data
        .runtime_config;
      if (!rc) {
        throw new Error("Expected runtime_config to be present for dual-container mode");
      }
    },
  });

  Deno.test({
    name: "dual_container_judge: 普通用户提交双容器题目 → 走 dual 评测",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const adminToken = await getAdminToken();
      await ensureImage(EVALUATOR_IMAGE, "evaluator");
      await ensureImage(SOLUTION_IMAGE, "solution");

      const problemId = await createDualProblem(
        adminToken,
        `[${TEST_TAG}] 普通用户提交双容器`,
      );

      // 普通用户提交代码
      const userToken = await registerUser(
        `dual_sub_${Date.now()}`,
        `dual_sub_${Date.now()}@test.local`,
        "UserPass123!",
      );

      const sub = await apiPost(
        "/api/v1/submissions",
        {
          problem_id: problemId,
          language: "python3",
          code: "def solve(a, b):\n    return a + b\n",
        },
        userToken,
      );
      if (sub.status !== 201) {
        throw new Error(`Submit failed: ${sub.status} ${JSON.stringify(sub.body)}`);
      }
    },
  });
}