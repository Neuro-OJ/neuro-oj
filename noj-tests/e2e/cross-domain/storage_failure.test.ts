/**
 * 存储故障 E2E：本地存储文件缺失/无支持包时，下载可观测失败且提交主流程不被阻塞。
 *
 * E2E 栈使用 `STORAGE_PROVIDER=local`（见 docker-compose.e2e.yml），因此本测试
 * 不验证 S3 presigned URL，而是验证：
 * - 无支持包题目下载返回 404（local 存储路径不存在）
 * - 存储文件被删除后下载返回 5xx（存储故障可观测）
 * - 存储故障不阻塞代码提交创建（评测阶段才读取支持包）
 */

import {
  apiGet,
  apiPost,
  BASE_URL,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

let adminToken = "";
let ownerToken = "";
let PROBLEM_ID = "";
let brokenProblemId = "";
let brokenStorageKey = "";

const testSuffix = Date.now().toString(36);

const MANIFEST = JSON.stringify({
  format_version: 1,
  title: `E2E 存储故障测试 ${testSuffix}`,
  difficulty: "easy",
  type: "U",
  number: 91000 + (Date.now() % 9000),
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
        `# E2E 存储故障测试\n\n## 样例输入 1\n\n\`\`\`\n1 2\n\`\`\`\n\n## 样例输出 1\n\n\`\`\`\n3\n\`\`\`\n`,
      ),
    );
    await Deno.writeFile(
      `${dir}/evaluate.py`,
      enc.encode(
        `import json
from noj_evaluator_sdk.runner import SolutionRunner

runner = SolutionRunner()
try:
    actual = str(runner.call("solve", "1 2")).strip()
    result = {"score": 100 if actual == "3" else 0, "details": {"actual": actual}}
except Exception as error:
    result = {"score": 0, "details": {"error": str(error)}}
finally:
    runner.close()

print("---RESULT---")
print(json.dumps(result))
`,
      ),
    );
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

e2eTest("[e2e/storage-failure] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  ownerToken = await registerUser(
    "st_user_" + ts,
    "st_user_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  PROBLEM_ID = await getProblemIdByNumber(1001);
});

e2eTest("[e2e/storage-failure] 无支持包下载返回 404", async () => {
  if (!isE2E) return;
  const res = await apiPost(
    "/api/v1/problems",
    {
      title: "存储故障无包测试",
      description: "无支持包",
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      type: "U",
    },
    adminToken,
  );
  if (res.status !== 201) {
    throw new Error(
      "创建题目失败: " + res.status + " " + JSON.stringify(res.body),
    );
  }
  const pid = (res.body as { data: { id: string } }).data.id;
  const download = await apiGet(
    `/api/v1/problems/${pid}/support-package`,
    adminToken,
  );
  if (download.status !== 404) {
    throw new Error("无支持包应返回 404, 实际 " + download.status);
  }
});

e2eTest("[e2e/storage-failure] 存储文件缺失时下载返回 5xx", async () => {
  if (!isE2E) return;
  // 通过 import-bundle 创建带支持包的题目（当前唯一服务端写入 storage URL 的入口）
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
    "storage-failure-bundle.zip",
  );

  const res = await fetch(`${BASE_URL}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: formData,
  });
  if (res.status !== 200) {
    throw new Error("导入失败: " + res.status + " " + await res.text());
  }
  const body = (await res.json()) as {
    data: { id: string; support_package_storage_url: string | null };
  };
  brokenProblemId = body.data.id;
  const storageUrl = body.data.support_package_storage_url;
  if (!storageUrl || !storageUrl.startsWith("noj-storage://local/")) {
    throw new Error("期望 local 存储 URL, 实际 " + storageUrl);
  }
  // 解析 local key：noj-storage://local/<base64>?checksum_sha256=...
  brokenStorageKey = storageUrl.split("?")[0].replace(
    "noj-storage://local/",
    "",
  );

  // 删除容器内存储文件模拟存储故障（与 pipeline.test.ts 的 docker exec 模式一致）
  try {
    const cmd = new Deno.Command("docker", {
      args: [
        "exec",
        "noj-e2e-core",
        "rm",
        "-f",
        `/app/data/storage/${brokenStorageKey}.zip`,
      ],
    });
    const out = await cmd.output();
    if (!out.success) {
      console.log("  ⚠ docker exec 删除存储文件失败，跳过存储故障断言");
      return;
    }
  } catch {
    console.log("  ⚠ docker exec 不可用，跳过存储故障断言");
    return;
  }

  const download = await apiGet(
    `/api/v1/problems/${brokenProblemId}/support-package`,
    adminToken,
  );
  if (download.status < 500 || download.status >= 600) {
    throw new Error("存储文件缺失应返回 5xx, 实际 " + download.status);
  }
});

e2eTest(
  "[e2e/storage-failure] 提交仍可创建（存储故障不阻塞主流程）",
  async () => {
    if (!isE2E) return;
    // 针对存储已损坏的题目提交：接口仍应接受（评测阶段才读取支持包），
    // 不能因为存储故障在创建提交时直接报错。
    if (!brokenProblemId) throw new Error("缺少 brokenProblemId");
    const id = await submitCode(ownerToken, brokenProblemId, "print(1)");
    if (!id) {
      throw new Error("提交未返回 ID");
    }
  },
);

e2eTest("[e2e/storage-failure] 清理导入的题目", async () => {
  if (!isE2E || !brokenProblemId) return;
  const del = await fetch(`${BASE_URL}/api/v1/problems/${brokenProblemId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (del.status !== 204 && del.status !== 200) {
    throw new Error("清理导入题目失败: " + del.status);
  }
});
