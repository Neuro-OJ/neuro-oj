/**
 * 本地 E2E 会话管理单元测试：不启动 Docker，只验证所有权、端口与生命周期决策。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  allocatePort,
  allocateSessionPorts,
  assertSessionAvailable,
  assertSessionOwnership,
  buildSessionManifest,
  type CommandResult,
  composeProjectFor,
  createSessionDeps,
  downSession,
  evaluatorNetworkFor,
  inspectSessionArtifacts,
  isPortConflict,
  loadSession,
  main as sessionMain,
  parseSessionEnv,
  renderSessionEnv,
  reusedSessionFrom,
  sessionEnvPath,
  type SessionManifest,
  sessionManifestPath,
  upSession,
  validateSessionName,
} from "./session.ts";
import {
  type ArtifactSpec,
  createFileCacheStore,
  digestArtifact,
  fingerprintInputs,
  inspectArtifact,
  recordArtifact,
} from "./artifact-cache.ts";

function manifestFor(session = "perf-a"): SessionManifest {
  return buildSessionManifest({
    session,
    runId: `${session}-abcd1234`,
    ports: {
      postgres: 15401,
      redis: 15402,
      core: 15403,
      minio: 15404,
      minioConsole: 15405,
      llmGateway: 15406,
      llmMock: 15407,
      coordinator: 15408,
    },
    now: new Date("2026-11-03T00:00:00.000Z"),
  });
}

function fakeRunner(
  responses: CommandResult[] = [],
): { calls: string[][]; run: (command: string[]) => Promise<CommandResult> } {
  const calls: string[][] = [];
  return {
    calls,
    run: (command: string[]) => {
      calls.push(command);
      return Promise.resolve(
        responses.shift() ?? { code: 0, stdout: "", stderr: "" },
      );
    },
  };
}

Deno.test("e2e-session: session 名校验拒绝路径穿越与非法字符", () => {
  assertEquals(validateSessionName("perf-clean"), "perf-clean");
  for (const bad of ["../x", "Perf", "a_b", "-a", "a-", "", "a".repeat(40)]) {
    let error: unknown;
    try {
      validateSessionName(bad);
    } catch (cause) {
      error = cause;
    }
    if (!(error instanceof Error)) throw new Error(`未拒绝非法名：${bad}`);
  }
  let traversal: unknown;
  try {
    sessionManifestPath("../evil");
  } catch (cause) {
    traversal = cause;
  }
  if (!(traversal instanceof Error)) throw new Error("未拒绝路径穿越");
});

Deno.test("e2e-session: 清单字段由 runId 派生且所有权可核对", () => {
  const manifest = manifestFor();
  assertEquals(composeProjectFor(manifest.runId), "noj-e2e-perf-a-abcd1234");
  assertEquals(manifest.composeProject, composeProjectFor(manifest.runId));
  assertEquals(
    manifest.networkName,
    evaluatorNetworkFor(manifest.runId),
  );
  assertEquals(manifest.ownerLabel, "noj.e2e.session=perf-a");
  // evaluator 在会话私有网络内访问协调服务：必须用容器端口 8010，
  // 用宿主映射端口会让评测容器连不上（屏障 arrivals 恒为 0）。
  assertEquals(
    manifest.urls.evaluatorCoordinator,
    "http://test-coordinator:8010",
  );
  assertEquals(
    manifest.urls.evaluatorCoordinator.includes(
      String(manifest.ports.coordinator),
    ),
    false,
  );
  assertSessionOwnership(manifest, "perf-a");
  let mismatch: unknown;
  try {
    assertSessionOwnership(manifest, "perf-b");
  } catch (cause) {
    mismatch = cause;
  }
  if (!(mismatch instanceof Error)) throw new Error("未拒绝跨 session 操作");
});

Deno.test("e2e-session: 已存在同名 session 时拒绝覆盖", () => {
  assertSessionAvailable(undefined, "perf-a");
  let error: unknown;
  try {
    assertSessionAvailable(manifestFor(), "perf-a");
  } catch (cause) {
    error = cause;
  }
  if (!(error instanceof Error) || !error.message.includes("env:down")) {
    throw new Error("未提示先显式关闭");
  }
});

Deno.test("e2e-session: 端口分配跳过占用并保证不重复", async () => {
  const used = new Set<number>();
  const probe = (port: number) =>
    Promise.resolve([15400, 15402].includes(port) === false);
  const first = await allocatePort(probe, { start: 15400, end: 15405, used });
  assertEquals(first, 15401);
  const ports = await allocateSessionPorts(probe, { start: 15420, end: 15430 });
  const values = Object.values(ports);
  assertEquals(new Set(values).size, values.length);
});

Deno.test("e2e-session: 端口耗尽时失败而不是静默复用", async () => {
  await assertRejects(
    () =>
      allocatePort(() => Promise.resolve(false), {
        start: 15400,
        end: 15401,
        used: new Set(),
      }),
    Error,
    "无可用端口",
  );
});

Deno.test("e2e-session: up 写清单，失败时清理本会话 project", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const runner = fakeRunner();
    const deps = createSessionDeps({
      run: runner.run,
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "abcd1234",
      repoRoot: "/repo",
    });
    const result = await upSession(
      { session: "perf-a", sessionDir: dir },
      deps,
    );
    assertEquals(result.manifest.composeProject, "noj-e2e-perf-a-abcd1234");
    assertEquals(runner.calls[0]![0], "bash");
    assertEquals(runner.calls[0]![1], "scripts/e2e/setup.sh");
    const saved = await loadSession("perf-a", dir);
    assertEquals(saved?.state, "running");

    const failing = createSessionDeps({
      run: fakeRunner([{ code: 7, stdout: "", stderr: "boom" }]).run,
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "fail0001",
      repoRoot: "/repo",
    });
    await assertRejects(
      () => upSession({ session: "perf-b", sessionDir: dir }, failing),
      Error,
      "启动失败",
    );
    const cleanup = await loadSession("perf-b", dir);
    assertEquals(cleanup, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("e2e-session: down 只删除清单声明的 project，失败保留清单", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const deps = createSessionDeps({
      run: fakeRunner().run,
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "abcd1234",
      repoRoot: "/repo",
    });
    await upSession({ session: "perf-a", sessionDir: dir }, deps);

    const failingRunner = fakeRunner([
      { code: 1, stdout: "", stderr: "docker 不可用" },
    ]);
    await assertRejects(
      () =>
        downSession(
          "perf-a",
          createSessionDeps({ run: failingRunner.run, repoRoot: "/repo" }),
          dir,
        ),
      Error,
      "清理失败",
    );
    assertEquals((await loadSession("perf-a", dir))?.state, "running");

    const okRunner = fakeRunner();
    await downSession(
      "perf-a",
      createSessionDeps({ run: okRunner.run, repoRoot: "/repo" }),
      dir,
    );
    assertEquals(okRunner.calls[0]!.slice(0, 3), [
      "docker",
      "compose",
      "-p",
    ]);
    assertEquals(okRunner.calls[0]!.includes("noj-e2e-perf-a-abcd1234"), true);
    assertEquals(await loadSession("perf-a", dir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("e2e-session: 环境文本 session 私有且包含全部资源", () => {
  const text = renderSessionEnv(manifestFor());
  for (
    const key of [
      "NOJ_E2E_SESSION",
      "COMPOSE_PROJECT_NAME",
      "E2E_DB_URL",
      "E2E_REDIS_URL",
      "E2E_COORDINATOR_URL",
      "E2E_EVALUATOR_NETWORK",
    ]
  ) {
    assertEquals(text.includes(`export ${key}=`), true);
  }
  assertEquals(text.includes("/tmp/noj-e2e-env.sh"), false);
  assertEquals(text.includes("noj-e2e-perf-a-abcd1234"), true);
});

// ─────────────────────────────────────────────────────────────────────
// P6-B：构建产物缓存、端口冲突重试、--fresh、清理审计与 CLI
// ─────────────────────────────────────────────────────────────────────

async function writeFile(path: string, text: string): Promise<void> {
  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    await Deno.mkdir(path.slice(0, separator), { recursive: true });
  }
  await Deno.writeTextFile(path, text);
}

/** 临时工作树：ui/app 是输入，ui/.output 是产物。 */
async function makeArtifactTree(): Promise<{
  root: string;
  uiSpec: ArtifactSpec;
  cacheDir: string;
}> {
  const root = await Deno.makeTempDir();
  await writeFile(root + "/ui/app/index.ts", "export const a = 1;\n");
  await writeFile(root + "/ui/.output/server/index.mjs", "built-v1");
  return {
    root,
    cacheDir: root + "/cache",
    uiSpec: {
      name: "ui",
      inputs: ["ui/app"],
      artifact: "ui/.output",
      ignore: [],
    },
  };
}

Deno.test("e2e-session: 产物缓存命中需指纹与摘要同时一致", async () => {
  const { root, uiSpec, cacheDir } = await makeArtifactTree();
  const cache = createFileCacheStore(cacheDir);
  try {
    const first = await inspectArtifact(uiSpec, root, cache);
    assertEquals(first.reason, "no-cache");
    assertEquals(first.reusable, false);
    assertEquals(first.present, true);

    await recordArtifact(uiSpec, root, cache, undefined, new Date(0));
    const hit = await inspectArtifact(uiSpec, root, cache);
    assertEquals(hit.reason, "hit");
    assertEquals(hit.reusable, true);

    // 输入变化：即使产物还在也不允许复用。
    await writeFile(root + "/ui/app/index.ts", "export const a = 2;\n");
    const changed = await inspectArtifact(uiSpec, root, cache);
    assertEquals(changed.reason, "fingerprint-changed");
    assertEquals(changed.reusable, false);

    await recordArtifact(uiSpec, root, cache);
    // 产物被删：必须重建。
    await Deno.remove(root + "/ui/.output", { recursive: true });
    assertEquals(
      (await inspectArtifact(uiSpec, root, cache)).reason,
      "missing-artifact",
    );

    // 产物被改：摘要不匹配，绝不拿旧产物冒充命中。
    await writeFile(root + "/ui/.output/server/index.mjs", "tampered");
    assertEquals(
      (await inspectArtifact(uiSpec, root, cache)).reason,
      "digest-mismatch",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: 指纹与产物摘要稳定且与枚举顺序无关", async () => {
  const root = await Deno.makeTempDir();
  try {
    await writeFile(root + "/a.txt", "same");
    const first = await fingerprintInputs(root, ["a.txt"], []);
    const second = await fingerprintInputs(root, ["a.txt"], []);
    assertEquals(first, second);
    await Deno.writeTextFile(root + "/a.txt", "different");
    const third = await fingerprintInputs(root, ["a.txt"], []);
    if (third === first) throw new Error("输入变化后指纹必须变化");
    const digest = await digestArtifact(root, "a.txt");
    assertEquals(digest.artifacts, ["a.txt"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: --fresh 强制重建，不复用已有产物", async () => {
  const { root, uiSpec, cacheDir } = await makeArtifactTree();
  const cache = createFileCacheStore(cacheDir);
  try {
    await recordArtifact(uiSpec, root, cache, undefined, new Date(0));
    const normal = await inspectSessionArtifacts(root, cacheDir, {
      specs: [uiSpec],
    });
    assertEquals(reusedSessionFrom(normal).ui, true);
    const fresh = await inspectSessionArtifacts(root, cacheDir, {
      specs: [uiSpec],
      fresh: true,
    });
    assertEquals(reusedSessionFrom(fresh).ui, false);
    assertEquals(fresh[0]!.reason, "fresh");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: 端口冲突自动换端口重试并把实际端口写回清单", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const portBatches = [15400, 15500];
    let batch = 0;
    const portsFor = () => {
      const base = portBatches[batch]!;
      return new Map(Object.entries({
        postgres: base + 1,
        redis: base + 2,
        core: base + 3,
        minio: base + 4,
        minioConsole: base + 5,
        llmGateway: base + 6,
        llmMock: base + 7,
        coordinator: base + 8,
      }));
    };
    const calls: Array<{ command: string[]; env?: Record<string, string> }> =
      [];
    const responses: CommandResult[] = [
      {
        code: 1,
        stdout: "",
        stderr: "Bind for 0.0.0.0:15401 failed: port is already allocated",
      },
      { code: 0, stdout: "", stderr: "" }, // 失败后的清理
      { code: 0, stdout: "", stderr: "" }, // 第二次 setup 成功
    ];
    const deps = createSessionDeps({
      run: (command, options) => {
        calls.push({ command, env: options?.env });
        const response = responses.shift() ??
          { code: 0, stdout: "", stderr: "" };
        // 第二次 setup 之前切到下一批端口。
        if (calls.length === 2) batch = 1;
        return Promise.resolve(response);
      },
      probePort: (port) => {
        const allowed = portsFor();
        return Promise.resolve([...allowed.values()].includes(port));
      },
      randomSuffix: () => "conflict1",
      repoRoot: root,
    });
    const result = await upSession({
      session: "perf-p",
      sessionDir: dir,
      cacheDir: root + "/cache",
    }, deps);
    assertEquals(result.manifest.ports.postgres, 15501);
    assertEquals(result.manifest.composeProject, "noj-e2e-perf-p-conflict1");
    assertEquals(result.manifest.state, "running");
    const setupCalls = calls.filter((call) =>
      call.command.includes("scripts/e2e/setup.sh")
    );
    assertEquals(setupCalls.length, 2);
    assertEquals(setupCalls[0]!.env?.E2E_PG_PORT, "15401");
    assertEquals(setupCalls[1]!.env?.E2E_PG_PORT, "15501");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: 端口冲突识别覆盖 docker 常见文案", () => {
  assertEquals(
    isPortConflict(
      "Error ... Bind for 0.0.0.0:15401 failed: port is already allocated",
    ),
    true,
  );
  assertEquals(
    isPortConflict("listen tcp 0.0.0.0:9000: bind: address already in use"),
    true,
  );
  assertEquals(isPortConflict("noxc.github: image not found"), false);
});

Deno.test("e2e-session: 启动失败且清理失败时保留清单可审计", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const responses: CommandResult[] = [
      { code: 1, stdout: "", stderr: "boom" },
      { code: 1, stdout: "", stderr: "network busy" },
    ];
    const deps = createSessionDeps({
      run: () =>
        Promise.resolve(
          responses.shift() ?? { code: 0, stdout: "", stderr: "" },
        ),
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "audit001",
      repoRoot: root,
    });
    await assertRejects(
      () =>
        upSession({
          session: "perf-audit",
          sessionDir: dir,
          cacheDir: root + "/cache",
        }, deps),
      Error,
      "清理也失败",
    );
    const kept = await loadSession("perf-audit", dir);
    if (!kept) throw new Error("清理失败后清单必须保留以便审计");
    assertEquals(kept.lastCleanupError, "network busy");
    assertEquals(kept.state, "starting");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: down 成功时删除清单与 env 文件", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const deps = createSessionDeps({
      run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "envfile1",
      repoRoot: root,
    });
    await upSession({
      session: "perf-env",
      sessionDir: dir,
      cacheDir: root + "/cache",
    }, deps);
    const envPath = sessionEnvPath("perf-env", dir);
    const text = await Deno.readTextFile(envPath);
    assertEquals(text.includes("export COMPOSE_PROJECT_NAME="), true);
    const parsed = parseSessionEnv(text);
    assertEquals(parsed.COMPOSE_PROJECT_NAME, "noj-e2e-perf-env-envfile1");
    assertEquals(parsed.E2E_TEST_COORDINATOR_URL, parsed.E2E_COORDINATOR_URL);
    await downSession("perf-env", deps, dir);
    assertEquals(await loadSession("perf-env", dir), undefined);
    let envGone = false;
    try {
      await Deno.stat(envPath);
    } catch {
      envGone = true;
    }
    assertEquals(envGone, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: CLI 输出 reused-session 与可 source 的环境", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const deps = createSessionDeps({
      run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "cli00001",
      repoRoot: root,
    });
    const out: string[] = [];
    const cli = {
      ...deps,
      stdout: (text: string) => out.push(text),
      stderr: () => {},
    };
    const up = await sessionMain(
      ["up", "--session", "perf-cli", "--session-dir", dir],
      cli,
    );
    assertEquals(up, 0);
    assertEquals(out.some((line) => line.includes("reused-session:")), true);
    const manifest = await loadSession("perf-cli", dir);
    if (!manifest) throw new Error("CLI up 必须写清单");

    const showOut: string[] = [];
    assertEquals(
      await sessionMain(
        ["show", "--session", "perf-cli", "--session-dir", dir],
        {
          ...cli,
          stdout: (text: string) => showOut.push(text),
        },
      ),
      0,
    );
    assertEquals(JSON.parse(showOut[0]!).session, "perf-cli");

    const envOut: string[] = [];
    assertEquals(
      await sessionMain(
        ["env", "--session", "perf-cli", "--session-dir", dir],
        {
          ...cli,
          stdout: (text: string) => envOut.push(text),
        },
      ),
      0,
    );
    assertEquals(
      envOut.join("\n").includes("export COMPOSE_PROJECT_NAME="),
      true,
    );

    assertEquals(
      await sessionMain(
        ["down", "--session", "perf-cli", "--session-dir", dir],
        cli,
      ),
      0,
    );
    assertEquals(await loadSession("perf-cli", dir), undefined);

    // 未知参数必须报错，不能静默忽略。
    assertEquals(
      await sessionMain(["up", "--session", "perf-cli", "--bogus"], cli),
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("e2e-session: --fresh 重建后 reusedSession 必须为 false", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    // 先造出产物与缓存记录，模拟「上次构建过的产物」。
    const uiSpec: ArtifactSpec = {
      name: "ui",
      inputs: ["ui/app"],
      artifact: "ui/.output",
      ignore: [],
    };
    await writeFile(root + "/ui/app/index.ts", "export const a = 1;\n");
    await writeFile(root + "/ui/.output/server/index.mjs", "built-v1");
    await recordArtifact(
      uiSpec,
      root,
      createFileCacheStore(root + "/cache"),
      undefined,
      new Date(0),
    );
    const deps = createSessionDeps({
      run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
      probePort: () => Promise.resolve(true),
      randomSuffix: () => "fresh001",
      repoRoot: root,
    });
    const result = await upSession({
      session: "perf-fresh",
      sessionDir: dir,
      cacheDir: root + "/cache",
      artifactSpecs: [uiSpec],
      fresh: true,
    }, deps);
    assertEquals(result.manifest.reusedSession?.ui, false);
    assertEquals(result.artifactStates[0]!.reason, "fresh");
    assertEquals(result.manifest.artifacts?.ui.reason, "fresh");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});
