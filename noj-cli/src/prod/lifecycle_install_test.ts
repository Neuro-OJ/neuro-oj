/**
 * 生产生命周期测试：install 主路径、PATH 注册、原子性与权限。
 *
 * 全部注入 runner / fetcher / IO，永不触碰真实 docker 与网络。
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { PATH_LINE } from "./lifecycle/path.ts";
import { install, type InstallResult } from "./lifecycle.ts";
import {
  COMPOSE,
  COMPOSE_BODY,
  ENV_EXAMPLE,
  ENV_EXAMPLE_ASSET,
  ENV_FILE,
  EXAMPLE_BODY,
  makeCliBinary,
  makeFetcher,
  makeInstalledDir,
  makeIO,
  makeRunner,
  REF,
  REPO,
  RunnerCall,
  writePassphraseFile,
} from "./lifecycle_fixtures.ts";

/** 列出目录条目名（排序）。 */
async function dirNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

const indexOfEvent = (events: string[], prefix: string): number =>
  events.findIndex((e) => e.startsWith(prefix));

Deno.test("install 空目录：拉取资产 → 校验 → 生成 .env.prod → 启动 compose（顺序断言）", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    await makeCliBinary(dir);
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    const passphrase = join(root, "backup-passphrase");
    const io = makeIO(
      ["v0.9.5", "oj.test-oj.cn", "y", "", "y", "", "", "y"],
      events,
    );

    const result: InstallResult = await install({
      dir,
      repository: REPO,
      ref: REF,
      io,
      runner: makeRunner(records, () => undefined, events),
      fetcher: makeFetcher(calls, events),
      isTty: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      socketExists: () => Promise.resolve(true),
      binDir: join(root, "bin"),
      userHome: join(root, "home"),
      warn: (m) => warnings.push(m),
      now: new Date("2026-09-19T00:00:00Z"),
    });

    // ── 顺序：拉取 → 校验 → 生成 .env.prod → compose ──
    assertEquals(calls.length, 4, "必须下载 2 个资产 + 2 个 .sha256");
    const firstFetch = indexOfEvent(events, "fetch:");
    const firstPrompt = indexOfEvent(events, "read:");
    const firstDocker = indexOfEvent(events, "run:docker");
    assert(firstFetch >= 0, "必须先拉取资产");
    assert(
      firstPrompt > firstFetch,
      "配置向导必须在资产拉取之后（洞 2：install 先自举）",
    );
    assert(firstDocker > firstPrompt, "compose 必须在向导之后");
    // 审计：.env.prod 在向导**期间**落盘（seed 早于向导，向导内提交）。
    assert(
      indexOfEvent(events, "write:配置已写入") > firstPrompt,
      "配置必须由向导提交后才可用",
    );

    // ── 步骤记录（首次安装 overwrite:false）──
    assertEquals(result.steps.map((s) => s.name), [
      "bootstrap",
      "seed-env",
      "configure",
      "passphrase",
      "validate",
      "verify-images",
      "compose-pull",
      "compose-up",
      "record-metadata",
      "register",
    ]);
    assertEquals(result.steps[0]?.overwrite, false);
    assertEquals(result.created, true);

    // ── 文件系统效果 ──
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(await Deno.readTextFile(join(dir, ENV_EXAMPLE)), EXAMPLE_BODY);
    const envText = await Deno.readTextFile(join(dir, ENV_FILE));
    assertStringIncludes(envText, "DOMAIN=oj.test-oj.cn");
    assertStringIncludes(envText, "APP_URL=https://oj.test-oj.cn");
    assertStringIncludes(envText, "JUDGE_DOCKER_SOCKET_GID=10001");
    assertStringIncludes(envText, "POSTGRES_PASSWORD=");
    assert(
      !envText.includes("change-me-strong-postgres-password"),
      "模板占位口令必须被真随机值替换",
    );
    assert(
      !envText.includes("NOJ_VERSION=change-me-release-tag"),
      "版本必须是不可变 Release 标签",
    );
    // 口令路径经 targetFile 注入，回填进 .env.prod
    assertStringIncludes(envText, "NOJ_BACKUP_PASSPHRASE_FILE=" + passphrase);
    assertEquals(
      ((await Deno.stat(join(dir, ENV_FILE))).mode ?? 0) & 0o777,
      0o600,
    );
    assertEquals(((await Deno.stat(passphrase)).mode ?? 0) & 0o777, 0o600);

    // ── compose 调用（judge 启用 → 必须带 --profile judge）──
    const composeFile = join(dir, COMPOSE);
    const envFile = join(dir, ENV_FILE);
    const dockerArgs = records.filter((r) => r.cmd === "docker").map(
      (r) => r.args,
    );
    assertEquals(dockerArgs[0], [
      "compose",
      "--project-directory",
      dir,
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "config",
      "--quiet",
    ]);
    assertEquals(dockerArgs[1], [
      "compose",
      "--project-directory",
      dir,
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "pull",
    ]);
    // install 与 start 共用健康等待：两段 up（--wait-timeout 180 --remove-orphans
    // + nginx 刷新）。
    assertEquals(dockerArgs[2], [
      "compose",
      "--project-directory",
      dir,
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--remove-orphans",
    ]);
    assertEquals(dockerArgs[3], [
      "compose",
      "--project-directory",
      dir,
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "--profile",
      "judge",
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
      "nginx",
    ]);
    assertEquals(result.composeUpCode, 0);
    // 告警必须可见且不静默：新建口令文件 + 模板默认关闭验签各一条。
    assertEquals(warnings, [
      "请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照",
      "NOJ_ENFORCE_IMAGE_SIGNATURES=false，已关闭镜像签名校验",
    ]);
    // 关闭验签时不得调用 cosign / buildx。
    assertEquals(records.some((r) => r.cmd === "cosign"), false);
    assertEquals(result.verified, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 已安装目录：升级路径 overwrite:true 且保留既有 .env.prod 内容", async () => {
  const dir = await makeInstalledDir();
  try {
    const original = await Deno.readTextFile(join(dir, ENV_FILE));
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], events),
      runner: makeRunner(records),
      fetcher: makeFetcher(calls, events),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      warn: () => {},
    });

    assertEquals(result.created, false);
    assertEquals(result.steps[0]?.name, "bootstrap");
    assertEquals(
      result.steps[0]?.overwrite,
      true,
      "升级路径必须显式 overwrite:true",
    );
    // 既有 .env.prod 逐字节保留（口令文件已存在 → 无回填）
    assertEquals(await Deno.readTextFile(join(dir, ENV_FILE)), original);
    // compose 已按新版本重新下载（overwrite 生效）
    assertEquals(await Deno.readTextFile(join(dir, COMPOSE)), COMPOSE_BODY);
    assertEquals(calls.length, 4);
    assertEquals(records.some((r) => r.args.includes("up")), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install --non-interactive 缺必需配置：明确报错、不进向导、零写入", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], events),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, events),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "缺少必需配置",
    );
    assertEquals(events, [], "非交互下不得进入向导");
    assertEquals(calls, [], "非交互下不得下载资产");
    assertEquals(records, [], "非交互下不得调用 docker");
    assertEquals(await dirNames(dir), [], "非交互下不得写任何文件");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install --dir /（或空）被拒绝：零副作用", async () => {
  for (const dir of ["/", "", "."]) {
    const events: string[] = [];
    const calls: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], events),
          runner: makeRunner([]),
          fetcher: makeFetcher(calls, events),
          nonInteractive: true,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "安装目录不安全或为空",
    );
    assertEquals(calls, []);
  }
});

Deno.test("install PATH 注册：优先全局目录并指向 <dir>/bin/noj-cli", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const globalBin = join(root, "usr-local-bin");
    await Deno.mkdir(globalBin, { recursive: true });
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: globalBin,
      userHome: join(root, "home"),
      warn: () => {},
    });

    const link = join(globalBin, "noj-cli");
    assertEquals(result.registration.path, link);
    assertEquals(await Deno.readLink(link), join(dir, "bin/noj-cli"));
    assertEquals(result.registration.warnings, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install PATH 注册：全局目录不可用时回落 ~/.local/bin 并补 PATH", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const blocked = join(root, "blocked-bin");
    await Deno.writeTextFile(blocked, "not a directory\n");
    const home = join(root, "home");
    await Deno.mkdir(home, { recursive: true });
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: blocked,
      userHome: home,
      warn: () => {},
    });

    const link = join(home, ".local/bin/noj-cli");
    assertEquals(result.registration.path, link);
    assertEquals(await Deno.readLink(link), join(dir, "bin/noj-cli"));
    const profile = await Deno.readTextFile(join(home, ".profile"));
    assertStringIncludes(profile, PATH_LINE);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install PATH 注册：同名命令指向他处时拒绝覆盖（零副作用）", async () => {
  const root = await Deno.makeTempDir();
  const dir = await makeInstalledDir();
  try {
    const globalBin = join(root, "usr-local-bin");
    await Deno.mkdir(globalBin, { recursive: true });
    await Deno.writeTextFile(join(globalBin, "noj-cli"), "someone-else\n");
    const home = join(root, "home");
    await Deno.mkdir(join(home, ".local/bin"), { recursive: true });
    await Deno.writeTextFile(
      join(home, ".local/bin/noj-cli"),
      "someone-else\n",
    );
    await makeCliBinary(dir);
    const passphrase = join(root, "backup-passphrase");
    await writePassphraseFile(passphrase);

    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      binDir: globalBin,
      userHome: home,
      warn: () => {},
    });

    assertEquals(result.registration.path, null);
    assertEquals(
      await Deno.readTextFile(join(globalBin, "noj-cli")),
      "someone-else\n",
    );
    assertEquals(
      await Deno.readTextFile(join(home, ".local/bin/noj-cli")),
      "someone-else\n",
    );
    assert(
      result.registration.warnings.some((w) => w.includes("未覆盖已有命令")),
      "必须在告警中说明未覆盖",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 失败原子性：资产校验失败 → 不写 .env.prod、不调用 docker", async () => {
  const dir = await Deno.makeTempDir();
  const root = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const calls: string[] = [];
    const records: RunnerCall[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO(["v0.9.5", "oj.test-oj.cn"], events),
          runner: makeRunner(records),
          fetcher: makeFetcher(calls, events, {
            [ENV_EXAMPLE_ASSET]: "0".repeat(64),
          }),
          isTty: true,
          passphraseFile: join(root, "backup-passphrase"),
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "SHA-256 校验失败",
    );
    assertEquals(records, [], "校验失败后不得调用 docker");
    assertEquals(
      await dirNames(dir),
      [],
      "校验失败后目录必须保持为空（原子性）",
    );
    assertEquals(events.some((e) => e.startsWith("read:")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install 权限：.env.prod 非 600/400 → 安装前拒绝", async () => {
  for (const mode of [0o644, 0o640, 0o666]) {
    const dir = await makeInstalledDir({}, mode);
    try {
      const calls: string[] = [];
      const records: RunnerCall[] = [];
      await assertRejects(
        () =>
          install({
            dir,
            repository: REPO,
            ref: REF,
            io: makeIO([], []),
            runner: makeRunner(records),
            fetcher: makeFetcher(calls, []),
            nonInteractive: true,
            processEnv: {},
            warn: () => {},
          }),
        Error,
        "生产配置文件权限必须为 600 或 400",
      );
      assertEquals(calls, [], "权限不合格时不得下载资产");
      assertEquals(records, [], "权限不合格时不得调用 docker");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("install 权限：.env.prod 为 400 亦可通过", async () => {
  const dir = await makeInstalledDir({}, 0o400);
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner([]),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      warn: () => {},
    });
    assertEquals(result.created, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install cosign 不可用：可见警告且不启动 compose（不静默跳过）", async () => {
  const dir = await makeInstalledDir({ NOJ_ENFORCE_IMAGE_SIGNATURES: "true" });
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner(records),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          cosignAvailable: () => Promise.resolve(false),
          warn: (m) => warnings.push(m),
        }),
      Error,
      "找不到 Cosign",
    );
    assert(
      warnings.some((w) => w.includes("找不到 Cosign")),
      "跳过验签必须有可见警告，不得静默",
    );
    assertEquals(
      records.some((r) => r.args.includes("pull")),
      false,
      "验签失败后不得拉取/启动 compose",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install cosign：NOJ_ENFORCE_IMAGE_SIGNATURES=false 时显式告警并继续", async () => {
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    const records: RunnerCall[] = [];
    const warnings: string[] = [];
    const result = await install({
      dir,
      repository: REPO,
      ref: REF,
      io: makeIO([], []),
      runner: makeRunner(records),
      fetcher: makeFetcher([], []),
      nonInteractive: true,
      passphraseFile: passphrase,
      processEnv: {},
      cosignAvailable: () => Promise.resolve(true),
      warn: (m) => warnings.push(m),
    });
    assert(
      warnings.some((w) => w.includes("NOJ_ENFORCE_IMAGE_SIGNATURES=false")),
      "关闭验签必须告警（不静默）",
    );
    assertEquals(result.verified, []);
    assertEquals(records.some((r) => r.args.includes("up")), true);
    assertEquals(records.some((r) => r.cmd === "cosign"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install compose up 非 0：报告失败并透传退出码", async () => {
  const dir = await makeInstalledDir();
  try {
    const passphrase = join(dir, "backup-passphrase");
    await writePassphraseFile(passphrase);
    await assertRejects(
      () =>
        install({
          dir,
          repository: REPO,
          ref: REF,
          io: makeIO([], []),
          runner: makeRunner([], (cmd, args) =>
            cmd === "docker" && args.includes("up")
              ? { code: 17, stdout: "", stderr: "boom" }
              : undefined),
          fetcher: makeFetcher([], []),
          nonInteractive: true,
          passphraseFile: passphrase,
          processEnv: {},
          warn: () => {},
        }),
      Error,
      "服务启动或健康检查失败",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
