import { assertEquals } from "@std/assert";
import type { CommandRunner } from "../runtime/command.ts";
import { saveProdEnv } from "./env.ts";
import { prodInstall, prodUninstall, prodUpdate } from "./install.ts";

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

function makeOpts(envFile: string) {
  return {
    dir: "/opt/neuro-oj",
    envFile,
    composeFile: "/opt/neuro-oj/docker-compose.prod.yml",
  };
}

Deno.test("prodInstall: pull 后 up", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodInstall(makeOpts(envFile), recordingRunner(log));
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("pull"), true);
  assertEquals(log[1]!.includes("up"), true);
});

Deno.test("prodUpdate: 更新 NOJ_VERSION 并升级", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodUpdate(
    { ...makeOpts(envFile), version: "v0.2.0" },
    recordingRunner(log),
  );
  assertEquals(code, 0);
  assertEquals(
    Deno.readTextFileSync(envFile).includes("NOJ_VERSION=v0.2.0"),
    true,
  );
});

Deno.test("prodUninstall: 需要 --yes", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodUninstall(makeOpts(envFile), recordingRunner(log));
  assertEquals(code, 1);
  assertEquals(log.length, 0);
});

Deno.test("prodUninstall: --yes 调用 down", async () => {
  const dir = Deno.makeTempDirSync();
  const envFile = `${dir}/.env.prod`;
  saveProdEnv(envFile, fullEnv());
  const log: string[][] = [];
  const code = await prodUninstall(
    { ...makeOpts(envFile), yes: true, uninstallAll: true },
    recordingRunner(log),
  );
  assertEquals(code, 0);
  assertEquals(log[0]!.includes("down"), true);
  assertEquals(log[0]!.includes("--volumes"), true);
});
