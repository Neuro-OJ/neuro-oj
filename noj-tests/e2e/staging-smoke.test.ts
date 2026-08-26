/**
 * 生产镜像 staging 验收烟测。
 *
 * 该文件只由 scripts/staging/acceptance.sh 调用，要求 judge 使用带仓库
 * 前缀的生产候选镜像，避免本地 bare image 掩盖白名单与拉取问题。
 */

import { TOTP } from "npm:otpauth@^9";
import {
  apiDelete,
  apiGet,
  apiPost,
  BASE_URL,
  e2eTest,
  getAdminToken,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

const testSuffix = Date.now().toString(36);
const evaluatorImage = Deno.env.get("E2E_EVALUATOR_IMAGE") ||
  "noj-evaluator-python";
const solutionImage = Deno.env.get("E2E_SOLUTION_IMAGE") ||
  "noj-solution-python";

let adminToken = "";
let problemId = "";
let submissionId = "";
let userToken = "";
let tfaSecret = "";

const problemNumber = 91000 + (Date.now() % 9000);
const manifest = JSON.stringify({
  format_version: 1,
  title: `Staging 验收题 ${testSuffix}`,
  difficulty: "easy",
  type: "U",
  number: problemNumber,
  runtime_config: {
    evaluator: {
      image: evaluatorImage,
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: solutionImage,
      call_timeout_ms: 5000,
      memory_limit_mb: 512,
    },
  },
});

const evaluator = `import json
from noj_evaluator_sdk.runner import SolutionRunner

runner = SolutionRunner()
try:
    actual = str(runner.call("solve", "1 2")).strip()
    accepted = actual == "3"
    result = {
        "status": "Accepted" if accepted else "WrongAnswer",
        "score": 100 if accepted else 0,
        "details": {"actual": actual, "expected": "3"},
    }
except Exception as error:
    result = {"status": "RuntimeError", "score": 0, "details": {"error": str(error)}}
finally:
    runner.close()

print("---RESULT---")
print(json.dumps(result))
`;

async function makeBundleZip(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  const encoder = new TextEncoder();
  try {
    await Deno.writeFile(`${dir}/problem.json`, encoder.encode(manifest));
    await Deno.writeFile(
      `${dir}/statement.md`,
      encoder.encode("# Staging 验收题\n\n输入两个整数，输出它们的和。\n"),
    );
    await Deno.writeFile(`${dir}/evaluate.py`, encoder.encode(evaluator));
    await Deno.writeFile(
      `${dir}/visible.jsonl`,
      encoder.encode('{"input":"1 2","output":"3"}\n'),
    );

    const zipPath = `${dir}/staging-bundle.zip`;
    const result = await new Deno.Command("zip", {
      args: ["-r", zipPath, "."],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (result.code !== 0) throw new Error("staging 题包打包失败");
    return await Deno.readFile(zipPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function importBundle(): Promise<string> {
  const zip = await makeBundleZip();
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([
      zip.buffer.slice(
        zip.byteOffset,
        zip.byteOffset + zip.byteLength,
      ) as ArrayBuffer,
    ], { type: "application/zip" }),
    "staging-bundle.zip",
  );
  const response = await fetch(`${BASE_URL}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: formData,
  });
  if (response.status !== 200) {
    throw new Error(
      `题包导入失败: ${response.status} ${await response.text()}`,
    );
  }
  const body = await response.json() as {
    data: {
      id: string;
      type: string;
      support_package_storage_url: string | null;
    };
  };
  if (body.data.type !== "U" || !body.data.support_package_storage_url) {
    throw new Error("题包导入响应缺少 U 型题目或对象存储地址");
  }
  if (!body.data.support_package_storage_url.startsWith("noj-storage://s3/")) {
    throw new Error(
      `staging 未使用 S3 支持包地址: ${body.data.support_package_storage_url}`,
    );
  }
  return body.data.id;
}

function currentCode(secret: string): string {
  return new TOTP({ secret, issuer: "NeuroOJ" }).generate();
}

async function readSseOnce(url: string, token: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE 连接失败: ${response.status}`);
    }
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value || new Uint8Array());
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

e2eTest("[e2e/staging] 启动检查与管理员登录改密", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  if (!adminToken) throw new Error("管理员登录改密后未获得 token");
});

e2eTest("[e2e/staging] 用户登录与 TFA 全流程", async () => {
  if (!isE2E) return;
  const login = `staging_tfa_${testSuffix}`;
  userToken = await registerUser(login, `${login}@test.com`, TEST_PASSWORD);

  const setup = await apiPost("/api/v1/auth/tfa/setup", {}, userToken);
  if (setup.status !== 200) throw new Error(`TFA setup 失败: ${setup.status}`);
  tfaSecret = (setup.body as { data: { secret: string } }).data.secret;
  const confirm = await apiPost(
    "/api/v1/auth/tfa/confirm",
    { code: currentCode(tfaSecret) },
    userToken,
  );
  if (confirm.status !== 200) {
    throw new Error(`TFA confirm 失败: ${confirm.status}`);
  }

  const missingCode = await apiPost("/api/v1/auth/login", {
    login,
    password: TEST_PASSWORD,
  });
  if (missingCode.status !== 400) throw new Error("缺少 TFA code 未被拒绝");
  const loggedIn = await apiPost("/api/v1/auth/login", {
    login,
    password: TEST_PASSWORD,
    code: currentCode(tfaSecret),
  });
  if (loggedIn.status !== 200) throw new Error("正确 TFA code 登录失败");
});

e2eTest("[e2e/staging] 导入题包并验证对象存储下载", async () => {
  if (!isE2E) return;
  problemId = await importBundle();
  const packageResponse = await apiGet(
    `/api/v1/problems/${problemId}/support-package`,
    adminToken,
  );
  if (packageResponse.status !== 200) {
    throw new Error(`对象存储支持包下载失败: ${packageResponse.status}`);
  }
});

e2eTest("[e2e/staging] 真实提交完成评测", async () => {
  if (!isE2E) return;
  submissionId = await submitCode(
    adminToken,
    problemId,
    `def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)`,
  );
  const result = await pollSubmission(adminToken, submissionId);
  if (result.verdict !== "Accepted") {
    throw new Error(`真实评测未通过: ${JSON.stringify(result)}`);
  }
});

e2eTest("[e2e/staging] 提交 SSE 可连接并收到事件", async () => {
  if (!isE2E) return;
  const payload = await readSseOnce(
    `${BASE_URL}/api/v1/submissions/${submissionId}/events`,
    adminToken,
  );
  if (!payload) throw new Error("SSE 连接未收到任何事件数据");
});

e2eTest("[e2e/staging] 管理员重测并再次完成评测", async () => {
  if (!isE2E) return;
  const response = await apiPost(
    `/api/v1/admin/submissions/${submissionId}/rejudge`,
    {},
    adminToken,
  );
  if (response.status !== 200) {
    throw new Error(`重测发起失败: ${response.status}`);
  }
  const result = await pollSubmission(adminToken, submissionId);
  if (result.verdict !== "Accepted") {
    throw new Error(`重测结果未通过: ${JSON.stringify(result)}`);
  }
});

e2eTest("[e2e/staging] 清理验收题目", async () => {
  if (!isE2E || !problemId) return;
  const response = await apiDelete(`/api/v1/problems/${problemId}`, adminToken);
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`清理 staging 题目失败: ${response.status}`);
  }
});
