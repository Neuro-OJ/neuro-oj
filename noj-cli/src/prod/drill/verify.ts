/**
 * 演练的业务验收（T19）：`restore-drill-verify.ts` 的原生移植。
 *
 * ## 与原实现的关键差异（spec §3.3 的裁决）
 *
 * 原实现把 `restore-drill-verify.ts` 挂进一个**额外的 deno 容器**里跑
 * （`restore-drill.sh:288` 固定 `denoland/deno:debian-2.9.5@sha256:…`），
 * 于是演练多了一个镜像依赖。移植后由 **CLI 进程直接发 HTTP**，该镜像依赖消失。
 *
 * 那 CLI 怎么在不映射端口的前提下访问隔离网络里的 core？——**经容器 IP**：
 * 用 `docker compose ps -q core` 取容器 ID，再 `docker inspect` 读它在演练网络里的
 * IP，然后直接请求 `http://<ip>:8000/api/v1`。这样既不需要端口映射（隔离性不受损），
 * 也不需要额外容器。**前提**：CLI 所在主机能直达 docker 网桥地址——这是 Linux
 * 生产环境的常态（演练本就只面向 Linux 生产）。
 *
 * ## 覆盖的验收链路（与原实现逐条对应）
 *
 * 1. `login`（必需）：`POST /auth/login`，Cookie 与 JSON token **双兼容**；
 * 2. `problem_read`（必需）：`GET /problems`（+ 有题目 ID 时读详情）；
 * 3. `problem_import`（非 skip-judge）：`POST /problems/import-bundle` 导入 A+B 演练题；
 * 4. `attachment_download`（非 skip-judge，需题目 ID）：下载支持包并校验 zip 魔数；
 * 5. `evaluation`（非 skip-judge）：提交 A+B 解 + 轮询自测（上限 10 分钟），
 *    要求 `status=finished` 且 `score > 0`；
 * 6. `register_probe`（观察项）：`POST /auth/register`，失败**只记 warning**。
 *
 * **登录失败立即短路**（原实现 `:424-427`）：后续步骤在未认证下必然失败，
 * 继续跑只会产生噪声日志，掩盖真正的首个失败原因。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2）：状态全在一次运行对象里。
 */

import { zipSync } from "fflate";
import {
  DEFAULT_EVALUATOR_IMAGE,
  DEFAULT_SOLUTION_IMAGE,
  DRILL_ADMIN_EMAIL_DOMAIN,
  DRILL_ADMIN_PASSWORD,
  DRILL_ADMIN_USER,
} from "./plan.ts";

/** 单个验收步骤的结论（字段名与原实现逐字一致，报告解析方无需改动）。 */
export interface VerifyStep {
  step: string;
  status: "passed" | "failed" | "warning" | "skipped";
  detail: string;
}

/** 业务验收的汇总结果。 */
export interface VerifyResult {
  passed: boolean;
  steps: VerifyStep[];
  /** 首个必需步骤失败的原因（用于报告与错误传播）。 */
  firstFailure: string | null;
}

/** {@link runBusinessVerification} 的注入点。 */
export interface VerifyOptions {
  /** core 的 API 基址（如 `http://172.29.0.3:8000/api/v1`）。 */
  baseUrl: string;
  /** HTTP 客户端（注入以便在无网络的 CI 里用 fake 全覆盖）。 */
  fetch: typeof fetch;
  /** 管理员账号（缺省为演练固定账号）。 */
  adminUser?: string;
  adminPassword?: string;
  /** 评测镜像名（来自 judge_images 白名单；缺省用兜底名）。 */
  evaluatorImage?: string;
  solutionImage?: string;
  /** 跳过评测相关步骤（`--skip-judge`）。 */
  skipEvaluation?: boolean;
  /** 轮询间隔与上限（测试注入小值）。 */
  pollIntervalMs?: number;
  evaluationTimeoutMs?: number;
  /** 步骤输出的汇聚点（人类日志；缺省丢弃）。 */
  log?: (line: string) => void;
  /** 时间源（测试注入）。 */
  now?: () => number;
  /** 睡眠（测试注入以避免真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 构造演练题目包（`buildDrillBundle` 的等价；改用既有依赖 fflate）。 */
export function buildDrillBundle(
  evaluatorImage: string,
  solutionImage: string,
): Uint8Array {
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
        image: evaluatorImage,
        time_limit_ms: 60000,
        memory_limit_mb: 256,
      },
      solution: {
        image: solutionImage,
        call_timeout_ms: 10000,
        memory_limit_mb: 256,
      },
    },
  };
  return zipSync({
    "problem.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "statement.md": new TextEncoder().encode(
      "# NOJ 恢复演练自测题\n\n实现 solve(input_str) 返回两数之和。\n",
    ),
    "template.py": new TextEncoder().encode(
      "def solve(input_str: str) -> str:\n    ...\n",
    ),
    "evaluate.py": new TextEncoder().encode(evaluatorPy),
    "visible.jsonl": new TextEncoder().encode(
      '{"id":"v001","input":"1 2\\n","expected":3}\n',
    ),
  });
}

/** 一次业务验收运行的内部状态。 */
class Verifier {
  readonly steps: VerifyStep[] = [];
  private authCookie = "";
  private authToken = "";
  private requiredFailure = false;

  constructor(private readonly opts: VerifyOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetch;
  }

  private get base(): string {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  /** 记录一步（与原实现同样的 `{step,status,detail}` 形状）。 */
  record(step: string, status: VerifyStep["status"], detail: string): void {
    this.steps.push({ step, status, detail });
    this.log(JSON.stringify({ step, status, detail }));
  }

  /** 记录一个**必需**步骤；失败即置位短路标记。 */
  required(step: string, ok: boolean, detail: string): void {
    this.record(step, ok ? "passed" : "failed", detail);
    if (!ok) this.requiredFailure = true;
  }

  get failed(): boolean {
    return this.requiredFailure;
  }

  /** 与生产一致的认证凭据；历史 core 直接在 JSON 响应返回 token。 */
  private async api(
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.authCookie) headers.set("Cookie", this.authCookie);
    if (this.authToken) {
      headers.set("Authorization", `Bearer ${this.authToken}`);
    }
    return await this.fetch(`${this.base}${path}`, {
      method,
      ...init,
      headers,
    });
  }

  /** 兼容 Cookie 与 JSON token 两种登录响应（原实现 `captureAuth` 的等价）。 */
  private captureAuth(res: Response, payload: unknown): void {
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/(?:^|[,\s])noj:token=([^;,\s]+)/);
    if (match) {
      this.authToken = match[1]!;
      this.authCookie = `noj:token=${this.authToken}`;
      return;
    }
    const candidate =
      (payload as { data?: { token?: unknown }; token?: unknown })?.data
        ?.token ?? (payload as { token?: unknown })?.token;
    if (typeof candidate === "string" && candidate) this.authToken = candidate;
  }

  /** 登录演练管理员账号（由编排层经 SQL 注入并授予 admin 角色）。 */
  async stepLogin(): Promise<void> {
    const res = await this.api("POST", "/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: this.opts.adminUser ?? DRILL_ADMIN_USER,
        password: this.opts.adminPassword ?? DRILL_ADMIN_PASSWORD,
      }),
    });
    if (res.status !== 200) {
      this.required("login", false, `POST /auth/login 返回 HTTP ${res.status}`);
      return;
    }
    const payload = await res.json();
    this.captureAuth(res, payload);
    const username =
      (payload as { data?: { username?: string } })?.data?.username ??
        this.opts.adminUser ?? DRILL_ADMIN_USER;
    this.required(
      "login",
      Boolean(this.authToken),
      `管理员 ${username} 登录成功并取得认证令牌`,
    );
  }

  /** 题目读取：列表 + （有 ID 时）题目详情。 */
  async stepProblemRead(problemId: string | null): Promise<void> {
    const listRes = await this.api("GET", "/problems");
    if (listRes.status !== 200) {
      this.required(
        "problem_read",
        false,
        `GET /problems 返回 HTTP ${listRes.status}`,
      );
      return;
    }
    const list = await listRes.json();
    const data = (list as { data?: unknown })?.data;
    const total = Array.isArray(data)
      ? data.length
      : typeof (data as { total?: number })?.total === "number"
      ? (data as { total: number }).total
      : 0;
    if (!problemId) {
      this.required(
        "problem_read",
        true,
        `GET /problems 正常返回（当前可见题目数：${total}）`,
      );
      return;
    }
    const detailRes = await this.api("GET", `/problems/${problemId}`);
    this.required(
      "problem_read",
      detailRes.status === 200,
      detailRes.status === 200
        ? `GET /problems 正常（可见题目数：${total}），题目详情 ${problemId} 读取正常`
        : `GET /problems/${problemId} 返回 HTTP ${detailRes.status}`,
    );
  }

  /** 附件下载：经 core 代理从恢复后的对象存储下载支持包。 */
  async stepAttachmentDownload(problemId: string): Promise<void> {
    const res = await this.api("GET", `/problems/${problemId}/support-package`);
    if (res.status !== 200) {
      this.required(
        "attachment_download",
        false,
        `GET /problems/${problemId}/support-package 返回 HTTP ${res.status}`,
      );
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const zipMagic = bytes[0] === 0x50 && bytes[1] === 0x4b;
    this.required(
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
  async stepEvaluation(problemId: string): Promise<void> {
    if (this.opts.skipEvaluation === true) {
      this.record(
        "evaluation",
        "skipped",
        "演练以 --skip-judge 运行，未执行真实评测",
      );
      return;
    }
    const code =
      "def solve(input_str: str) -> str:\n    a, b = map(int, input_str.split())\n    return str(a + b)\n";
    const createRes = await this.api(
      "POST",
      `/problems/${problemId}/self-test`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: "python3",
          code,
          file_name: "main.py",
        }),
      },
    );
    if (createRes.status !== 201) {
      this.required(
        "evaluation",
        false,
        `POST self-test 返回 HTTP ${createRes.status}：${
          (await createRes.text()).slice(0, 200)
        }`,
      );
      return;
    }
    const created = await createRes.json();
    const selfTestId = (created as { data?: { id?: string } })?.data?.id;
    if (!selfTestId) {
      this.required("evaluation", false, "self-test 响应缺少 id");
      return;
    }

    const now = this.opts.now ?? (() => Date.now());
    const sleep = this.opts.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.opts.evaluationTimeoutMs ?? 10 * 60 * 1000);
    let status = "";
    let resultStatus: string | null = null;
    let score: number | null = null;
    while (now() < deadline) {
      await sleep(this.opts.pollIntervalMs ?? 5000);
      const poll = await this.api("GET", `/self-tests/${selfTestId}`);
      if (poll.status !== 200) {
        this.required(
          "evaluation",
          false,
          `GET /self-tests/${selfTestId} 返回 HTTP ${poll.status}`,
        );
        return;
      }
      const body = await poll.json();
      const d = (body as {
        data?: {
          status?: string;
          result_status?: string | null;
          score?: number;
        };
      })?.data;
      status = d?.status ?? "";
      resultStatus = d?.result_status ?? null;
      score = typeof d?.score === "number" ? d.score : null;
      if (status === "finished" || status === "error") break;
    }
    const ok = status === "finished" && resultStatus === "finished" &&
      score !== null && score > 0;
    this.required(
      "evaluation",
      ok,
      ok
        ? `自测 ${selfTestId} 评测成功：status=${status}，得分 ${score}`
        : `自测 ${selfTestId} 未通过：status=${status}，result_status=${resultStatus}，score=${score}`,
    );
  }

  /** 额外观察项：注册链路。受邮件提供方影响，失败只记 warning 不影响结论。 */
  async stepRegisterProbe(): Promise<void> {
    const suffix = (this.opts.now ?? (() => Date.now()))().toString(36);
    const res = await this.api("POST", "/auth/register", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `drill_${suffix}`.slice(0, 30),
        email: `drill-${suffix}@${DRILL_ADMIN_EMAIL_DOMAIN}`,
        password: DRILL_ADMIN_PASSWORD,
        // PIPL 同意硬门槛（2026-09-25 评审）：不带该字段注册恒 400，探针会被永久
        // 降级成 warning，且归因误导为"邮件提供方问题"。
        accepted_legal: true,
      }),
    });
    if (res.status === 201) {
      this.record("register_probe", "passed", "注册接口返回 201");
    } else {
      this.record(
        "register_probe",
        "warning",
        `POST /auth/register 返回 HTTP ${res.status}；注册链路受邮件提供方影响，不计入演练结论`,
      );
    }
  }

  /** 导入演练题目包（admin 权限）：同时验证对象存储写入与数据库写入。 */
  async stepImportBundle(): Promise<string | null> {
    const evaluator = this.opts.evaluatorImage ?? DEFAULT_EVALUATOR_IMAGE;
    const solution = this.opts.solutionImage ?? DEFAULT_SOLUTION_IMAGE;
    const bundle = buildDrillBundle(evaluator, solution);
    const form = new FormData();
    form.append(
      "file",
      new File([bundle as unknown as BlobPart], "noj-drill-bundle.zip", {
        type: "application/zip",
      }),
    );
    const importRes = await this.api("POST", "/problems/import-bundle", {
      body: form,
    });
    if (importRes.status === 200 || importRes.status === 201) {
      const payload = await importRes.json();
      const problemId =
        (payload as { data?: { problem?: { id?: string }; id?: string } })?.data
          ?.problem?.id ??
          (payload as { data?: { id?: string } })?.data?.id ?? null;
      this.record(
        "problem_import",
        "passed",
        problemId
          ? `演练题目导入成功：${problemId}`
          : "演练题目导入成功（响应中未解析到题目 ID）",
      );
      return problemId;
    }
    this.record(
      "problem_import",
      "failed",
      `POST /problems/import-bundle 返回 HTTP ${importRes.status}：${
        (await importRes.text()).slice(0, 200)
      }`,
    );
    this.requiredFailure = true;
    return null;
  }
}

/**
 * 执行完整业务验收（`restore-drill-verify.ts` 的 `main()` 等价）。
 *
 * 流程与短路语义逐条对应原实现：
 * 1. 登录 → 失败即 `finish()`（不再发任何业务请求）；
 * 2. `--skip-judge`：只做题目读取 + 注册探针（不依赖评测镜像白名单）；
 * 3. 否则：导入演练题 → 题目详情 → 附件下载 → 真实评测 → 注册探针。
 */
export async function runBusinessVerification(
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const v = new Verifier(opts);

  await v.stepLogin();
  if (v.failed) {
    return finish(v);
  }

  if (opts.skipEvaluation === true) {
    await v.stepProblemRead(null);
    await v.stepRegisterProbe();
    return finish(v);
  }

  const problemId = await v.stepImportBundle();
  if (problemId) {
    await v.stepProblemRead(problemId);
    await v.stepAttachmentDownload(problemId);
    await v.stepEvaluation(problemId);
  } else {
    await v.stepProblemRead(null);
  }
  await v.stepRegisterProbe();
  return finish(v);
}

/** 汇总（原实现 `finish()` 的等价，但返回结构而非 `Deno.exit`）。 */
function finish(v: Verifier): VerifyResult {
  const passed = !v.failed;
  const firstFailure = v.steps.find((s) => s.status === "failed")?.detail ??
    null;
  v.record(
    "summary",
    passed ? "passed" : "failed",
    passed ? "全部必需步骤通过" : `首个失败：${firstFailure ?? "未知"}`,
  );
  return { passed, steps: v.steps, firstFailure };
}
