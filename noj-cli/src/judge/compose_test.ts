import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import {
  composeArgs,
  renderJudgeCompose,
  runJudgeCompose,
  writeJudgeCompose,
} from "./compose.ts";
import type { JudgeOptions } from "./options.ts";

const opts: JudgeOptions = {
  command: "start",
  dir: "/srv/noj-judge",
  envFile: "/srv/noj-judge/.env.judge",
  composeFile: "/srv/noj-judge/docker-compose.judge.yml",
  repo: "https://github.com/Neuro-OJ/neuro-oj",
  ref: "main",
  version: undefined,
  redisContainer: "noj-judge-redis",
  redisPort: 16379,
  panel: "none",
  nonInteractive: true,
  downloadOnly: false,
  dryRun: false,
  follow: false,
};

function fakeRunner(records: { cmd: string; args: string[] }[]): CommandRunner {
  return {
    run(cmd, args) {
      records.push({ cmd, args });
      return Promise.resolve({ code: 7, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

Deno.test("renderJudgeCompose: 包含 noj-judge 镜像与安全配置", () => {
  const text = renderJudgeCompose();
  assertEquals(text.includes("noj-judge"), true);
  assertEquals(text.includes("cap_drop"), true);
  assertEquals(text.includes("no-new-privileges"), true);
  assertEquals(text.includes("JUDGE_REQUIRE_ISOLATED_DOCKER"), true);
});

Deno.test("composeArgs: 使用 project-name/env-file/file", () => {
  const args = composeArgs(opts);
  assertEquals(args.includes("--project-name"), true);
  assertEquals(args.includes("noj-judge-standalone"), true);
  assertEquals(args.includes("--env-file"), true);
  assertEquals(args.includes(opts.envFile), true);
  assertEquals(args.includes("-f"), true);
  assertEquals(args.includes(opts.composeFile), true);
});

Deno.test("composeArgs: 追加后续 docker compose 参数", () => {
  const args = composeArgs(opts, ["up", "-d", "--remove-orphans"]);
  assertEquals(args.at(-3), "up");
  assertEquals(args.at(-2), "-d");
  assertEquals(args.at(-1), "--remove-orphans");
});

Deno.test("writeJudgeCompose: 权限 600", () => {
  const file = `${Deno.makeTempDirSync()}/docker-compose.judge.yml`;
  writeJudgeCompose(file, false);
  const mode = Deno.statSync(file).mode! & 0o777;
  assertEquals(mode, 0o600);
});

Deno.test("writeJudgeCompose: dryRun 不写文件", () => {
  const file = `${Deno.makeTempDirSync()}/docker-compose.judge.yml`;
  writeJudgeCompose(file, true);
  let exists = true;
  try {
    Deno.statSync(file);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});

Deno.test("runJudgeCompose: dryRun 返回 0 且不调用 runner", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCompose(
    { ...opts, dryRun: true },
    ["up", "-d"],
    fakeRunner(records),
  );
  assertEquals(code, 0);
  assertEquals(records.length, 0);
});

Deno.test("runJudgeCompose: 调用 docker compose 并返回退出码", async () => {
  const records: { cmd: string; args: string[] }[] = [];
  const code = await runJudgeCompose(
    opts,
    ["up", "-d"],
    fakeRunner(records),
  );
  assertEquals(code, 7);
  assertEquals(records.length, 1);
  assertEquals(records[0]?.cmd, "docker");
  assertEquals(records[0]?.args[0], "compose");
  assertEquals(records[0]?.args.includes("noj-judge-standalone"), true);
  assertEquals(records[0]?.args.includes(opts.envFile), true);
  assertEquals(records[0]?.args.includes(opts.composeFile), true);
  assertEquals(records[0]?.args.at(-2), "up");
  assertEquals(records[0]?.args.at(-1), "-d");
});
