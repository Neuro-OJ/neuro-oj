/**
 * 生产生命周期测试：uninstall 确认词、数据卷安全与工作区保护。
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
import type { CmdResult } from "../runtime/command.ts";
import { uninstall, type UninstallResult } from "./lifecycle.ts";
import { assertRemovableInstallDir } from "./lifecycle/uninstall-guards.ts";
import {
  captureRenderIO,
  completeEnv,
  COMPOSE,
  COMPOSE_BODY,
  ENV_FILE,
  hasSub,
  makeCliBinary,
  makeInstalledDir,
  makeRunner,
  NO_COLOR,
  RunnerCall,
  throwingRunner,
} from "./lifecycle_fixtures.ts";

// ---------------- uninstall（确认词 / 数据卷安全 / 工作区保护） ----------------
//
// 全部注入 runner：
// docker --version / info / compose version 与 compose down 都是 fake，绝不触碰
// 真实 docker；确认词经注入的 readConfirm 读取，绝不读真实 stdin。
//
// 本任务的三处关键不对称：
// 1. 两个**不同**的确认词——默认 UNINSTALL，--all 必须是 DELETE ALL；
// 2. 默认卸载**保留**数据卷（--rmi local），--all 才 --volumes + --rmi all；
// 3. 卸载必须覆盖**全部 profile**（judge + monitoring），否则 profiled 服务残留。

/** 路径存在性（含软链）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 取唯一的 compose down 调用（不存在即 undefined）。 */
function downCall(records: RunnerCall[]): RunnerCall | undefined {
  return records.find((r) => hasSub(r, "down"));
}

/**
 * 造出**通过** `--all` 安装目录守卫的完整安装目录。
 *
 * 判据是 `bin/noj-cli` + `PRODUCTION_MARKERS`（compose + `.env.prod`）——
 *
 * 不齐全时先于工作区检查报"不是完整的 NOJ 安装目录"。因此凡是要走到守卫
 * 后续分支（工作区拒绝、危险路径拒绝、真正 `rm -rf`）的用例，都必须用本
 * helper 而不是裸 `makeInstalledDir`。
 */
async function makeRemovableDir(): Promise<string> {
  // **只造真实安装流程产得出的形状**：`bin/noj-cli` + `PRODUCTION_MARKERS`
  // （compose + .env.prod）。不伪造 `install` 不会创建的文件——
  // 那会让"uninstall 完整性判据"的测试跑在一个不可能的目录形状上，
  // 从而掩盖真实缺口（install 曾根本不放置 `bin/noj-cli`，
  // 而测试因为自己预置了它而全绿）。
  const dir = await makeInstalledDir();
  await makeCliBinary(dir);
  return dir;
}

/** docker --version 非 0：CLI 缺失。 */
function cliMissing(
  cmd: string,
  args: string[],
): Partial<CmdResult> | undefined {
  return cmd === "docker" && args[0] === "--version"
    ? { code: 127, stderr: "docker: not found" }
    : undefined;
}

/** docker info 非 0：daemon 不可用。 */
function daemonUnavailable(
  cmd: string,
  args: string[],
): Partial<CmdResult> | undefined {
  return cmd === "docker" && args[0] === "info"
    ? { code: 1, stderr: "Cannot connect to the Docker daemon" }
    : undefined;
}

/** docker compose version 非 0：Compose v2 不可用。 */
function composeMissing(
  cmd: string,
  args: string[],
): Partial<CmdResult> | undefined {
  return cmd === "docker" && args[0] === "compose" && args[1] === "version"
    ? { code: 1, stderr: "compose: unknown command" }
    : undefined;
}

/** compose down 失败（失败保护用例）。 */
function downFails(
  cmd: string,
  args: string[],
): Partial<CmdResult> | undefined {
  return cmd === "docker" && args.includes("down")
    ? { code: 1, stderr: "down failed" }
    : undefined;
}

Deno.test("uninstall 默认 --yes：down --rmi local、覆盖全 profile、保留数据卷与安装目录", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result: UninstallResult = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.error, null);
    assertEquals(result.all, false);
    assertEquals(result.volumesRemoved, false);
    assertEquals(result.installDirRemoved, false);
    const down = downCall(records);
    assert(down !== undefined, "必须执行一次 compose down");
    assertEquals(down.args, [
      "compose",
      "--env-file",
      join(dir, ENV_FILE),
      "-f",
      join(dir, COMPOSE),
      "--profile",
      "judge",
      "--profile",
      "monitoring",
      "down",
      "--remove-orphans",
      "--rmi",
      "local",
    ]);
    assertEquals(down.args.includes("--volumes"), false, "默认不得删除数据卷");
    assert(await pathExists(join(dir, ENV_FILE)), ".env.prod 必须保留");
    assert(await pathExists(join(dir, COMPOSE)), "compose 文件必须保留");
    assertStringIncludes(
      stdout.join(""),
      "数据卷、生产配置、备份和部署目录已保留",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall --all --yes：down --rmi all --volumes 并删除安装目录", async () => {
  const dir = await makeRemovableDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      all: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.all, true);
    assertEquals(result.volumesRemoved, true);
    assertEquals(result.installDirRemoved, true);
    const down = downCall(records);
    assert(down !== undefined);
    // down --remove-orphans --rmi all --volumes。
    assertEquals(down.args.slice(down.args.indexOf("down")), [
      "down",
      "--remove-orphans",
      "--rmi",
      "all",
      "--volumes",
    ]);
    assertEquals(records.filter((r) => hasSub(r, "down")).length, 1);
    assertEquals(await pathExists(dir), false, "--all 必须删除安装目录");
    assertStringIncludes(stdout.join(""), "已删除 NOJ 安装目录");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uninstall --all：输入 UNINSTALL 不通过（必须是 DELETE ALL），零副作用", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const prompts: string[] = [];
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      all: true,
      isTty: true,
      readConfirm: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve("UNINSTALL");
      },
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "未确认完全删除，未修改任何服务或文件",
    );
    assertEquals(records, [], "确认失败必须零 runner 调用");
    assertEquals(prompts.length, 1);
    assertStringIncludes(prompts[0] ?? "", "DELETE ALL");
    assert(await pathExists(join(dir, ENV_FILE)));
    assert(await pathExists(dir));
    assertStringIncludes(stderr.join(""), "此操作不可恢复");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall --all：输入 DELETE ALL 通过", async () => {
  const dir = await makeRemovableDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      all: true,
      isTty: true,
      readConfirm: () => Promise.resolve("DELETE ALL"),
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assert(downCall(records) !== undefined);
    assertEquals(await pathExists(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uninstall：无 TTY 且未 --yes → 硬错误且零 runner 调用", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "卸载需要交互确认；自动化环境请显式使用 --yes",
    );
    assertEquals(records, [], "未确认时不得调用任何外部命令");
    assertStringIncludes(stderr.join(""), "请显式使用 --yes");
    assert(await pathExists(join(dir, ENV_FILE)), "未确认时不得修改文件");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall：TTY 下输入 UNINSTALL → 通过且保留数据卷", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const prompts: string[] = [];
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      isTty: true,
      readConfirm: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve("UNINSTALL");
      },
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertStringIncludes(prompts[0] ?? "", "请输入 UNINSTALL 确认卸载");
    const down = downCall(records);
    assert(down !== undefined);
    assertEquals(down.args.includes("--volumes"), false);
    assert(await pathExists(dir), "默认卸载必须保留安装目录");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall：TTY 下输入错误词 → 报错且零副作用", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      isTty: true,
      readConfirm: () => Promise.resolve("yes"),
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "未确认卸载，未修改任何服务或文件",
    );
    assertEquals(records, []);
    assert(await pathExists(join(dir, ENV_FILE)));
    assert(await pathExists(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall：down 覆盖全部 profile（judge + monitoring），默认与 --all 一致", async () => {
  for (const all of [false, true]) {
    // `--all` 分支必须先通过安装目录守卫，故用完整安装目录。
    const dir = all ? await makeRemovableDir() : await makeInstalledDir();
    try {
      const records: RunnerCall[] = [];
      const { io } = captureRenderIO();
      const result = await uninstall({
        dir,
        runner: makeRunner(records),
        yes: true,
        all,
        isTty: false,
        io,
        color: NO_COLOR,
        processEnv: {},
      });
      assertEquals(result.exitCode, 0);
      const down = downCall(records);
      assert(down !== undefined);
      const profiles = down.args
        .map((
          arg,
          index,
        ) => (arg === "--profile" ? down.args[index + 1] : null))
        .filter((name): name is string => name !== null);
      assertEquals(
        [...profiles].sort(),
        ["judge", "monitoring"],
        "卸载必须启用全部 profile（INCLUDE_ALL_PROFILES=1）",
      );
      assert(
        down.args.indexOf("monitoring") < down.args.indexOf("down"),
        "profile 旗标必须在子命令之前",
      );
      assertEquals(down.args.includes("--volumes"), all);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test("uninstall 前置：docker CLI 缺失 → 明确报错且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records, cliMissing),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到 Docker CLI：docker");
    assertEquals(downCall(records), undefined);
    assertStringIncludes(stderr.join(""), "找不到 Docker CLI");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：docker 探测**抛 NotFound**（真实缺二进制）→ 仍报找不到 Docker CLI 且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    // 真实 runner 在二进制缺失时抛 Deno.errors.NotFound，而不是返回 127。
    const result = await uninstall({
      dir,
      runner: throwingRunner(records, () => true),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到 Docker CLI：docker");
    assertEquals(downCall(records), undefined);
    assertStringIncludes(stderr.join(""), "找不到 Docker CLI");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：docker info **抛 NotFound** → 仍报 daemon 不可用且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: throwingRunner(
        records,
        (cmd, args) => cmd === "docker" && args[0] === "info",
      ),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "Docker daemon 未运行或当前用户无权限",
    );
    assertEquals(downCall(records), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：compose version **抛 NotFound** → 仍报 Compose v2 不可用且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: throwingRunner(
        records,
        (cmd, args) => cmd === "docker" && args[0] === "compose",
      ),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "Docker Compose v2 不可用");
    assertEquals(downCall(records), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：daemon 不可用 → 明确报错且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records, daemonUnavailable),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(
      result.error ?? "",
      "Docker daemon 未运行或当前用户无权限",
    );
    assertEquals(downCall(records), undefined);
    assert(await pathExists(join(dir, ENV_FILE)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：Compose v2 不可用 → 明确报错且零 down", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records, composeMissing),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "Docker Compose v2 不可用");
    assertEquals(downCall(records), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：缺 .env.prod → 明确报错且零 down", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, COMPOSE), COMPOSE_BODY);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产配置");
    assertStringIncludes(result.error ?? "", "无法安全定位生产 Compose 栈");
    assertEquals(downCall(records), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall 前置：缺 compose 文件 → 明确报错且零 down", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, ENV_FILE), completeEnv());
    await Deno.chmod(join(dir, ENV_FILE), 0o600);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "找不到生产 Compose 文件");
    assertEquals(downCall(records), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall --all：检测到 Git/jj 工作区标记 → 拒绝且不执行 down", async () => {
  const dir = await makeRemovableDir();
  try {
    // colocated 仓库里 .jj 是文件、.git 是目录；两者都必须命中。
    await Deno.writeTextFile(join(dir, ".jj"), "");
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      all: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "检测到 Git 工作区");
    assertStringIncludes(result.error ?? "", "拒绝删除源码目录");
    assertStringIncludes(result.error ?? "", "uninstall --all");
    assertEquals(
      records.filter((r) => hasSub(r, "down")),
      [],
      "工作区保护必须在 down 之前",
    );
    assert(await pathExists(join(dir, ENV_FILE)));
    assertStringIncludes(stderr.join(""), "检测到 Git 工作区");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall --all：.git 目录同样触发工作区保护", async () => {
  const dir = await makeRemovableDir();
  try {
    await Deno.mkdir(join(dir, ".git"));
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      all: true,
      isTty: false,
      io,
      color: NO_COLOR,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "检测到 Git 工作区");
    assertEquals(records.filter((r) => hasSub(r, "down")), []);
    assert(await pathExists(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall：只移除指向本安装目录的软链，他处软链与普通文件保留", async () => {
  const dir = await makeInstalledDir();
  const bin = await Deno.makeTempDir();
  const other = await Deno.makeTempDir();
  try {
    const ours = join(bin, "noj-cli");
    const foreign = join(bin, "noj");
    const foreignTarget = join(other, "noj-cli");
    await Deno.writeTextFile(foreignTarget, "");
    await Deno.symlink(join(dir, "bin/noj-cli"), ours);
    await Deno.symlink(foreignTarget, foreign);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      binDir: bin,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.removedCommands, [ours]);
    assertEquals(await pathExists(ours), false, "指向本安装目录的软链必须移除");
    assertEquals(await pathExists(foreign), true, "指向他处的软链绝不能被删");
    assertEquals(await pathExists(join(dir, ENV_FILE)), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(bin, { recursive: true });
    await Deno.remove(other, { recursive: true });
  }
});

Deno.test("uninstall：无指向本安装目录的软链 → 告警而非报错", async () => {
  const dir = await makeInstalledDir();
  const bin = await Deno.makeTempDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      binDir: bin,
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.removedCommands, []);
    assertStringIncludes(
      stderr.join(""),
      "未找到指向当前安装目录的 PATH 命令软链接",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(bin, { recursive: true });
  }
});

Deno.test("uninstall：compose down 失败 → 退出码 1 且不移除软链/安装目录", async () => {
  const dir = await makeInstalledDir();
  const bin = await Deno.makeTempDir();
  try {
    const link = join(bin, "noj-cli");
    await Deno.symlink(join(dir, "bin/noj-cli"), link);
    const records: RunnerCall[] = [];
    const { io, stderr } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records, downFails),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      binDir: bin,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "down failed");
    assertEquals(result.removedCommands, []);
    assertEquals(await pathExists(link), true, "失败时不得移除 PATH 软链");
    assertEquals(await pathExists(dir), true, "失败时不得删除安装目录");
    assertStringIncludes(stderr.join(""), "down failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(bin, { recursive: true });
  }
});

Deno.test("uninstall --all：down --volumes 成功后软链清理失败 → volumesRemoved 仍为 true", async () => {
  const dir = await makeRemovableDir();
  const bin = await Deno.makeTempDir();
  try {
    await Deno.symlink(join(dir, "bin/noj-cli"), join(bin, "noj-cli"));
    // 只读父目录让 `unlink` 真的 PermissionDenied（Ubuntu 非 root 下可复现），
    // 于是 unregisterCommand 走删除失败的抛错分支。
    await Deno.chmod(bin, 0o500);
    const records: RunnerCall[] = [];
    const { io } = captureRenderIO();
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      all: true,
      isTty: false,
      io,
      color: NO_COLOR,
      binDir: bin,
      processEnv: {},
    });
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.error ?? "", "无法移除 PATH 命令软链接");
    // `down --volumes` 已成功，volumesRemoved 必须如实为 true，
    // 不因后续清理失败而回退。
    assertEquals(result.volumesRemoved, true);
    assertEquals(result.installDirRemoved, false);
  } finally {
    await Deno.chmod(bin, 0o755).catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.remove(bin, { recursive: true }).catch(() => {});
  }
});

Deno.test("uninstall --all：拒绝危险安装路径（HOME）", async () => {
  const dir = await makeRemovableDir();
  try {
    await assertRejects(
      () => assertRemovableInstallDir(dir, { HOME: dir }),
      Error,
      "拒绝删除危险安装路径",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall --json：stdout 只有 JSON 文档，人类文字改道 stderr", async () => {
  const dir = await makeInstalledDir();
  try {
    const records: RunnerCall[] = [];
    const { io, stdout, stderr } = captureRenderIO(true);
    const result = await uninstall({
      dir,
      runner: makeRunner(records),
      yes: true,
      isTty: false,
      io,
      color: NO_COLOR,
      args: ["--json"],
      processEnv: {},
    });
    assertEquals(result.exitCode, 0);
    assertEquals(
      stdout.join(""),
      JSON.stringify(
        {
          dir,
          all: false,
          volumesRemoved: false,
          removedCommands: [],
          installDirRemoved: false,
          state: "stopped",
          noOp: false,
          error: null,
        },
        null,
        2,
      ) + "\n",
    );
    assertStringIncludes(
      stderr.join(""),
      "数据卷、生产配置、备份和部署目录已保留",
    );
    assertEquals(stdout.join("").includes("\x1b["), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
