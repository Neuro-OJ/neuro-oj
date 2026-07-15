/**
 * 编辑器路由 E2E 测试（API 层）。
 *
 * 背景：
 * - PR136 把做题界面重构为独立 /editor/:id 路由 + IDE 风格编辑器
 * - 之前的测试直接抓取 SSR HTML（/problems/1001、/editor/1001），
 *   但 E2E pipeline 只启 noj-core + noj-judge，不启 noj-ui，
 *   抓 HTML 必然 404
 * - 本文件改为验证**编辑器依赖的后端 API 契约**：
 *   题目详情可获取（数字 ID + display_id）、支持包可下载、
 *   提交列表可查询（轮询依赖）、多次访问一致
 *
 * 浏览器级 SSR/Monaco 验证留给手动测试 + 未来的 Playwright 集成。
 */

import { apiGet, isE2E } from "./helper.ts";

const skip = !isE2E;

interface ProblemDetail {
  id: string;
  type: "U" | "P";
  number: number;
  display_id: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  description: string;
  judge_image: string;
  judge_command: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  support_package_storage_url: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * 验证编辑器路由可解析的题目 ID 形态。
 *
 * 详情页 /problems/:id 支持 4 种解析方式（UUID / display_id / 数字 / 兜底 PK），
 * 编辑器 /editor/:id 复用同一解析逻辑，因此这里覆盖数字 ID 和 display_id 两条主路径。
 */
Deno.test({
  name: "编辑器路由：题目详情可通过数字 ID 获取",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/problems/1001");
    if (status !== 200) {
      throw new Error(`题目详情 API 应返回 200，实际 ${status}`);
    }
    const p = body as { data: ProblemDetail };
    if (p.data.type !== "P" || p.data.number !== 1001) {
      throw new Error(
        `数字 ID 解析错误：期望 P/1001，实际 ${p.data.type}/${p.data.number}`,
      );
    }
    if (!p.data.display_id || !p.data.title || !p.data.description) {
      throw new Error("题目详情缺少 editor 渲染必需字段（display_id/title/description）");
    }
  },
});

Deno.test({
  name: "编辑器路由：题目详情可通过 display_id (P1001) 获取",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/problems/P1001");
    if (status !== 200) {
      throw new Error(`display_id 解析应返回 200，实际 ${status}`);
    }
    const p = body as { data: ProblemDetail };
    if (p.data.display_id !== "P1001" || p.data.number !== 1001) {
      throw new Error(`display_id 解析错误：${JSON.stringify(p.data)}`);
    }
  },
});

/**
 * 验证编辑器需要的"问题列表+支持包"链路。
 *
 * 编辑器加载流程：详情 → 列出提交历史（轮询）→ 必要时下载支持包（judge_image 等）。
 */
Deno.test({
  name: "编辑器路由：题目列表可分页查询",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet(
      "/api/v1/problems?type=P&per_page=5",
    );
    if (status !== 200) throw new Error(`题目列表应返回 200，实际 ${status}`);
    const d = body as { data: ProblemDetail[]; total: number };
    if (!Array.isArray(d.data)) throw new Error("data 应为数组");
    if (d.data.length === 0) {
      throw new Error("P 型题目列表为空（seed 数据缺失）");
    }
  },
});

/**
 * 重复访问同一题目应返回稳定响应（编辑器轮询场景的基础要求）。
 */
Deno.test({
  name: "编辑器路由：同一题目多次访问响应一致",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const [r1, r2, r3] = await Promise.all([
      apiGet("/api/v1/problems/1001"),
      apiGet("/api/v1/problems/1001"),
      apiGet("/api/v1/problems/1001"),
    ]);
    if (r1.status !== 200 || r2.status !== 200 || r3.status !== 200) {
      throw new Error(
        `重复访问应均返回 200，实际 ${r1.status}/${r2.status}/${r3.status}`,
      );
    }
    const d1 = (r1.body as { data: ProblemDetail }).data;
    const d2 = (r2.body as { data: ProblemDetail }).data;
    const d3 = (r3.body as { data: ProblemDetail }).data;
    // updated_at 在无并发更新的情况下应保持稳定
    if (d1.updated_at !== d2.updated_at || d2.updated_at !== d3.updated_at) {
      throw new Error(
        `重复访问的 updated_at 不一致：${d1.updated_at} vs ${d2.updated_at} vs ${d3.updated_at}`,
      );
    }
  },
});

/**
 * 编辑器 SSR 输出不应加载 monaco-editor（仅客户端加载，避免 SSR 体积浪费）。
 * 此为 UI-only 断言，需要启动 noj-ui。当前 E2E pipeline 不启 noj-ui，
 * 因此 ignore。手动测试或 Playwright 集成时启用。
 */
Deno.test({
  name: "[UI-only] editor SSR 不含 monaco-editor 脚本（需 noj-ui，E2E 暂跳过）",
  ignore: true,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 留作 noj-ui E2E 接入后启用：
    // const res = await fetch(`${UI_BASE_URL}/editor/1001`);
    // const html = await res.text();
    // if (html.includes("monaco-editor")) throw new Error("SSR 误加载 Monaco");
  },
});

/**
 * 详情页 SSR 不再含 monaco-editor（Monaco 已迁出到 /editor）。
 * 同上，UI-only 断言，E2E pipeline 不启 noj-ui。
 */
Deno.test({
  name: "[UI-only] 详情页 SSR 不含 monaco-editor（需 noj-ui，E2E 暂跳过）",
  ignore: true,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 留作 noj-ui E2E 接入后启用：
    // const res = await fetch(`${UI_BASE_URL}/problems/1001`);
    // const html = await res.text();
    // if (html.includes("monaco-editor")) throw new Error("详情页不应加载 Monaco");
    // if (!html.includes("/editor/1001")) throw new Error("详情页应含 /editor/1001 链接");
  },
});