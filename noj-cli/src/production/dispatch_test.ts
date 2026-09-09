import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { saveProdEnv } from "./env.ts";
import { dispatchProdAlias } from "./dispatch.ts";

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

function makeProdDir(): { dir: string; envFile: string; composeFile: string } {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  const composeFile = `${dir}/docker-compose.prod.yml`;
  saveProdEnv(envFile, fullEnv());
  Deno.writeTextFileSync(composeFile, "services: {}\n");
  return { dir, envFile, composeFile };
}

Deno.test("dispatchProdAlias: status 调用 compose ps", async () => {
  const { dir } = makeProdDir();
  const log: string[][] = [];
  const code = await dispatchProdAlias("status", [], {
    cwd: dir,
    runner: recordingRunner(log),
  });
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("ps"), true);
});

Deno.test("dispatchProdAlias: 支持从目录外通过 --dir 指定生产目录", async () => {
  const { dir } = makeProdDir();
  const outside = Deno.makeTempDirSync();
  const log: string[][] = [];
  const code = await dispatchProdAlias("status", ["--dir", dir], {
    cwd: outside,
    runner: recordingRunner(log),
  });
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("ps"), true);
  assertEquals(log[0]!.includes("--dir"), false);
});

Deno.test("dispatchProdAlias: config check 调用 compose config", async () => {
  const { dir } = makeProdDir();
  const log: string[][] = [];
  const code = await dispatchProdAlias("config", ["check"], {
    cwd: dir,
    runner: recordingRunner(log),
  });
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("config"), true);
});

Deno.test("dispatchProdAlias: 非生产目录返回 1", async () => {
  const dir = Deno.makeTempDirSync();
  const code = await dispatchProdAlias("status", [], { cwd: dir });
  assertEquals(code, 1);
});
