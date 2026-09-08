import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { saveProdEnv } from "./env.ts";
import { prodConfigCheck, prodConfigSet, prodConfigShow } from "./config.ts";

function fullEnv(): Record<string, string> {
  return {
    NOJ_VERSION: "v0.1.0",
    APP_URL: "https://oj.neuro-oj.dev",
    DOMAIN: "oj.neuro-oj.dev",
    CORS_ALLOWED_ORIGINS: "https://oj.neuro-oj.dev",
    TRUSTED_PROXIES: "172.28.0.0/16",
    POSTGRES_USER: "noj",
    POSTGRES_DB: "noj",
    POSTGRES_PASSWORD: "strong",
    REDIS_PASSWORD: "strong",
    MINIO_ROOT_USER: "root",
    MINIO_ROOT_PASSWORD: "strong",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
    S3_BUCKET: "bucket",
    JWT_SECRET: "strong-secret-with-32-chars-min-1234",
    TFA_ENCRYPTION_KEY: "strong-tfa-key-with-32-chars-min-1234",
    NOJ_LLM_SERVICE_TOKEN: "token",
    NOJ_LLM_STORE_KEY: "store",
    ADMIN_EMAIL: "admin@noj.test",
    ADMIN_PASS: "StrongPass123",
  };
}

function recordingRunner(log: string[][]): CommandRunner {
  return {
    run(cmd, args) {
      log.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

Deno.test("prodConfigCheck: 通过", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodConfigCheck(
    { envFile, composeFile: `${dir}/compose.yml` },
    recordingRunner(log),
  );
  assertEquals(code, 0);
});

Deno.test("prodConfigShow: 脱敏", () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const shown = prodConfigShow({ envFile, composeFile: "" });
  assertEquals(shown.includes("POSTGRES_PASSWORD=***"), true);
});

Deno.test("prodConfigSet: 写入新值", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodConfigSet(
    { envFile, composeFile: "" },
    "DOMAIN",
    "new.neuro-oj.dev",
    recordingRunner(log),
  );
  assertEquals(code, 0);
  assertEquals(
    Deno.readTextFileSync(envFile).includes("DOMAIN=new.neuro-oj.dev"),
    true,
  );
});
