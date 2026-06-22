/**
 * noj-tests E2E 测试辅助函数。
 *
 * 管理 Docker Compose 生命周期 + REST API 客户端。
 *
 * 环境变量：
 *   NOJ_RUN_E2E       - 设为 "1" 时启用 E2E 测试
 *   E2E_NO_CLEANUP    - 设为 "1" 时不自动清理容器（调试用）
 *   E2E_BASE_URL      - noj-core 服务地址（默认 http://localhost:8099）
 *   COMPOSE_FILE      - docker-compose.e2e.yml 路径
 *   E2E_ADMIN_EMAIL   - 管理员邮箱
 *   E2E_ADMIN_PASS    - 管理员密码
 */

// ── 配置 ──────────────────────────────────────────

export const isE2E = Deno.env.get("NOJ_RUN_E2E") === "1";
export const noCleanup = Deno.env.get("E2E_NO_CLEANUP") === "1";
export const BASE_URL = Deno.env.get("E2E_BASE_URL") || "http://localhost:8099";
export const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") ||
  "e2e_admin@test.com";
export const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";

const COMPOSE_FILE = Deno.env.get("COMPOSE_FILE") || "../docker-compose.e2e.yml";
const COMPOSE_PROJECT = "noj-e2e";

// ── API 客户端 ────────────────────────────────────

export async function api(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };

  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}

export function apiGet(path: string, token?: string) {
  return api("GET", path, { token });
}

export function apiPost(path: string, body: unknown, token?: string) {
  return api("POST", path, { body, token });
}

export function apiPut(path: string, body: unknown, token?: string) {
  return api("PUT", path, { body, token });
}

// ── 用户辅助 ──────────────────────────────────────

/**
 * 注册用户并返回 token。如果已存在则登录。
 */
export async function registerUser(
  username: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/register", {
    username,
    email,
    password,
  });

  if (res.status !== 201) {
    // 可能已存在，尝试登录
    const loginRes = await apiPost("/api/v1/auth/login", {
      login: email,
      password,
    });
    if (loginRes.status === 200) {
      return (loginRes.body as { data: { token: string } }).data.token;
    }
    throw new Error(
      `注册失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  const loginRes = await apiPost("/api/v1/auth/login", {
    login: email,
    password,
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `注册成功但登录失败: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
    );
  }
  return (loginRes.body as { data: { token: string } }).data.token;
}

/**
 * 提交代码并返回 submission ID。
 */
export async function submitCode(
  token: string,
  problemId: string,
  code: string,
  language = "python3",
): Promise<string> {
  const res = await apiPost(
    "/api/v1/submissions",
    { problem_id: problemId, language, code },
    token,
  );

  if (res.status !== 201) {
    throw new Error(
      `提交失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { id: string } }).data.id;
}

/**
 * 轮询 submission 直到完成或超时。
 */
export async function pollSubmission(
  token: string,
  submissionId: string,
  maxRetries = 60,
  intervalMs = 2000,
): Promise<{ status: string; verdict: string; score: number }> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await apiGet(
      `/api/v1/submissions/${submissionId}`,
      token,
    );

    if (res.status === 200) {
      const data = (res.body as { data: Record<string, unknown> }).data;
      const subStatus = data.status as string;

      if (subStatus === "finished") {
        // API 返回 data.result.status / data.result.score（见 getSubmission）
        const resultData = data.result as Record<string, unknown> | null;
        const verdict = (resultData?.status as string) || "Unknown";
        const score = (resultData?.score as number) || 0;
        return { status: subStatus, verdict, score };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Submission ${submissionId} 超时（${maxRetries * intervalMs}ms 未完成）`,
  );
}

// ── Docker Compose 管理 ───────────────────────────

/**
 * 检查 Docker compose 是否可用。
 */
export async function checkDockerCompose(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["compose", "version"],
    });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}

/**
 * 检查服务是否已在运行（跳过 compose up）。
 */
export async function isStackRunning(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 启动 E2E 评测栈。如果已运行则跳过。
 */
export async function composeUp(): Promise<void> {
  if (await isStackRunning()) {
    console.log("  → 评测栈已在运行，跳过启动");
    return;
  }

  console.log("  → 启动 Docker Compose 评测栈...");
  // 使用 --remove-orphans 处理容器名冲突
  const args = [
    "compose",
    "-f", COMPOSE_FILE,
    "-p", COMPOSE_PROJECT,
    "up", "-d", "--remove-orphans",
  ];

  const cmd = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stderr } = await cmd.output();
  if (!success) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`Docker Compose 启动失败: ${err}`);
  }
  console.log("  ✓ Docker Compose 已启动");
}

/**
 * 停止并清理 E2E 评测栈。
 */
export async function composeDown(): Promise<void> {
  if (noCleanup) {
    console.log("  → E2E_NO_CLEANUP=1，跳过容器清理");
    return;
  }

  console.log("  → 停止 Docker Compose 评测栈...");
  const cmd = new Deno.Command("docker", {
    args: [
      "compose",
      "-f", COMPOSE_FILE,
      "-p", COMPOSE_PROJECT,
      "down", "-v",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stderr } = await cmd.output();
  if (!success) {
    const err = new TextDecoder().decode(stderr);
    console.warn(`  ⚠ Docker Compose 停止警告: ${err}`);
  } else {
    console.log("  ✓ Docker Compose 已停止并清理");
  }
}

/**
 * 等待 noj-core API 就绪。
 */
export async function waitForServer(
  retries = 30,
  intervalMs = 2000,
): Promise<void> {
  console.log(`  → 等待 noj-core API 就绪 (${BASE_URL})...`);
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) {
        console.log(`  ✓ noj-core API 就绪 (${i + 1}/${retries})`);
        return;
      }
    } catch {
      // 未就绪，继续等待
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `noj-core API ${BASE_URL} 未就绪（重试 ${retries} 次）`,
  );
}

// ── 测试代码模板 ──────────────────────────────────

/**
 * 不同评测场景的代码模板。
 *
 * 对应 problem 1001（T0-LMCC 星港舱门报码归一化）：
 * - evaluate.py 接收文本输入，运行 python3 /tmp/main.py <text>
 * - 期望输出 JSON: {"gate_id":"X-YY","status":"open|closed|fault"}
 */
export const CODE_SAMPLES = {
  /** 正确实现：解析舱门报码 */
  accepted: `import json, re, sys

CN_NUM = {"一":"01","二":"02","三":"03","四":"04","五":"05","六":"06","七":"07","八":"08","九":"09","十":"10","十一":"11","十二":"12"}
AREA_MAP = {"东环":"E","东区":"E","东侧":"E","东":"E","西环":"W","西区":"W","西侧":"W","西":"W","北环":"N","北区":"N","北侧":"N","北":"N","南环":"S","南区":"S","南侧":"S","南":"S","主环":"I","内环":"I","内侧":"I","主":"I","内":"I","外环":"O","外侧":"O","外":"O"}
FAULT_KW = ["故障","打不开","拉不开","失灵","卡住","异常","坏了"]
CLOSED_KW = ["关闭","封闭","锁住","关着","暂停通行"]
text = sys.argv[1]
area = next((v for k,v in AREA_MAP.items() if k in text), "E")
num = next((v for k,v in CN_NUM.items() if k in text), "01")
m = re.search(r"(\\d+)", text)
if m: num = f"{int(m.group(1)):02d}"
status = "fault" if any(k in text for k in FAULT_KW) else ("closed" if any(k in text for k in CLOSED_KW) else "open")
print(json.dumps({"gate_id":f"{area}-{num}","status":status}, ensure_ascii=False))`,

  /** 错误实现：总是输出默认值 */
  wrongAnswer: `import json
print(json.dumps({"gate_id":"E-01","status":"open"}, ensure_ascii=False))`,

  /** 死循环，触发 TLE */
  timeLimitExceeded: `import sys
while True:
    pass
print("never reaches here")`,
};
