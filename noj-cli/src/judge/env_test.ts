import { assertEquals } from "@std/assert";
import { envValue, loadJudgeEnv, saveJudgeEnv, setJudgeEnv } from "./env.ts";

Deno.test("loadJudgeEnv: 解析 KEY=VALUE", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  Deno.writeTextFileSync(file, "NOJ_VERSION=v0.1.0\nREDIS_URL=redis://x/0\n");
  const env = loadJudgeEnv(file);
  assertEquals(envValue(env, "NOJ_VERSION"), "v0.1.0");
  assertEquals(envValue(env, "REDIS_URL"), "redis://x/0");
});

Deno.test("saveJudgeEnv: 写文件并保留权限 600", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  saveJudgeEnv(file, { NOJ_VERSION: "v0.1.0" });
  assertEquals(Deno.readTextFileSync(file), "NOJ_VERSION=v0.1.0\n");
  const mode = Deno.statSync(file).mode! & 0o777;
  assertEquals(mode, 0o600);
});

Deno.test("setJudgeEnv: 更新已有键", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/.env.judge`;
  saveJudgeEnv(file, { A: "1" });
  setJudgeEnv(file, "A", "2");
  setJudgeEnv(file, "B", "3");
  const text = Deno.readTextFileSync(file);
  assertEquals(text.includes("A=2"), true);
  assertEquals(text.includes("B=3"), true);
});
