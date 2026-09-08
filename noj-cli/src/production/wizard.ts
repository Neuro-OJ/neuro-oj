/** 生产首次安装交互向导。 */

import type { PromptIO } from "../tui/io.ts";
import { realIO } from "../tui/io.ts";
import { input, secretInput } from "../tui/widgets.ts";
import type { ProdInstallOptions } from "./install.ts";
import { saveProdEnv } from "./env.ts";

export async function prodInstallWizard(
  opts: ProdInstallOptions,
  io?: PromptIO,
): Promise<Record<string, string>> {
  const prompt = io ?? realIO();
  prompt.write("== 首次生产配置向导 ==\n");
  const values: Record<string, string> = {};
  values["NOJ_VERSION"] = await input(
    prompt,
    "NOJ_VERSION（已发布镜像版本，如 v0.1.0）",
    "v0.1.0",
  );
  values["DOMAIN"] = await input(
    prompt,
    "域名（如 oj.example.com）",
    "oj.neuro-oj.dev",
  );
  values["APP_URL"] = `https://${values["DOMAIN"]}`;
  values["CORS_ALLOWED_ORIGINS"] = values["APP_URL"];
  values["TRUSTED_PROXIES"] = await input(
    prompt,
    "TRUSTED_PROXIES（CIDR）",
    "172.28.0.0/16",
  );
  values["POSTGRES_USER"] = await input(prompt, "POSTGRES_USER", "noj");
  values["POSTGRES_DB"] = await input(prompt, "POSTGRES_DB", "noj");
  values["POSTGRES_PASSWORD"] = await secretInput(prompt, "POSTGRES_PASSWORD");
  values["REDIS_PASSWORD"] = await secretInput(prompt, "REDIS_PASSWORD");
  values["MINIO_ROOT_USER"] = await input(
    prompt,
    "MINIO_ROOT_USER",
    "minio-root",
  );
  values["MINIO_ROOT_PASSWORD"] = await secretInput(
    prompt,
    "MINIO_ROOT_PASSWORD",
  );
  values["S3_ACCESS_KEY"] = await secretInput(prompt, "S3_ACCESS_KEY");
  values["S3_SECRET_KEY"] = await secretInput(prompt, "S3_SECRET_KEY");
  values["S3_BUCKET"] = await input(
    prompt,
    "S3_BUCKET",
    "noj-support-packages",
  );
  values["JWT_SECRET"] = await secretInput(prompt, "JWT_SECRET（>=32 字符）");
  values["TFA_ENCRYPTION_KEY"] = await secretInput(
    prompt,
    "TFA_ENCRYPTION_KEY（>=32 字符）",
  );
  values["NOJ_LLM_SERVICE_TOKEN"] = await secretInput(
    prompt,
    "NOJ_LLM_SERVICE_TOKEN",
  );
  values["NOJ_LLM_STORE_KEY"] = await secretInput(prompt, "NOJ_LLM_STORE_KEY");
  values["ADMIN_EMAIL"] = await input(prompt, "ADMIN_EMAIL", "admin@noj.test");
  values["ADMIN_PASS"] = await secretInput(
    prompt,
    "ADMIN_PASS（至少 8 位含大小写数字）",
  );
  if (!opts.dryRun) {
    saveProdEnv(opts.envFile, values);
  }
  return values;
}
