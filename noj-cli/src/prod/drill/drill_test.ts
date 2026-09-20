/**
 * T19 演练测试：隔离性、退出码语义、失败也清理、报告与指标契约。
 *
 * 全部注入（runner / fetch / 时间 / 睡眠），**不起容器、不触网**。
 *
 * 本套测试的三条最高价值断言：
 * 1. **隔离性**：compose 覆盖 YAML **不含 `ports:`**（不映射宿主机端口）；
 *    参数含 `--project-name <演练名>`；只改 `noj-net` 的 ipam 子网。
 * 2. **退出码语义（#516 验收）**：RPO/RTO 超限 = 1；资源/参数错误 = **2 且零
 *    compose 调用**——后者是"必须在开始前决出"的可断言形式。
 * 3. **失败也清理**：注入失败 → 断言仍执行 `down -v --remove-orphans`；
 *    `--keep` 时不清理；清理失败**不**掩盖原始错误。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
} from "../../runtime/command.ts";
import { makeTempDir } from "../../testing/helpers.ts";
import {
  allocateDrillDir,
  assertSubnetCidr,
  DEFAULT_DRILL_PROJECT_NAME,
  DRILL_NETWORK_NAME,
  drillCleanupArgs,
  drillComposeArgs,
  drillDirName,
  readEnvValues,
  renderDrillOverride,
  resolveReportPath,
  valueOr,
} from "./plan.ts";
import {
  formatHours,
  hoursSinceSnapshot,
  METRIC_LAST_SUCCESS,
  metricsDirOf,
  renderChecks,
  renderDrillMetrics,
  renderFailureReport,
  renderReport,
  snapshotCreatedAt,
} from "./report.ts";
import { buildDrillBundle, runBusinessVerification } from "./verify.ts";
import { makeIdempotentGlobals, runDrill, tailLines } from "./drill.ts";

/** 一次 compose/命令调用记录。 */
interface Call {
  cmd: string;
  args: string[];
}

/**
 * 记录调用的 fake runner。
 *
 * `failOn` 命中即返回非 0（模拟"某个阶段失败"）；`override` 可给出自定义 stdout
 * （用于 core IP、psql 查询、redis DBSIZE 等需要读取输出的位置）。
 */
function makeRunner(
  calls: Call[],
  opts: {
    failOn?: (args: string[]) => boolean;
    stdoutFor?: (args: string[]) => string | undefined;
    /** 让某类命令**抛 NotFound**（模拟缺 docker）。 */
    throwOn?: (cmd: string, args: string[]) => boolean;
  } = {},
): CommandRunner {
  return {
    run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      if (opts.throwOn?.(cmd, args)) {
        return Promise.reject(new Deno.errors.NotFound(`spawn ${cmd} failed`));
      }
      const code = opts.failOn?.(args) === true ? 1 : 0;
      // `gpg --decrypt --output <dest> <src>`：真实 gpg 会写出文件，
      // fake 必须同样落盘，否则后续 Deno.stat 失败（假失败）。
      if (cmd === "gpg" && code === 0) {
        const outAt = args.indexOf("--output");
        const dest = outAt >= 0 ? args[outAt + 1] : undefined;
        const src = args[args.length - 1];
        if (dest !== undefined && src !== undefined) {
          Deno.writeFileSync(dest, Deno.readFileSync(src));
          Deno.chmodSync(dest, 0o600);
        }
      }
      return Promise.resolve({
        code,
        stdout: opts.stdoutFor?.(args) ?? "",
        stderr: code === 0 ? "" : "injected failure",
      } as CmdResult);
    },
    spawn(): SpawnHandle {
      throw new Error("T19 测试不 spawn");
    },
  };
}

/**
 * 造出可被 drill 消费的最小快照容器。
 *
 * 封装格式（测试专用，长度前缀 ⇒ 二进制安全、无文本解析边界）：
 *   "GPGX" | u32 条目数 | (u32 名长 | 名 | u32 内容长 | 内容)*
 * fake 的 gpgDecrypt 只解密 env.prod.gpg（去掉 GPGX 前缀），untarZst 还原全部条目。
 */
async function makeContainer(root: string): Promise<string> {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "manifest.json": enc.encode(JSON.stringify({
      schema_version: 1,
      payload_layout: "prod-raw",
      created_at: "2026-09-19T10:00:00Z",
      encrypted: true,
      zstd_level: 15,
      files: ["manifest.json", "SUCCESS", "env.prod.gpg", "postgres.dump"],
      postgres_database: "noj",
      retention_days: 30,
    })),
    "SUCCESS": enc.encode("success\n"),
    "env.prod.gpg": enc.encode("NOJ_VERSION=v0.9.5\nPOSTGRES_USER=noj\n"),
    "postgres-globals.sql": enc.encode("-- globals\nCREATE ROLE noj;\n"),
    "postgres.dump": new Uint8Array([0x50, 0x47, 0x44, 0x4d, 0x50, 0x00, 0xff]),
    "redis.rdb": new Uint8Array([0x52, 0x45, 0x44, 0x49, 0x53, 0x00, 0xff]),
    "migration-status.txt": enc.encode("abc:123\n"),
    "minio/pkg.bin": enc.encode("obj"),
    "sha256sums.txt": enc.encode(""),
  };
  const entries = Object.entries(files);
  const chunks: Uint8Array[] = [enc.encode("GPGX")];
  const countBuf = new Uint8Array(4);
  new DataView(countBuf.buffer).setUint32(0, entries.length);
  chunks.push(countBuf);
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const nb = new Uint8Array(4);
    new DataView(nb.buffer).setUint32(0, nameBytes.length);
    const db = new Uint8Array(4);
    new DataView(db.buffer).setUint32(0, data.length);
    chunks.push(nb, nameBytes, db, data);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  const path = join(root, "snapshot-20260919-100000.nojbackup");
  await Deno.writeFile(path, out);
  await Deno.writeTextFile(path + ".sha256", "0".repeat(64) + "  x\n");
  return path;
}

/** 与 {@link makeContainer} 配套的 fake 解包 ops（解析长度前缀格式）。 */
function makeUnpackOps(): {
  gpgDecrypt: (src: string, dest: string, pass: string) => Promise<void>;
  untarZst: (src: string, destDir: string) => Promise<void>;
} {
  const parse = async (src: string): Promise<Record<string, Uint8Array>> => {
    const bytes = await Deno.readFile(src);
    assertEquals(new TextDecoder().decode(bytes.subarray(0, 4)), "GPGX");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 4;
    const count = view.getUint32(at);
    at += 4;
    const out: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint32(at);
      at += 4;
      const name = new TextDecoder().decode(bytes.subarray(at, at + nameLen));
      at += nameLen;
      const dataLen = view.getUint32(at);
      at += 4;
      out[name] = bytes.slice(at, at + dataLen);
      at += dataLen;
    }
    return out;
  };

  return {
    async gpgDecrypt(src, dest) {
      // fake 的"解密"= 恒等拷贝：容器字节本身就是带 GPGX magic 的封装，
      // 由 untarZst 解析。真实 gpg 在此处会把密文变成 tar.zst。
      await Deno.copyFile(src, dest);
    },
    async untarZst(src, destDir) {
      const files = await parse(src);
      for (const [name, data] of Object.entries(files)) {
        const target = join(destDir, name);
        const parent = target.substring(0, target.lastIndexOf("/"));
        if (parent.length > 0) await Deno.mkdir(parent, { recursive: true });
        await Deno.writeFile(target, data);
      }
    },
  };
}

/** 造一个可用的安装目录（.env.prod + compose）。 */
async function makeInstallDir(root: string): Promise<string> {
  const dir = join(root, "install");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, ".env.prod"),
    [
      "POSTGRES_USER=noj",
      "POSTGRES_DB=noj",
      "S3_BUCKET=noj-support-packages",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    join(dir, "docker-compose.prod.yml"),
    "services: {}\n",
  );
  return dir;
}

/** 造一个合法的口令文件（600）。 */
async function makePassphrase(root: string): Promise<string> {
  const path = join(root, "passphrase");
  await Deno.writeTextFile(path, "x".repeat(64));
  await Deno.chmod(path, 0o600);
  return path;
}

/** 业务验收的 fake fetch：按路径返回既定响应。 */
function makeFetch(
  opts: {
    loginStatus?: number;
    problemsStatus?: number;
    detailStatus?: number;
    attachment?: Uint8Array;
    importStatus?: number;
    selfTestCreateStatus?: number;
    selfTestStatuses?: string[];
    registerStatus?: number;
  } = {},
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let pollIndex = 0;
  const handler = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/auth/login")) {
      if ((opts.loginStatus ?? 200) !== 200) {
        return Promise.resolve(
          new Response("nope", { status: opts.loginStatus }),
        );
      }
      return Promise.resolve(
        json({ data: { username: "drill_admin", token: "tok-123" } }, 200),
      );
    }
    if (url.includes("/auth/register")) {
      return Promise.resolve(
        new Response("", { status: opts.registerStatus ?? 201 }),
      );
    }
    if (url.includes("/problems/import-bundle")) {
      if ((opts.importStatus ?? 200) !== 200) {
        return Promise.resolve(
          new Response("bad", { status: opts.importStatus }),
        );
      }
      return Promise.resolve(json({ data: { problem: { id: "p-1" } } }, 200));
    }
    if (url.includes("/support-package")) {
      return Promise.resolve(
        new Response(
          (opts.attachment ?? new Uint8Array([0x50, 0x4b, 1, 2])) as BodyInit,
          { status: 200 },
        ),
      );
    }
    if (url.includes("/self-tests/")) {
      const statuses = opts.selfTestStatuses ?? ["finished"];
      const st = statuses[Math.min(pollIndex, statuses.length - 1)];
      pollIndex++;
      return Promise.resolve(
        json({ data: { status: st, result_status: "finished", score: 100 } }),
      );
    }
    if (url.includes("/self-test")) {
      if ((opts.selfTestCreateStatus ?? 201) !== 201) {
        return Promise.resolve(
          new Response("bad", { status: opts.selfTestCreateStatus }),
        );
      }
      return Promise.resolve(json({ data: { id: "st-1" } }, 201));
    }
    // 题目详情 /problems/<id> 与列表 /problems
    if (/\/problems\/[^/]+$/.test(url)) {
      return Promise.resolve(
        new Response("{}", { status: opts.detailStatus ?? 200 }),
      );
    }
    if (url.endsWith("/problems")) {
      if ((opts.problemsStatus ?? 200) !== 200) {
        return Promise.resolve(
          new Response("bad", { status: opts.problemsStatus }),
        );
      }
      return Promise.resolve(json({ data: [{ id: "p-0" }] }, 200));
    }
    return Promise.resolve(new Response("unknown", { status: 404 }));
  };
  return { fetch: handler as unknown as typeof fetch, calls };
}

/** 跑一次完整成功流程所需的 runner。 */
function successfulRunner(calls: Call[]): CommandRunner {
  return makeRunner(calls, {
    stdoutFor: (args) => {
      const joined = args.join(" ");
      if (joined.includes("SELECT hash")) return "abc:123\n";
      if (joined.includes("SELECT count(*)")) return "5\n";
      if (joined.includes("DBSIZE")) return "7\n";
      if (joined.includes("ps -q")) return "core-container-id\n";
      if (args[0] === "inspect") return "172.29.0.5\n";
      if (joined.includes("mc ls --recursive")) return "3\n";
      if (joined.includes("judge_images") && joined.includes("'evaluator'")) {
        return "noj-evaluator-python:latest\n";
      }
      if (joined.includes("judge_images") && joined.includes("'solution'")) {
        return "noj-solution-python:latest\n";
      }
      if (args[0] === "df") {
        return "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 100000000 1 90000000 1% /\n";
      }
      return undefined;
    },
  });
}

/** 演练的公共入参。 */
async function baseOptions(
  root: string,
  runner: CommandRunner,
  fetchImpl?: typeof fetch,
): Promise<Parameters<typeof runDrill>[0]> {
  const installDir = await makeInstallDir(root);
  const snapshotPath = await makeContainer(root);
  return {
    snapshotPath,
    dir: installDir,
    runner,
    ops: makeUnpackOps(),
    passphraseFile: await makePassphrase(root),
    projectName: "noj-drill",
    drillDir: join(root, "drill-run"),
    report: join(root, "report.txt"),
    metricsDir: join(root, "metrics"),
    now: () => new Date("2026-09-19T12:00:00Z"),
    sleep: () => Promise.resolve(),
    fetch: fetchImpl,
    log: () => {},
  };
}

// ---------------- 隔离性（#516 核心） ----------------

Deno.test("T19 隔离性：覆盖 YAML 不含 ports（不映射宿主机端口），且只改 noj-net ipam", () => {
  const yaml = renderDrillOverride("172.29.0.0/16");
  assertEquals(yaml.includes("ports:"), false, "覆盖文件不得映射任何端口");
  assertStringIncludes(yaml, `networks:\n  ${DRILL_NETWORK_NAME}:\n    ipam:`);
  assertStringIncludes(yaml, "subnet: 172.29.0.0/16");
  // verifier 服务存在且接入演练网络
  assertStringIncludes(yaml, "services:\n  verifier:");
});

Deno.test("T19 隔离性：compose 参数含 --project-name，且 profile 在子命令之前", () => {
  const args = drillComposeArgs({
    projectName: "noj-drill",
    composeEnvFile: "/t/env.drill",
    composeFile: "/t/docker-compose.prod.yml",
    overrideFile: "/t/override.yml",
    judge: true,
    command: ["up", "-d"],
  });
  assertEquals(args.slice(0, 3), ["compose", "--project-name", "noj-drill"]);
  const profile = args.indexOf("--profile");
  const sub = args.indexOf("up");
  assert(profile > 0 && profile < sub, "profile 必须在子命令之前");
  // 两个 -f：生产 compose + 演练覆盖（不改生产文件）
  assertEquals(args.filter((a) => a === "--file").length, 2);
});

Deno.test("T19 清理参数：down -v --remove-orphans（隔离卷必须删）", () => {
  const args = drillCleanupArgs({
    projectName: "noj-drill",
    composeEnvFile: "/t/env.drill",
    composeFile: "/t/compose.yml",
    overrideFile: "/t/override.yml",
  });
  assertStringIncludes(args.join(" "), "down -v --remove-orphans");
  assertEquals(args.slice(0, 3), ["compose", "--project-name", "noj-drill"]);
  // 覆盖文件已删时不应再传它（bash on_exit 的同一判定）
  const noOverride = drillCleanupArgs({
    projectName: "noj-drill",
    composeEnvFile: "/t/env.drill",
    composeFile: "/t/compose.yml",
  });
  assertEquals(noOverride.filter((a) => a === "--file").length, 1);
});

Deno.test("T19 项目名/子网：复用既有校验（含 prod 拒绝与主机位判定）", () => {
  assertSubnetCidr("172.29.0.0/16");
  for (const bad of ["999.1.1.1/16", "172.29.1.1/16", "172.29.0.0/31"]) {
    let msg = "";
    try {
      assertSubnetCidr(bad);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg !== "", `必须拒绝：${bad}`);
  }
  assertEquals(DEFAULT_DRILL_PROJECT_NAME, "noj-drill");
});

// ---------------- 退出码语义 ----------------

Deno.test("T19 退出码 0：完整成功流程（报告 + 指标 + 清理）", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const opts = await baseOptions(root, successfulRunner(calls), fetch);
    const result = await runDrill(opts);

    assertEquals(result.exitCode, 0, result.message);
    assertEquals(result.pass, true);
    assertEquals(result.failedStage, null);
    assertEquals(result.reportPath, join(root, "report.txt"));
    // 报告字段与 bash 逐字对应
    const report = await Deno.readTextFile(join(root, "report.txt"));
    assertStringIncludes(report, "result=passed\n");
    assertStringIncludes(
      report,
      "drill_type=isolated-restore-with-business-verification\n",
    );
    assertStringIncludes(report, "compose_project=noj-drill\n");
    assertStringIncludes(report, "network_subnet=172.29.0.0/16\n");
    assertStringIncludes(report, "rpo_met=true\n");
    assertStringIncludes(report, "rto_met=true\n");
    assertStringIncludes(report, "restore_data_check=passed\n");
    assertStringIncludes(report, "cleanup=done\n");
    assertStringIncludes(report, "credential_note=");
    assertEquals(
      ((await Deno.stat(join(root, "report.txt"))).mode ?? 0) & 0o777,
      0o600,
    );

    // 指标：名字逐字 + 仅成功时写
    const metrics = await Deno.readTextFile(
      join(root, "metrics", "noj_restore_drill.prom"),
    );
    assertStringIncludes(metrics, `# TYPE ${METRIC_LAST_SUCCESS} gauge`);
    assertStringIncludes(metrics, `${METRIC_LAST_SUCCESS} 1789819200`);

    // 清理执行了 down -v，且演练目录被删
    assert(
      calls.some((c) => c.args.join(" ").includes("down -v --remove-orphans")),
      "成功路径也必须清理演练资源",
    );
    let dirExists = true;
    try {
      await Deno.stat(join(root, "drill-run"));
    } catch {
      dirExists = false;
    }
    assertEquals(dirExists, false, "成功路径默认删除演练目录");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 退出码 1：RPO 超限（快照过旧）→ 失败且不刷新指标", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const opts = await baseOptions(root, successfulRunner(calls), fetch);
    // 快照 created_at 是 2026-09-19T10:00:00Z，now 设为其后 100 小时
    const result = await runDrill({
      ...opts,
      now: () => new Date("2026-09-23T14:00:00Z"),
      rpoMaxHours: 24,
    });

    assertEquals(result.exitCode, 1, result.message);
    assertEquals(result.pass, false);
    assertEquals(result.failedStage, "rpo-rto");
    const report = await Deno.readTextFile(join(root, "report.txt"));
    assertStringIncludes(report, "result=passed_with_warnings\n");
    assertStringIncludes(report, "rpo_met=false\n");
    // 指标**不得**被刷新（否则告警失去意义）
    let metricsExist = true;
    try {
      await Deno.stat(join(root, "metrics", "noj_restore_drill.prom"));
    } catch {
      metricsExist = false;
    }
    assertEquals(metricsExist, false, "RPO 未达标时不得刷新成功指标");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 退出码 2：docker 不可用 → 零 compose 调用、不写报告", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const installDir = await makeInstallDir(root);
    const snapshotPath = await makeContainer(root);
    const result = await runDrill({
      snapshotPath,
      dir: installDir,
      runner: makeRunner(calls, {
        // docker info 抛 NotFound（真实缺二进制的情形）
        throwOn: (cmd) => cmd === "docker",
      }),
      ops: makeUnpackOps(),
      passphraseFile: await makePassphrase(root),
      drillDir: join(root, "drill-run"),
      report: join(root, "report.txt"),
      now: () => new Date("2026-09-19T12:00:00Z"),
      log: () => {},
    });

    assertEquals(result.exitCode, 2, result.message);
    assertEquals(result.failedStage, "preflight");
    assertEquals(result.reportPath, null, "preflight 失败不写报告");
    // **零 compose 调用**（docker info 探测不算 compose）
    assertEquals(
      calls.filter((c) => c.args.includes("compose")).length,
      0,
      "资源前置失败必须零 compose 调用",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 退出码 2：项目名含 prod → 拒绝且零 compose 调用", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const opts = await baseOptions(root, successfulRunner(calls), fetch);
    const result = await runDrill({ ...opts, projectName: "noj-prod-drill" });

    assertEquals(result.exitCode, 2);
    assertStringIncludes(result.message, "prod");
    assertEquals(calls.filter((c) => c.args.includes("compose")).length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 退出码 2：缺口令文件 / 口令权限过宽 / 非法 RPO", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const opts = await baseOptions(root, successfulRunner(calls), fetch);

    // 缺口令
    const noPass = await runDrill({ ...opts, passphraseFile: undefined });
    assertEquals(noPass.exitCode, 2);
    assertStringIncludes(noPass.message, "passphrase-file");

    // 权限过宽（644）
    const wide = join(root, "wide-passphrase");
    await Deno.writeTextFile(wide, "x".repeat(64));
    await Deno.chmod(wide, 0o644);
    const wideResult = await runDrill({ ...opts, passphraseFile: wide });
    assertEquals(wideResult.exitCode, 2);
    assertStringIncludes(wideResult.message, "600 或 400");

    // 非法 RPO
    const badRpo = await runDrill({ ...opts, rpoMaxHours: -1 });
    assertEquals(badRpo.exitCode, 2);
    assertStringIncludes(badRpo.message, "非负整数");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 失败也清理 ----------------

Deno.test("T19 失败也清理：恢复阶段失败 → 仍执行 down -v，且报告记录失败阶段", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const base = await baseOptions(root, makeRunner(calls), fetch);
    // 让 pg_restore 失败（恢复数据阶段）
    const runner = makeRunner(calls, {
      failOn: (args) => args.join(" ").includes("pg_restore"),
      stdoutFor: (args) => {
        if (args[0] === "df") return "/dev/sda1 100000000 1 90000000 1% /\n";
        if (args.join(" ").includes("SELECT hash")) return "abc:123\n";
        return undefined;
      },
    });
    const result = await runDrill({ ...base, runner });

    assertEquals(result.exitCode, 1);
    assertEquals(result.failedStage, "business-verify");
    assertStringIncludes(result.message, "PostgreSQL 数据恢复失败");
    // 失败路径**必须**清理
    assert(
      calls.some((c) => c.args.join(" ").includes("down -v --remove-orphans")),
      "失败路径必须清理演练资源",
    );
    const report = await Deno.readTextFile(join(root, "report.txt"));
    assertStringIncludes(report, "result=failed\n");
    assertStringIncludes(report, "cleanup=done\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 --keep：失败时**不**清理资源与目录", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const base = await baseOptions(root, makeRunner(calls), fetch);
    const runner = makeRunner(calls, {
      failOn: (args) => args.join(" ").includes("pg_restore"),
      stdoutFor: (args) =>
        args[0] === "df" ? "/dev/sda1 100000000 1 90000000 1% /\n" : undefined,
    });
    const result = await runDrill({ ...base, runner, keep: true });

    assertEquals(result.exitCode, 1);
    assertEquals(
      calls.some((c) => c.args.join(" ").includes("down -v")),
      false,
      "--keep 时不得清理 Compose 资源",
    );
    const report = await Deno.readTextFile(join(root, "report.txt"));
    assertStringIncludes(report, "cleanup=kept-for-review\n");
    // 演练目录保留
    assert((await Deno.stat(join(root, "drill-run"))).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 清理失败不掩盖原始错误（原始原因仍是 message 主体）", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const base = await baseOptions(root, makeRunner(calls), fetch);
    const runner = makeRunner(calls, {
      // pg_restore 失败（原始错误）+ down 也失败（清理问题）
      failOn: (args) => {
        const j = args.join(" ");
        return j.includes("pg_restore") || j.includes("down -v");
      },
      stdoutFor: (args) =>
        args[0] === "df" ? "/dev/sda1 100000000 1 90000000 1% /\n" : undefined,
    });
    const result = await runDrill({ ...base, runner });

    assertEquals(result.exitCode, 1, "清理失败不改变退出码");
    // 原始错误在 message 主体
    assertStringIncludes(result.message, "PostgreSQL 数据恢复失败");
    // 清理问题作为附加信息
    assertStringIncludes(result.message, "清理演练 Compose 资源失败");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 形态反转与数据核对 ----------------

Deno.test("T19 形态反转：.nojbackup 被接受；目录形态被拒绝（2）", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const opts = await baseOptions(root, successfulRunner(calls), fetch);

    // 单文件 → 成功
    const ok = await runDrill(opts);
    assertEquals(ok.exitCode, 0, ok.message);

    // 目录形态 → 参数阶段拒绝（退出码 2）
    const asDir = join(root, "snapshot-20260101-000000");
    await Deno.mkdir(asDir, { recursive: true });
    const bad = await runDrill({
      ...opts,
      snapshotPath: asDir,
      drillDir: join(root, "d2"),
      report: join(root, "r2.txt"),
    });
    assertEquals(bad.exitCode, 2);
    assertStringIncludes(bad.message, "只接受 .nojbackup 单文件快照");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 数据核对：迁移版本与快照不一致 → 失败（1）", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const base = await baseOptions(root, makeRunner(calls), fetch);
    const runner = makeRunner(calls, {
      stdoutFor: (args) => {
        const j = args.join(" ");
        if (j.includes("SELECT hash")) return "DIFFERENT:999\n";
        if (j.includes("SELECT count(*)")) return "5\n";
        if (j.includes("DBSIZE")) return "7\n";
        if (j.includes("ps -q")) return "core-container-id\n";
        if (args[0] === "inspect") return "172.29.0.5\n";
        if (j.includes("mc ls --recursive")) return "3\n";
        if (args[0] === "df") return "/dev/sda1 100000000 1 90000000 1% /\n";
        return undefined;
      },
    });
    const result = await runDrill({ ...base, runner });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.message, "迁移版本与快照不一致");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 数据核对：MinIO 对象数少于快照 → 失败（1）", async () => {
  const root = await makeTempDir();
  try {
    const calls: Call[] = [];
    const { fetch } = makeFetch();
    const base = await baseOptions(root, makeRunner(calls), fetch);
    const runner = makeRunner(calls, {
      stdoutFor: (args) => {
        const j = args.join(" ");
        if (j.includes("SELECT hash")) return "abc:123\n";
        if (j.includes("SELECT count(*)")) return "5\n";
        if (j.includes("DBSIZE")) return "7\n";
        if (j.includes("ps -q")) return "core-container-id\n";
        if (args[0] === "inspect") return "172.29.0.5\n";
        // 快照内有 1 个对象，恢复后报 0 → 必须失败
        if (j.includes("mc ls --recursive")) return "0\n";
        if (args[0] === "df") return "/dev/sda1 100000000 1 90000000 1% /\n";
        return undefined;
      },
    });
    const result = await runDrill({ ...base, runner });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.message, "MinIO 对象数少于快照");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------- 业务验收（原生 HTTP） ----------------

Deno.test("T19 业务验收：登录失败 → 立即短路（不再发题目请求）", async () => {
  const { fetch, calls } = makeFetch({ loginStatus: 401 });
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch,
  });
  assertEquals(result.passed, false);
  assertEquals(result.steps.map((s) => s.step), ["login", "summary"]);
  assertEquals(
    calls.some((c) => c.includes("/problems")),
    false,
    "登录失败后不得再发业务请求",
  );
  assertStringIncludes(result.firstFailure ?? "", "HTTP 401");
});

Deno.test("T19 业务验收：完整链路通过（导入/详情/附件/评测/注册）", async () => {
  const { fetch } = makeFetch();
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch,
    sleep: () => Promise.resolve(),
  });
  assertEquals(result.passed, true, result.firstFailure ?? "");
  const steps = result.steps.map((s) => s.step);
  assertEquals(steps, [
    "login",
    "problem_import",
    "problem_read",
    "attachment_download",
    "evaluation",
    "register_probe",
    "summary",
  ]);
  assertEquals(
    result.steps.find((s) => s.step === "register_probe")?.status,
    "passed",
  );
});

Deno.test("T19 业务验收：--skip-judge 时不导入题目、评测记为 skipped", async () => {
  const { fetch, calls } = makeFetch();
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch,
    skipEvaluation: true,
  });
  assertEquals(result.passed, true, result.firstFailure ?? "");
  assertEquals(
    calls.some((c) => c.includes("import-bundle")),
    false,
    "--skip-judge 时不得导入题目",
  );
  assertEquals(
    result.steps.some((s) => s.step === "evaluation"),
    false,
    "--skip-judge 时不做评测（连 skipped 都不需要，因为没有题目）",
  );
});

Deno.test("T19 业务验收：评测分数为 0 → 失败（1）", async () => {
  const { fetch } = makeFetch();
  // 让轮询返回 score=0 的响应：复用 handler 但覆盖 /self-tests/ 分支
  const zeroScore: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.includes("/self-tests/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { status: "finished", result_status: "finished", score: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return fetch(input as RequestInfo, init);
  };
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch: zeroScore,
    sleep: () => Promise.resolve(),
  });
  assertEquals(result.passed, false);
  const evaluation = result.steps.find((s) => s.step === "evaluation");
  assertEquals(evaluation?.status, "failed");
  assertStringIncludes(evaluation?.detail ?? "", "score=0");
});

Deno.test("T19 业务验收：注册失败只记 warning，不影响结论", async () => {
  const { fetch } = makeFetch({ registerStatus: 403 });
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch,
    skipEvaluation: true,
  });
  assertEquals(result.passed, true, "注册是观察项，不应影响结论");
  const probe = result.steps.find((s) => s.step === "register_probe");
  assertEquals(probe?.status, "warning");
});

Deno.test("T19 业务验收：Cookie 与 JSON token 双兼容", async () => {
  // 只给 Set-Cookie，不给 JSON token
  const cookieOnly: typeof fetch = (input) => {
    const url = String(input);
    if (url.includes("/auth/login")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { username: "drill_admin" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "noj:token=cookie-token-xyz; Path=/; HttpOnly",
          },
        }),
      );
    }
    if (url.endsWith("/problems")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/auth/register")) {
      return Promise.resolve(new Response("", { status: 201 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const result = await runBusinessVerification({
    baseUrl: "http://core:8000/api/v1",
    fetch: cookieOnly,
    skipEvaluation: true,
  });
  assertEquals(result.passed, true, result.firstFailure ?? "");
  assertEquals(result.steps.find((s) => s.step === "login")?.status, "passed");
});

Deno.test("T19 buildDrillBundle：产出可被 zip 解析的包（含 evaluator/template）", async () => {
  const { unzipSync } = await import("fflate");
  const bytes = buildDrillBundle("eval-img:1", "sol-img:1");
  const files = unzipSync(bytes);
  const names = Object.keys(files).sort();
  assertEquals(names, [
    "evaluate.py",
    "problem.json",
    "statement.md",
    "template.py",
    "visible.jsonl",
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(files["problem.json"]!));
  assertEquals(manifest.runtime_config.evaluator.image, "eval-img:1");
  assertEquals(manifest.runtime_config.solution.image, "sol-img:1");
  assertEquals(manifest.type, "P");
});

// ---------------- 报告与指标（纯函数） ----------------

Deno.test("T19 报告：字段名与 bash 逐字一致", () => {
  const text = renderReport({
    result: "passed",
    snapshot: "/t/snap.nojbackup",
    snapshotCreatedAt: "2026-09-19T10:00:00Z",
    drillStartedAt: "2026-09-19T12:00:00Z",
    drillFinishedAt: "2026-09-19T12:05:00Z",
    restoreDurationSeconds: 120,
    totalDurationSeconds: 300,
    rpoHours: "2.00",
    rpoTargetHours: 24,
    rpoMet: true,
    rtoMinutes: 5,
    rtoTargetMinutes: 60,
    rtoMet: true,
    composeProject: "noj-drill",
    networkSubnet: "172.29.0.0/16",
    checks: renderChecks({
      restoredUserCount: 5,
      restoredRedisKeys: 7,
      snapshotObjectCount: 1,
      restoredObjectCount: 1,
    }),
    verifyLog: '{"step":"login","status":"passed"}',
    cleanup: "done",
  });
  for (
    const field of [
      "result=",
      "drill_type=",
      "snapshot=",
      "snapshot_created_at=",
      "drill_started_at=",
      "drill_finished_at=",
      "restore_duration_seconds=",
      "total_duration_seconds=",
      "rpo_hours=",
      "rpo_target_hours=",
      "rpo_met=",
      "rto_minutes=",
      "rto_target_minutes=",
      "rto_met=",
      "compose_project=",
      "network_subnet=",
      "restore_data_check=passed",
      "restored_user_count=",
      "restored_redis_keys=",
      "snapshot_object_count=",
      "restored_object_count=",
      "# ---- 业务验收明细 ----",
      "cleanup=",
      "credential_note=",
    ]
  ) {
    assertStringIncludes(text, field);
  }
});

Deno.test("T19 失败报告：有 failed_stage，无 RPO/RTO 字段（避免误读为跑完）", () => {
  const text = renderFailureReport({
    snapshot: "/t/snap.nojbackup",
    failedStage: "business-verify",
    drillStartedAt: "2026-09-19T12:00:00Z",
    composeProject: "noj-drill",
    verifyLogTail: "line1\nline2",
    cleanup: "done",
  });
  assertStringIncludes(text, "result=failed\n");
  assertStringIncludes(text, "failed_stage=business-verify\n");
  assertEquals(text.includes("rpo_hours="), false);
  assertEquals(text.includes("rto_minutes="), false);
  assertStringIncludes(text, "# ---- 业务验收输出（失败现场） ----");
});

Deno.test("T19 指标：名字逐字保持契约（含 HELP/TYPE），且仅成功时渲染", () => {
  const text = renderDrillMetrics(1789819200);
  assertEquals(
    text,
    "# HELP noj_restore_drill_last_success_unix_time 最近一次隔离恢复演练成功的 Unix 时间戳。\n" +
      "# TYPE noj_restore_drill_last_success_unix_time gauge\n" +
      "noj_restore_drill_last_success_unix_time 1789819200\n",
  );
  // 名字必须与告警文件引用的一致（逐字）
  assertEquals(METRIC_LAST_SUCCESS, "noj_restore_drill_last_success_unix_time");
});

Deno.test("T19 时间：缺失/不可解析的时间戳 ⇒ RPO 必然不达标（inf）", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  assertEquals(hoursSinceSnapshot("2026-09-19T10:00:00Z", now), 2);
  assertEquals(hoursSinceSnapshot("", now), Number.POSITIVE_INFINITY);
  assertEquals(hoursSinceSnapshot("not-a-date", now), Number.POSITIVE_INFINITY);
  assertEquals(formatHours(2), "2.00");
  assertEquals(formatHours(Number.POSITIVE_INFINITY), "inf");
  assertEquals(
    snapshotCreatedAt('{"created_at":"2026-09-19T10:00:00Z"}'),
    "2026-09-19T10:00:00Z",
  );
  assertEquals(snapshotCreatedAt("{}"), "");
  assertEquals(snapshotCreatedAt("not json"), "");
});

Deno.test("T19 路径与目录：报告落点、演练目录、指标目录", async () => {
  const root = await makeTempDir();
  try {
    // 单文件快照：报告写到**所在目录**（不是把文件当目录拼路径）
    assertEquals(
      resolveReportPath("/t/snap.nojbackup"),
      "/t/restore-drill-report.txt",
    );
    assertEquals(
      resolveReportPath("/t/snap.nojbackup", "/x/r.txt"),
      "/x/r.txt",
    );
    assertEquals(metricsDirOf("/t/snap.nojbackup", undefined), "/t/metrics");

    // 演练目录：默认快照同级 + 冲突加序号
    const snap = join(root, "snapshot-1.nojbackup");
    await Deno.writeFile(snap, new Uint8Array());
    const first = await allocateDrillDir(
      snap,
      new Date("2026-09-19T12:00:00Z"),
    );
    assertStringIncludes(first, "drill-20260919-120000");
    await Deno.mkdir(first, { recursive: true });
    const second = await allocateDrillDir(
      snap,
      new Date("2026-09-19T12:00:00Z"),
    );
    assertStringIncludes(second, "drill-20260919-120000-1");

    // 显式目录已存在 → 拒绝
    await assertRejects(
      () => allocateDrillDir(snap, new Date(), first),
      Error,
      "演练目录已存在",
    );
    assertEquals(
      drillDirName(new Date("2026-09-19T12:34:56Z")),
      "drill-20260919-123456",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 makeIdempotentGlobals：CREATE ROLE 改写为幂等 DO 块", async () => {
  const root = await makeTempDir();
  try {
    const src = join(root, "globals.sql");
    const dst = join(root, "out.sql");
    await Deno.writeTextFile(
      src,
      'CREATE ROLE noj;\nCREATE ROLE "quoted role";\nGRANT x TO noj;\n',
    );
    assertEquals(await makeIdempotentGlobals(src, dst), 0);
    const out = await Deno.readTextFile(dst);
    assertStringIncludes(out, "DO $role$ BEGIN IF NOT EXISTS");
    assertStringIncludes(out, "rolname = 'noj'");
    assertStringIncludes(out, "rolname = 'quoted role'");
    assertStringIncludes(out, 'CREATE ROLE "quoted role";');
    // 非 CREATE ROLE 行原样保留
    assertStringIncludes(out, "GRANT x TO noj;");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("T19 readEnvValues/valueOr/tailLines：解析与兜底", async () => {
  const root = await makeTempDir();
  try {
    const env = join(root, ".env.prod");
    await Deno.writeTextFile(env, 'POSTGRES_USER=pguser\nS3_BUCKET="bkt"\n');
    const values = await readEnvValues(env);
    assertEquals(values["POSTGRES_USER"], "pguser");
    assertEquals(values["S3_BUCKET"], "bkt");
    assertEquals(valueOr(values, "POSTGRES_USER", "noj"), "pguser");
    assertEquals(valueOr(values, "MISSING", "fallback"), "fallback");
    assertEquals(valueOr({ K: "" }, "K", "def"), "def");
    // 缺文件 → 空表（bash env_value 同样不报错）
    assertEquals(await readEnvValues(join(root, "nope")), {});

    assertEquals(tailLines("a\nb\nc\nd", 2), "c\nd");
    assertEquals(tailLines("only", 5), "only");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── 评审发现（Important）：恢复路径上两处 compose 退出码被丢弃 ────────
//
// bash 对 drill 的每一步都是 `|| die`；而 `run --rm minio-init`
// 与 `run --rm migrate` 此前**丢弃返回值**，于是失败会表现为后续某个更难懂的
// 错误（"隔离 core 启动失败"、"数据核对失败"），把根因埋掉。

Deno.test("评审: minio-init 失败必须显式报错（行为断言，不埋根因）", async () => {
  // 行为断言而非源码文本匹配：注入 runner 让 `run --rm minio-init` 失败，
  // 断言最终错误**点名 minio-init**。修复前该退出码被丢弃，错误会变成
  // 后面某个更难懂的现象，运维者无法定位。
  const root = await Deno.makeTempDir();
  try {
    const calls: Call[] = [];
    const runner = makeRunner(calls, {
      // **只命中 `run --rm minio-init`**（初始化），不要误伤后面那条
      // `mc mirror`（它的 args 里也含 "minio-init"，但它自己已检查退出码）。
      // 我第一版就是这样写的：`includes("minio-init")` 命中了 `mc mirror`，
      // 于是演练在更早处失败、本用例**恒真**——移除修复也照样通过。
      failOn: (args) =>
        args.includes("run") && args.includes("--rm") &&
        args.includes("minio-init") && !args.includes("-c"),
    });
    const result = await runDrill(await baseOptions(root, runner));
    console.log(
      "DBG minio:",
      JSON.stringify({ code: result.exitCode, msg: result.message }),
    );
    assertEquals(result.exitCode, 1, "minio-init 失败应使演练失败");
    assert(
      result.message.includes("MinIO") || result.message.includes("minio-init"),
      `失败信息应点名 minio-init，实得：${result.message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
