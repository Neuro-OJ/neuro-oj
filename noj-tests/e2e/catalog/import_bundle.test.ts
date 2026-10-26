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
  apiPut,
  e2eTest,
  getAdminToken,
  isE2E,
  isJudgeAvailable,
  pollSubmission,
  publishProblemVersion,
  submitCode,
  waitForServer,
} from "../helper.ts";

const testSuffix = Date.now().toString(36);
let adminToken = "";
let problemId = "";
let judgeAvailable = false;

const EVALUATOR_PY = `# E2E 统一包导入测试评测脚本
import json
from noj_evaluator_sdk.runner import SolutionRunner

runner = SolutionRunner()
try:
    actual = str(runner.call("solve", "1 2")).strip()
    accepted = actual == "3"
    result = {
        "score": 100 if accepted else 0,
        "details": {"actual": actual, "expected": "3"},
    }
except Exception as error:
    result = {
        "score": 0,
        "details": {"error": str(error)},
    }
finally:
    runner.close()

print("---RESULT---")
print(json.dumps(result))
`;

const MANIFEST = JSON.stringify({
  format_version: 2,
  title: `E2E 导入测试 ${testSuffix}`,
  difficulty: "easy",
  // 数字题号在默认域匹配已有题；更新时仍必须提供草稿 revision。
  number: 90000 + (Date.now() % 9000),
  runtime_config: {
    evaluator: {
      image: "noj-evaluator-python",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
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

e2eTest("[e2e/import-bundle] Setup: 管理员登录 + 构造统一包", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  judgeAvailable = await isJudgeAvailable();
  // 构造 zip 提前验证可打包
  const zip = await makeBundleZip();
  if (zip.length === 0) throw new Error("统一包构造失败");
});

e2eTest("[e2e/import-bundle] admin 上传统一包创建题目", async () => {
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
    `${await import("../helper.ts").then((m) =>
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
      title: string;
    };
  };
  problemId = body.data.id;

  if ("type" in body.data) throw new Error("格式 2 不应返回 P/U 分类");
  // 导入只写草稿，公开投影尚无支持包；后续真实评测验证包对象可用。
  const draft = await apiGet(`/api/v1/problems/${problemId}/draft`, adminToken);
  if (draft.status !== 200) throw new Error("导入草稿不可读");
  const content = (draft.body as {
    data: { content: { runtime_config: { evaluator: { command: string } } } };
  }).data.content;
  if (
    content.runtime_config.evaluator.command !==
      "python3 /workspace/evaluate.py"
  ) {
    throw new Error("evaluator.command 默认值未注入");
  }
});

e2eTest("[e2e/import-bundle] 重复导入幂等（不产生新题）", async () => {
  if (!isE2E || !problemId) return;
  const draft = await apiGet(`/api/v1/problems/${problemId}/draft`, adminToken);
  if (draft.status !== 200) throw new Error("读取重复导入基线失败");
  const revision = (draft.body as { data: { revision: number } }).data.revision;
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
  const { BASE_URL } = await import("../helper.ts");
  const res = await fetch(`${BASE_URL}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "If-Match": String(revision),
    },
    body: formData,
  });
  if (res.status !== 200) {
    throw new Error(`重复导入失败: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string } };
  if (body.data.id !== problemId) {
    throw new Error("重复导入应更新同一题目而非新建");
  }
});

e2eTest("[e2e/import-bundle] 提交评测闭环（judge 可用时）", async () => {
  if (!isE2E || !problemId || !judgeAvailable) return;
  // 统一题包导入只写共享草稿（Handbook §6.2），提交前必须显式发布版本
  await publishProblemVersion(adminToken, problemId, "e2e 导入后发布");
  const submissionId = await submitCode(
    adminToken,
    problemId,
    `def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)`,
  );
  const result = await pollSubmission(adminToken, submissionId);
  if (result.status !== "finished" || result.score <= 0) {
    throw new Error(`评测结果异常: ${JSON.stringify(result)}`);
  }
});

e2eTest(
  "[e2e/import-bundle] 历史引用阻止物理删除，源题可停止公开",
  async () => {
    if (!isE2E || !problemId) return;
    const res = await apiDelete(`/api/v1/problems/${problemId}`, adminToken);
    if (res.status !== 409) {
      throw new Error(
        `已发布且有历史提交的题目必须禁止物理删除: ${res.status}`,
      );
    }
    const withdrawn = await apiPut(`/api/v1/problems/${problemId}/visibility`, {
      visibility: "private",
    }, adminToken);
    if (withdrawn.status !== 200) throw new Error("停止公开失败");
    const check = await apiGet(`/api/v1/problems/${problemId}`);
    if (check.status !== 404) throw new Error("停止公开后匿名仍能访问");
  },
);
