import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { UsageError } from "../util/args.ts";
import {
  dispatchMaintain,
  MAINTAIN_SUBCOMMANDS,
  type MaintainDispatchDeps,
  parseMaintainArgs,
  renderMaintainHelp,
} from "./maintain.ts";

/** 造一个 fake dispatch 依赖：记录 run 收到的容器执行选项。 */
function makeDeps(): {
  deps: MaintainDispatchDeps;
  runs: import("../container_run.ts").RunContainerOptions[];
} {
  const runs: import("../container_run.ts").RunContainerOptions[] = [];
  return {
    runs,
    deps: {
      findProductionDir: (explicit) =>
        Promise.resolve(explicit === undefined ? "/opt/neuro-oj" : explicit),
      parseInstallDir: (args) => {
        const i = args.indexOf("--install-dir");
        return i === -1 ? undefined : args[i + 1];
      },
      stripCliFlags: (args) => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--install-dir") {
            i++;
            continue;
          }
          if (args[i] === "--dry-run") continue;
          out.push(args[i]!);
        }
        return out;
      },
      run: (options) => {
        runs.push(options);
        return Promise.resolve(0);
      },
    },
  };
}

Deno.test("parseMaintainArgs: 解析子命令并透传选项", () => {
  const parsed = parseMaintainArgs(["enter", "--json"]);
  assertEquals(parsed.sub, "enter");
  assertEquals(parsed.args, ["maintain", "enter", "--json"]);
  assertEquals(parsed.json, true);
  assertEquals(parseMaintainArgs(["wait", "--timeout", "60"]).json, false);
});

Deno.test("parseMaintainArgs: 缺子命令/未知子命令抛用法错误", () => {
  for (const argv of [[], ["--json"], ["bogus"]]) {
    let error: unknown = null;
    try {
      parseMaintainArgs(argv);
    } catch (e) {
      error = e;
    }
    assert(error instanceof UsageError, `${argv.join(" ")} 应抛 UsageError`);
  }
});

Deno.test("MAINTAIN_SUBCOMMANDS: 与容器内 CLI 的四个子命令一致", () => {
  assertEquals([...MAINTAIN_SUBCOMMANDS], ["enter", "status", "wait", "exit"]);
});

Deno.test("renderMaintainHelp: 列出子命令、容器选项与宿主选项", () => {
  const text = renderMaintainHelp();
  for (
    const expected of [
      "maintain",
      "enter",
      "status",
      "wait",
      "exit",
      "--json",
      "--url",
      "--timeout",
      "--install-dir",
      "--no-deps",
    ]
  ) {
    assertStringIncludes(text, expected);
  }
});

Deno.test("dispatchMaintain: 帮助路径不定位目录、不起容器", async () => {
  const { deps, runs } = makeDeps();
  const original = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    const code = await dispatchMaintain(
      { service: "core", args: ["maintain", "--help"] },
      deps,
    );
    assertEquals(code, 0);
  } finally {
    console.log = original;
  }
  assertStringIncludes(out, "maintain <enter|status|wait|exit>");
  assertEquals(runs.length, 0);
});

Deno.test("dispatchMaintain: 以 --no-deps 执行并原样透传子命令与 --json", async () => {
  const { deps, runs } = makeDeps();
  const code = await dispatchMaintain(
    { service: "core", args: ["maintain", "wait", "--json"] },
    deps,
  );
  assertEquals(code, 0);
  assertEquals(runs.length, 1);
  const options = runs[0]!;
  assertEquals(options.dir, "/opt/neuro-oj");
  assertEquals(options.service, "core");
  assertEquals(options.command, ["maintain", "wait", "--json"]);
  assertEquals(options.noDeps, true);
  assertEquals(options.dryRun, false);
});

Deno.test("dispatchMaintain: --dry-run 与 --install-dir 不进入容器命令", async () => {
  const { deps, runs } = makeDeps();
  await dispatchMaintain(
    {
      service: "core",
      args: ["maintain", "exit", "--install-dir", "/srv/noj", "--dry-run"],
    },
    deps,
  );
  const options = runs[0]!;
  assertEquals(options.dir, "/srv/noj");
  assertEquals(options.command, ["maintain", "exit"]);
  assertEquals(options.dryRun, true);
  assertEquals(options.noDeps, true);
});

Deno.test("dispatchMaintain: 未知子命令在宿主机即报用法错误", async () => {
  const { deps, runs } = makeDeps();
  let error: unknown = null;
  try {
    await dispatchMaintain(
      { service: "core", args: ["maintain", "bogus"] },
      deps,
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof UsageError);
  assertEquals(runs.length, 0);
});
