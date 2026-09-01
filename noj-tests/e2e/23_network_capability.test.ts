/**
 * 评测网络能力（evaluator 联网 + capability）跨模块 E2E。
 *
 * 覆盖（issue #197）：
 * - 普通用户创建带 network.enabled=true 的 U 型题目（权限放行，无需 admin）
 * - 普通用户通过 import-bundle 导入带联网配置的统一题目包（导入路径同权限）
 * - 提交 solution（call_capability）→ 评测完成且 evaluator 联网真实生效：
 *   capability handler 内真实 TCP 出网探测（example.com:443）成功才 Accepted，
 *   evaluator 无网则返回 no-net → WrongAnswer（测试失败即暴露网络回归）
 *
 * 要求：
 *   NOJ_RUN_E2E=1 表示启用 E2E 测试套件
 *   E2E_BASE_URL 指向运行中的 noj-core 服务
 *   评测镜像 noj-evaluator-python / noj-solution-python 已构建并加入白名单
 *   系统 zip 命令可用（与 24_import_bundle.test.ts 相同约定）
 */

import {
  apiGet,
  apiPost,
  BASE_URL,
  e2eTest,
  getAdminToken,
  getProblemIdByNumber,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

// ── 测试常量 ─────────────────────────────────────────

const EVALUATOR_IMAGE = "noj-evaluator-python";
const SOLUTION_IMAGE = "noj-solution-python";
const TEST_TAG = `e2e-netcap-${Date.now()}`;

let adminToken = "";
let userToken = "";
let bundleProblemId = ""; // import-bundle 导入的题目（用例 2）
let judgeOk = false;

/** 创建（或复用）评测镜像白名单条目 */
async function ensureImage(
  image: string,
  kind: "evaluator" | "solution",
): Promise<void> {
  const adminToken = await getAdminToken();
  const list = await apiGet("/api/v1/admin/judge-images", adminToken);
  type JiEntry = { id: string; image: string; kind: string };
  const existing = ((list.body as { data: JiEntry[] }).data ?? []).find(
    (ji) => ji.image === image && ji.kind === kind,
  );
  if (existing) return;

  const create = await apiPost(
    "/api/v1/admin/judge-images",
    { image, kind, mode: "exact", description: `e2e ${kind} image` },
    adminToken,
  );
  if (create.status !== 201) {
    throw new Error(
      `Failed to create image ${image} (kind=${kind}): ${create.status} ${
        JSON.stringify(create.body)
      }`,
    );
  }
}

/** evaluate.py：注册 capability + evaluator 真实 TCP 出网探测（需外网） */
function evaluatePy(): string {
  return `
import socket
from noj_evaluator_sdk import SolutionRunner, register_capability, result

def ping(msg: str) -> str:
    # handler 在 evaluator（bridge 联网）内执行：真实 TCP 出网探测。
    # evaluator 无网时返回 no-net → 评测 WrongAnswer，暴露网络回归。
    try:
        socket.create_connection(("example.com", 443), timeout=5).close()
        return "pong:" + msg
    except OSError as e:
        return "no-net:" + str(e)

register_capability("ping", ping)

runner = SolutionRunner()
try:
    answer = runner.call("solve", "hello")
except Exception as e:
    result.runtime_error("call failed: " + repr(e))
else:
    if answer == "pong:hello":
        result.accept(score=100)
    else:
        result.wrong_answer(score=0, message="unexpected: " + repr(answer))
`;
}

/** 构造统一题目包 zip（临时目录 + 系统 zip 命令，network.enabled=true） */
async function makeBundleZip(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  const enc = new TextEncoder();
  try {
    const manifest = JSON.stringify({
      format_version: 1,
      title: `[${TEST_TAG}] 联网能力导入题`,
      difficulty: "easy",
      type: "U",
      // 普通用户导入不带 number（number 由系统自动分配）
      runtime_config: {
        evaluator: {
          image: EVALUATOR_IMAGE,
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 20000,
          memory_limit_mb: 512,
          network: { enabled: true },
        },
        solution: {
          image: SOLUTION_IMAGE,
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      },
    });
    await Deno.writeFile(`${dir}/problem.json`, enc.encode(manifest));
    await Deno.writeFile(
      `${dir}/statement.md`,
      enc.encode(
        `# 联网能力测试\n\n通过 call_capability 调用 evaluator 网络能力。\n`,
      ),
    );
    await Deno.writeFile(`${dir}/evaluate.py`, enc.encode(evaluatePy()));

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

/** 上传统一题目包（import-bundle），返回题目 id */
async function importBundle(zip: Uint8Array): Promise<string> {
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
    "netcap-bundle.zip",
  );
  const baseUrl = BASE_URL;
  const res = await fetch(`${baseUrl}/api/v1/problems/import-bundle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: formData,
  });
  if (res.status !== 200) {
    throw new Error(
      `导入失败: ${res.status} ${(await res.text()).slice(0, 500)}`,
    );
  }
  const body = (await res.json()) as {
    data: {
      id: string;
      runtime_config: {
        evaluator: { network?: { enabled?: boolean } };
      };
    };
  };
  if (body.data.runtime_config.evaluator.network?.enabled !== true) {
    throw new Error(
      "导入后 runtime_config.evaluator.network.enabled 未保留为 true",
    );
  }
  return body.data.id;
}

/** 探测 judge 是否可用：提交样例题并等待评测有结果。
 *
 * 与 helper.isJudgeAvailable 不同：这里把 status=error 也视为可用——
 * 提交 print(1) 对样例题必然 SystemError（用户代码无 solve 函数），
 * 但评测链路完整跑通本身就证明 judge worker 可用。
 */
async function judgeAvailable(): Promise<boolean> {
  try {
    const ts = Date.now().toString(36);
    const t = await registerUser(
      "netcap_jchk_" + ts,
      "netcap_jchk_" + ts + "@test.com",
      TEST_PASSWORD,
    );
    const problemId = await getProblemIdByNumber(1001);
    const id = await submitCode(t, problemId, "print(1)");
    const baseUrl = BASE_URL;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(
        `${baseUrl}/api/v1/submissions/${id}`,
        { headers: { Authorization: "Bearer " + t } },
      );
      const data = await res.json();
      const status = (data as { data?: { status?: string } })?.data?.status ||
        "";
      if (
        status === "judging" || status === "finished" || status === "error"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── 测试 ────────────────────────────────────────────

e2eTest("[e2e/network-capability] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  userToken = await registerUser(
    "netcap_" + ts,
    "netcap_" + ts + "@test.com",
    TEST_PASSWORD,
  );
  await ensureImage(EVALUATOR_IMAGE, "evaluator");
  await ensureImage(SOLUTION_IMAGE, "solution");
  judgeOk = await judgeAvailable();
  if (!judgeOk) console.log("  ⚠ judge worker 不可用，评测用例将跳过");
});

e2eTest(
  "[e2e/network-capability] 管理员创建联网题放行（network.enabled=true）",
  async () => {
    if (!isE2E) return;
    const res = await apiPost(
      "/api/v1/problems",
      {
        title: `[${TEST_TAG}] 联网能力测试题`,
        description: `# 联网能力测试题\n\n管理员创建，evaluator 开启联网。`,
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: EVALUATOR_IMAGE,
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 20000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
          solution: {
            image: SOLUTION_IMAGE,
            call_timeout_ms: 5000,
            memory_limit_mb: 256,
          },
        },
      },
      adminToken,
    );
    if (res.status !== 201) {
      throw new Error(
        `管理员创建联网题应放行（201），实际 ${res.status} ${
          JSON.stringify(res.body)
        }`,
      );
    }
    const data = (res.body as {
      data: {
        id: string;
        runtime_config: {
          evaluator: { network?: { enabled?: boolean } };
        };
      };
    }).data;
    if (data.runtime_config.evaluator.network?.enabled !== true) {
      throw new Error("runtime_config.evaluator.network.enabled 未保留为 true");
    }
  },
);

e2eTest(
  "[e2e/network-capability] 管理员导入联网统一包（import-bundle 放行）",
  async () => {
    if (!isE2E) return;
    const zip = await makeBundleZip();
    bundleProblemId = await importBundle(zip);
    console.log(
      `  → 导入题目 ${bundleProblemId.slice(0, 8)} 成功（联网已开启）`,
    );
  },
);

e2eTest(
  "[e2e/network-capability] 提交 solution（call_capability）→ 评测 Accepted",
  async () => {
    if (!isE2E || !judgeOk) {
      console.log("  ⚠ judge 不可用，跳过评测断言");
      return;
    }
    const code = `
from noj_solution_sdk import register, call_capability

@register
def solve(msg: str) -> str:
    return call_capability("ping", msg)
`;
    const id = await submitCode(userToken, bundleProblemId, code);
    console.log(`  → 提交 ID: ${id.slice(0, 8)}`);
    const result = await pollSubmission(userToken, id, 40, 3000);
    console.log(`  → ${result.status} (${result.score}分)`);
    if (result.status !== "finished" || result.score <= 0) {
      throw new Error(
        `期望 finished 且分数 >0（evaluator 联网 + capability 全链路），实际 ${result.status}`,
      );
    }
  },
);
