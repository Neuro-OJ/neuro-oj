/**
 * 恢复演练业务验收脚本。
 *
 * 由 scripts/deploy/restore-drill.sh 在隔离恢复出的 core 容器内执行
 * （`docker compose run core deno run -A /opt/verify.ts ...`），面向真实
 * HTTP API 验证恢复后的业务链路：登录、题目读取、附件下载与真实评测。
 *
 * 输出：每个步骤一行 JSON（{"step","status","detail"}），最后一行输出
 * {"step":"summary","status":...,"passed":bool,"steps":[...]}，由外层脚本
 * 汇总写入演练报告。任何 required 步骤失败时进程以非零退出。
 *
 * 凭据与评测镜像名通过环境变量传入（DRILL_*），不写入命令行参数。
 */

interface StepResult {
  step: string;
  status: "passed" | "failed" | "warning" | "skipped";
  detail: string;
}

const results: StepResult[] = [];

let requiredFailure = false;

function record(
  step: string,
  status: StepResult["status"],
  detail: string,
): void {
  results.push({ step, status, detail });
  console.log(JSON.stringify({ step, status, detail }));
}

function required(step: string, ok: boolean, detail: string): void {
  record(step, ok ? "passed" : "failed", detail);
  if (!ok) requiredFailure = true;
}

function optEnv(name: string): string {
  const value = Deno.env.get(name) ?? "";
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

const BASE_URL = optEnv("DRILL_BASE_URL").replace(/\/$/, "");
const ADMIN_USER = optEnv("DRILL_ADMIN_USER");
const ADMIN_PASSWORD = optEnv("DRILL_ADMIN_PASSWORD");
const EVALUATOR_IMAGE = optEnv("DRILL_EVALUATOR_IMAGE");
const SOLUTION_IMAGE = optEnv("DRILL_SOLUTION_IMAGE");
const SKIP_EVALUATION = Deno.env.get("DRILL_SKIP_EVALUATION") === "1";

/** 与生产一致的 cookie 名；HttpOnly JWT 由登录响应下发。 */
let authCookie = "";

async function api(
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authCookie) headers.set("Cookie", authCookie);
  return await fetch(`${BASE_URL}${path}`, { method, ...init, headers });
}

/** 解析响应中的 Set-Cookie，保存 noj:token 供后续请求鉴权。 */
function captureAuthCookie(res: Response): void {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|[,\s])noj:token=([^;,\s]+)/);
  if (match) authCookie = `noj:token=${match[1]}`;
}

// ---------------------------------------------------------------------------
// 最小 ZIP 构造器（仅 store 存储，不压缩）：用于导入演练题目包。
// 数据量极小（< 4 KB），CRC32 + 本地文件头 + 中央目录即可构造合法 zip。
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF]! ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 构造 store 模式 zip（DOS 时间固定为 2026-01-01 00:00:00）。 */
function buildZip(
  entries: Array<{ name: string; content: string }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...chunks, ...central, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** 构造演练题目包：A+B 双容器评测题，含 evaluator 脚本与公开数据。 */
function buildDrillBundle(): Uint8Array {
  const evaluatorPy = `#!/usr/bin/env python3
"""NOJ 恢复演练 evaluator：调用 solve 并校验 A+B 结果。"""
import json
from noj_evaluator_sdk.runner import SolutionRunner

def main() -> None:
    runner = SolutionRunner()
    output = ""
    try:
        output = str(runner.call("solve", "1 2\\n"))
    except Exception as exc:  # noqa: BLE001 - 演练 evaluator 容错记录
        output = f"ERROR: {exc}"
    ok = output.strip() == "3"
    print("---RESULT---")
    print(json.dumps({"score": 100 if ok else 0, "details": {"output": output}}))
    runner.close()

if __name__ == "__main__":
    main()
`;
  const manifest = {
    format_version: 1,
    title: "NOJ 恢复演练自测题",
    description:
      "恢复演练自动导入的 A+B 自测题，验证隔离恢复后的真实评测链路。",
    difficulty: "easy",
    type: "P",
    template: "template.py",
    runtime_config: {
      evaluator: {
        image: EVALUATOR_IMAGE,
        time_limit_ms: 60000,
        memory_limit_mb: 256,
      },
      solution: {
        image: SOLUTION_IMAGE,
        call_timeout_ms: 10000,
        memory_limit_mb: 256,
      },
    },
  };
  return buildZip([
    { name: "problem.json", content: JSON.stringify(manifest) },
    {
      name: "statement.md",
      content: "# NOJ 恢复演练自测题\n\n实现 solve(input_str) 返回两数之和。\n",
    },
    {
      name: "template.py",
      content: "def solve(input_str: str) -> str:\n    ...\n",
    },
    { name: "evaluate.py", content: evaluatorPy },
    {
      name: "visible.jsonl",
      content: '{"id":"v001","input":"1 2\\n","expected":3}\n',
    },
  ]);
}

// ---------------------------------------------------------------------------
// 业务验收步骤
// ---------------------------------------------------------------------------

/** 登录演练管理员账号（由外层脚本经 SQL 注入并授予 admin 角色）。 */
async function stepLogin(): Promise<void> {
  const res = await api("POST", "/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  captureAuthCookie(res);
  if (res.status !== 200) {
    required(
      "login",
      false,
      `POST /auth/login 返回 HTTP ${res.status}`,
    );
    return;
  }
  const payload = await res.json();
  const username = payload?.data?.username ?? ADMIN_USER;
  required(
    "login",
    Boolean(authCookie),
    `管理员 ${username} 登录成功并下发会话 Cookie`,
  );
}

/** 题目读取：列表 + 新导入题目的详情。 */
async function stepProblemRead(problemId: string | null): Promise<void> {
  const listRes = await api("GET", "/problems");
  if (listRes.status !== 200) {
    required(
      "problem_read",
      false,
      `GET /problems 返回 HTTP ${listRes.status}`,
    );
    return;
  }
  const list = await listRes.json();
  const total = Array.isArray(list?.data)
    ? list.data.length
    : typeof list?.data?.total === "number"
    ? list.data.total
    : 0;
  if (!problemId) {
    required(
      "problem_read",
      true,
      `GET /problems 正常返回（当前可见题目数：${total}）`,
    );
    return;
  }
  const detailRes = await api("GET", `/problems/${problemId}`);
  required(
    "problem_read",
    detailRes.status === 200,
    detailRes.status === 200
      ? `GET /problems 正常（可见题目数：${total}），题目详情 ${problemId} 读取正常`
      : `GET /problems/${problemId} 返回 HTTP ${detailRes.status}`,
  );
}

/** 附件下载：经 core 代理从恢复后的对象存储下载题目支持包。 */
async function stepAttachmentDownload(problemId: string): Promise<void> {
  const res = await api("GET", `/problems/${problemId}/support-package`);
  if (res.status !== 200) {
    required(
      "attachment_download",
      false,
      `GET /problems/${problemId}/support-package 返回 HTTP ${res.status}`,
    );
    return;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const zipMagic = bytes[0] === 0x50 && bytes[1] === 0x4b;
  required(
    "attachment_download",
    bytes.length > 0 && zipMagic,
    `支持包下载成功：${bytes.length} 字节，zip 头校验${
      zipMagic ? "通过" : "失败"
    }`,
  );
}

/**
 * 真实评测：提交 A+B 正确解并轮询自测结果。
 * 走完整链路：core 入队 → judge 沙箱 → Evaluator + Solution 双容器 → 结果回写。
 */
async function stepEvaluation(problemId: string): Promise<void> {
  if (SKIP_EVALUATION) {
    record("evaluation", "skipped", "演练以 --skip-judge 运行，未执行真实评测");
    return;
  }
  const code =
    "def solve(input_str: str) -> str:\n    a, b = map(int, input_str.split())\n    return str(a + b)\n";
  const createRes = await api(
    "POST",
    `/problems/${problemId}/self-test`,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python3", code, file_name: "main.py" }),
    },
  );
  if (createRes.status !== 201) {
    required(
      "evaluation",
      false,
      `POST self-test 返回 HTTP ${createRes.status}：${
        (await createRes.text()).slice(0, 200)
      }`,
    );
    return;
  }
  const created = await createRes.json();
  const selfTestId = created?.data?.id;
  if (!selfTestId) {
    required("evaluation", false, "self-test 响应缺少 id");
    return;
  }

  const timeoutMs = 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let status = "";
  let resultStatus: string | null = null;
  let score: number | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await api("GET", `/self-tests/${selfTestId}`);
    if (poll.status !== 200) {
      required(
        "evaluation",
        false,
        `GET /self-tests/${selfTestId} 返回 HTTP ${poll.status}`,
      );
      return;
    }
    const body = await poll.json();
    status = body?.data?.status ?? "";
    resultStatus = body?.data?.result_status ?? null;
    score = typeof body?.data?.score === "number" ? body.data.score : null;
    if (status === "finished" || status === "error") break;
  }
  const ok = status === "finished" && resultStatus === "finished" &&
    score !== null && score > 0;
  required(
    "evaluation",
    ok,
    ok
      ? `自测 ${selfTestId} 评测成功：status=${status}，得分 ${score}`
      : `自测 ${selfTestId} 未通过：status=${status}，result_status=${resultStatus}，score=${score}`,
  );
}

/** 额外观察项：注册链路。受邮件提供方影响，失败只记 warning 不影响结论。 */
async function stepRegisterProbe(): Promise<void> {
  const suffix = Date.now().toString(36);
  const res = await api("POST", "/auth/register", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: `drill_${suffix}`.slice(0, 30),
      email: `drill-${suffix}@restore-drill.invalid`,
      password: "Drill-Recover-2026",
    }),
  });
  if (res.status === 201) {
    record("register_probe", "passed", "注册接口返回 201");
  } else {
    record(
      "register_probe",
      "warning",
      `POST /auth/register 返回 HTTP ${res.status}；注册链路受邮件提供方影响，不计入演练结论`,
    );
  }
}

async function main(): Promise<void> {
  await stepLogin();
  if (requiredFailure) {
    finish();
    return;
  }

  // 导入演练题目（admin 权限）：同时验证对象存储写入与数据库写入。
  let problemId: string | null = null;
  const bundle = buildDrillBundle();
  const form = new FormData();
  form.append(
    "file",
    new File([bundle as unknown as BlobPart], "noj-drill-bundle.zip", {
      type: "application/zip",
    }),
  );
  const importRes = await api("POST", "/problems/import-bundle", {
    body: form,
  });
  if (importRes.status === 200 || importRes.status === 201) {
    const payload = await importRes.json();
    problemId = payload?.data?.problem?.id ?? payload?.data?.id ?? null;
    record(
      "problem_import",
      "passed",
      problemId
        ? `演练题目导入成功：${problemId}`
        : "演练题目导入成功（响应中未解析到题目 ID）",
    );
  } else {
    record(
      "problem_import",
      "failed",
      `POST /problems/import-bundle 返回 HTTP ${importRes.status}：${
        (await importRes.text()).slice(0, 200)
      }`,
    );
    requiredFailure = true;
  }

  if (problemId) {
    await stepProblemRead(problemId);
    await stepAttachmentDownload(problemId);
    await stepEvaluation(problemId);
  } else {
    await stepProblemRead(null);
  }
  await stepRegisterProbe();
  finish();
}

function finish(): void {
  const passed = !requiredFailure;
  console.log(
    JSON.stringify({
      step: "summary",
      status: passed ? "passed" : "failed",
      passed,
      steps: results,
    }),
  );
  Deno.exit(passed ? 0 : 1);
}

await main();
