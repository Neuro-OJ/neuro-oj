import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig } from "../config/types.ts";
import {
  configCheck,
  configSet,
  configShow,
  maintainVerify,
  maskSecrets,
  parseConfigValue,
  setByPath,
} from "./config.ts";
import {
  baseConfig,
  fakeRunner,
  makeTempDir,
  secrets,
  writeFixture,
} from "../testing/helpers.ts";

function config(): DeployConfig {
  return baseConfig({
    state: "stopped",
    env: { DOMAIN: "oj.example.com", JWT_SECRET: "super-secret" },
    components: {
      server: {
        enabled: true,
        method: "docker",
        image: "x",
        env: { PORT: "8000", DB_PASSWORD: "pw" },
      },
    },
  });
}

const testSecrets = () => secrets({ secrets: { JWT_SECRET: "x".repeat(32) } });

Deno.test("maskSecrets: 敏感 key 值被替换为 ***，其余保留", () => {
  const m = maskSecrets(config());
  assertEquals(m.env["DOMAIN"], "oj.example.com");
  assertEquals(m.env["JWT_SECRET"], "***");
  assertEquals(m.components["server"]!.env["DB_PASSWORD"], "***");
  assertEquals(m.components["server"]!.env["PORT"], "8000");
  // 不修改原对象
  assertEquals(config().env["JWT_SECRET"], "super-secret");
});

Deno.test("setByPath: 设置嵌套路径并创建中间对象", () => {
  const obj: Record<string, unknown> = { a: { b: 1 } };
  setByPath(obj, "a.b", 2);
  assertEquals(obj["a"], { b: 2 });
  setByPath(obj, "x.y.z", "v");
  assertEquals(obj["x"], { y: { z: "v" } });
});

Deno.test("parseConfigValue: 布尔/数字/字符串", () => {
  assertEquals(parseConfigValue("true"), true);
  assertEquals(parseConfigValue("false"), false);
  assertEquals(parseConfigValue("8080"), 8080);
  assertEquals(parseConfigValue("hello"), "hello");
});

Deno.test("configCheck: 合法配置返回空数组", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  assertEquals(await configCheck(dir), []);
});

Deno.test("configShow: 输出脱敏后的 JSON", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  const text = await configShow(dir);
  const parsed = JSON.parse(text) as DeployConfig;
  assertEquals(parsed.env["JWT_SECRET"], "***");
  assertEquals(parsed.env["DOMAIN"], "oj.example.com");
});

Deno.test("configSet: 修改配置并落盘，权限保持", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  await configSet(dir, "env.DOMAIN", "new.example.com");
  const { config: c } = await import("../config/load.ts").then((m) =>
    m.loadDeployment(dir)
  );
  assertEquals(c.env["DOMAIN"], "new.example.com");
  const st = await Deno.stat(`${dir}/noj-deploy.json`);
  assertEquals((st.mode ?? 0) & 0o777, 0o644);
});

Deno.test("configSet: 校验失败时抛错且不落盘", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  // 把 schema_version 改坏
  await assertRejects(
    () => configSet(dir, "schema_version", "2"),
    Error,
    "schema_version",
  );
  const { config: c } = await import("../config/load.ts").then((m) =>
    m.loadDeployment(dir)
  );
  assertEquals(c.schema_version, 1);
});

Deno.test("maintainVerify: 配置/Compose/镜像均通过时 pass=true", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  await Deno.writeTextFile(`${dir}/docker-compose.noj.yml`, "services: {}\n");
  const report = await maintainVerify(dir, fakeRunner());
  assertEquals(report.pass, true);
  assertEquals(report.errors.length, 0);
});

Deno.test("maintainVerify: 缺少 Compose 文件时报错", async () => {
  const dir = await makeTempDir();
  await writeFixture(dir, config(), testSecrets());
  const report = await maintainVerify(dir, fakeRunner());
  assertEquals(report.pass, false);
  assertEquals(report.errors.some((e) => e.includes("Compose")), true);
});
