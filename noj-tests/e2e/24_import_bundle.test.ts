/**
 * 统一题目包导入闭环 E2E 测试。
 *
 * 覆盖：admin 上传统一题目包 → 题目创建（含 command 默认注入、评测包注册）
 * → 提交评测 → 结果正常（评测包剥离后可用）。
 *
 * 依赖：noj-core 服务（E2E 环境）+ noj-judge（评测部分，isJudgeAvailable 守卫）。
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  getAdminToken,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  submitCode,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
const testSuffix = Date.now().toString(36);
let adminToken = "";
let problemId = "";
let judgeAvailable = false;

const EVALUATOR_PY = `# E2E 统一包导入测试评测脚本
import json

result = {
    "status": "Accepted",
    "score": 100,
    "details": {
        "cases": [
            {"case_id": "1", "status": "Accepted", "score": 100, "time_ms": 1, "memory_kb": 1}
        ]
    },
}
print("---RESULT---")
print(json.dumps(result))
`;

const MANIFEST = JSON.stringify({
  format_version: 1,
  title: `E2E 导入测试 ${testSuffix}`,
  difficulty: "easy",
  type: "U",
  runtime_config: {
    evaluator: {
      image: "noj-evaluator-python",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      entry: "submission_sample.py",
      call_timeout_ms: 5000,
      memory_limit_mb: 512,
    },
  },
});

/**
 * 构造统一题目包 zip（临时目录 + 系统 zip 命令）。
 */
async function makeBundleZip(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  const enc = new TextEncoder();
  try {
    await Deno.writeFile(
      `${dir}/problem.json`,
      enc.encode(MANIFEST),
    );
    await Deno.writeFile(
      `${dir}/statement.md`,
      enc.encode(
        `# E2E 导入测试\n\n## 样例输入 1\n\`\`\`\n1 2\n\`\`\`\n\n## 样例输出 1\n\`\`\`\n3\n\`\`\`\n`,
      ),
    );
    await Deno.writeFile(`${dir}/evaluate.py`, enc.encode(EVALUATOR_PY));
    await Deno.writeFile(
      `${dir}/visible.jsonl`,
      enc.encode('{"input": "1 2", "output": "3"}\n'),
    );

    const zipPath = `${dir}/bundle.zip`;
    const cmd = new Deno.Command("zip", {
      args: ["-r", zipPath, "."],
      cwd: dir,
    });
    const out = await cmd.output();
    if (out.code !== 0) {
      throw new Error("zip 打包失败");
    }
    return await Deno.readFile(zipPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "[e2e/import-bundle] Setup: 管理员登录 + 构造统一包",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
    judgeAvailable = await isJudgeAvailable();
    // 构造 zip 提前验证可打包
    const zip = await makeBundleZip();
    if (zip.length === 0) throw new Error("统一包构造失败");
  },
});

Deno.test({
  name: "[e2e/import-bundle] admin 上传统一包创建题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const zip = await makeBundleZip();
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(
        [zip.buffer.slice(
          zip.byteOffset,
          zip.byteOffset + zip.byteLength,
        ) as ArrayBuffer],
        { type: "application/zip" },
      ),
      "e2e-bundle.zip",
    );

    const res = await fetch(
      `${await import("./helper.ts").then((m) =>
        m.BASE_URL
      )}/api/v1/problems/import-bundle`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: formData,
      },
    );
    if (res.status !== 200) {
      throw new Error(
        `导入失败: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      data: {
        id: string;
        type: string;
        title: string;
        support_package_storage_url: string | null;
        runtime_config: { evaluator: { command: string } };
      };
    };
    problemId = body.data.id;

    if (body.data.type !== "U") throw new Error("type 应为 U");
    if (!body.data.support_package_storage_url) {
      throw new Error("评测包未注册");
    }
    // command 默认值注入验证
    if (
      body.data.runtime_config.evaluator.command !==
        "python3 /workspace/evaluate.py"
    ) {
      throw new Error("evaluator.command 默认值未注入");
    }
  },
});

Deno.test({
  name: "[e2e/import-bundle] 重复导入幂等（不产生新题）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !problemId) return;
    const zip = await makeBundleZip();
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(
        [zip.buffer.slice(
          zip.byteOffset,
          zip.byteOffset + zip.byteLength,
        ) as ArrayBuffer],
        { type: "application/zip" },
      ),
      "e2e-bundle.zip",
    );
    const { BASE_URL } = await import("./helper.ts");
    const res = await fetch(`${BASE_URL}/api/v1/problems/import-bundle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formData,
    });
    if (res.status !== 200) throw new Error("重复导入失败");
    const body = (await res.json()) as { data: { id: string } };
    if (body.data.id !== problemId) {
      throw new Error("重复导入应更新同一题目而非新建");
    }
  },
});

Deno.test({
  name: "[e2e/import-bundle] 提交评测闭环（judge 可用时）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !problemId || !judgeAvailable) return;
    const submissionId = await submitCode(
      adminToken,
      problemId,
      "print('hello')",
    );
    const result = await pollSubmission(adminToken, submissionId);
    if (result.verdict !== "Accepted") {
      throw new Error(`评测结果异常: ${JSON.stringify(result)}`);
    }
  },
});

Deno.test({
  name: "[e2e/import-bundle] 删除导入的题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !problemId) return;
    const res = await apiDelete(`/api/v1/problems/${problemId}`, adminToken);
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`删除失败: ${res.status}`);
    }
    // 清理后查询应 404
    const check = await apiGet(`/api/v1/problems/${problemId}`, adminToken);
    if (check.status !== 404) throw new Error("题目删除后仍可访问");
  },
});
