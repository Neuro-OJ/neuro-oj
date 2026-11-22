/** `prod/cli*_test.ts` 共享的测试夹具：最小生产安装目录与目录指纹。 */

import { join } from "@std/path";

/** 造一个满足生产安装目录特征的最小目录。 */
export async function makeInstallDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "docker-compose.prod.yml"),
    "services: {}\n",
  );
  // 必须是一份**通过 checkRequiredValues** 的完整配置——否则原生实现会在
  // 前置校验阶段就返回，测试就测不到后面的 compose 调用。
  const HEX = "a".repeat(64);
  await Deno.writeTextFile(
    join(dir, ".env.prod"),
    [
      "NOJ_VERSION=v0.9.5",
      "DOMAIN=oj.test-oj.cn",
      "APP_URL=https://oj.test-oj.cn",
      "CORS_ALLOWED_ORIGINS=https://oj.test-oj.cn",
      "TRUSTED_PROXIES=172.28.0.0/16",
      `POSTGRES_PASSWORD=${HEX}`,
      `REDIS_PASSWORD=${HEX}`,
      "MINIO_ROOT_USER=nojminio123456",
      `MINIO_ROOT_PASSWORD=${HEX}`,
      "S3_ACCESS_KEY=nojs3123456",
      `S3_SECRET_KEY=${HEX}`,
      "S3_BUCKET=noj-support-packages",
      "S3_ENDPOINT=http://minio:9000",
      "STORAGE_PROVIDER=s3",
      `JWT_SECRET=${HEX}`,
      `TFA_ENCRYPTION_KEY=${HEX}`,
      `NOJ_LLM_SERVICE_TOKEN=${HEX}`,
      `NOJ_LLM_STORE_KEY=${HEX}`,
      "EMAIL_PROVIDER=disabled",
      "JUDGE_ENABLED=false",
      "NOJ_ENFORCE_IMAGE_SIGNATURES=false",
      "POSTGRES_USER=noj",
      "POSTGRES_DB=noj",
      "",
    ].join("\n"),
  );
  await Deno.chmod(join(dir, ".env.prod"), 0o600);
  return dir;
}

/** 目录指纹（清单 + 每项大小）：用于断言"零副作用"。 */
export async function dirFingerprint(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const st = await Deno.stat(join(dir, entry.name));
      out.push(`${entry.name}:${st.size}`);
    }
  } catch {
    return [];
  }
  return out.sort();
}
