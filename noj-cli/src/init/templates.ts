import type { ComponentConfig, DeployConfig } from "../config/types.ts";
import { SCHEMA_VERSION } from "../config/types.ts";

function baseConfig(type: "dev" | "prod", installDir: string): DeployConfig {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    type,
    state: "stopped",
    created_at: now,
    updated_at: now,
    install_dir: installDir,
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {
      LOG_LEVEL: "info",
      LOG_FORMAT: "json",
    },
    components: {},
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "localhost",
      upstream_port: 8080,
    },
  };
}

function dockerComponent(
  partial: Partial<ComponentConfig> & { image: string },
): ComponentConfig {
  return { enabled: true, method: "docker", env: {}, ...partial };
}

/** dev 模式模板：基础设施走 docker，server/ui 走本地进程。 */
export function devTemplate(installDir: string, port: number): DeployConfig {
  const cfg = baseConfig("dev", installDir);
  cfg.env["PORT"] = String(port);
  cfg.components = {
    postgres: dockerComponent({
      image: "postgres:16-alpine",
      internal_port: 5432,
      host_port: null,
      env: { POSTGRES_USER: "noj", POSTGRES_DB: "noj" },
    }),
    redis: dockerComponent({
      image: "redis:7-alpine",
      internal_port: 6379,
      host_port: null,
      env: {},
    }),
    minio: dockerComponent({
      image: "minio/minio:latest",
      api_port: 9000,
      console_port: 9001,
      host_api_port: null,
      host_console_port: null,
      env: {},
    }),
    server: {
      enabled: true,
      method: "process",
      binary: "noj-server",
      port: 8000,
      host_port: null,
      env: {
        NOJ_ENV: "development",
        PORT: "8000",
        DATABASE_URL:
          "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}",
        REDIS_URL: "redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0",
        JWT_SECRET: "${JWT_SECRET}",
        TFA_ENCRYPTION_KEY: "${TFA_ENCRYPTION_KEY}",
      },
    },
    ui: {
      enabled: true,
      method: "process",
      dev_command: "deno task dev",
      port: 3000,
      host_port: null,
      env: {
        NUXT_API_BASE: "http://127.0.0.1:8000",
        NUXT_NOJ_ENV: "development",
        PORT: "3000",
      },
    },
    llm_gateway: {
      enabled: true,
      method: "process",
      port: 8001,
      host_port: null,
      env: {
        NOJ_LLM_PORT: "8001",
        NOJ_LLM_SERVICE_TOKEN: "${NOJ_LLM_SERVICE_TOKEN}",
        NOJ_LLM_STORE_KEY: "${NOJ_LLM_STORE_KEY}",
      },
    },
    judge: {
      enabled: false,
      method: "docker",
      image: "ghcr.io/neuro-oj/noj-judge:0.1.0",
      env: {},
    },
    nginx: {
      enabled: false,
      method: "docker",
      image: "nginx:1.27-alpine",
      port: 8080,
      host_port: port,
      env: {},
    },
  };
  return cfg;
}

/** prod 模板选项。 */
export interface ProdTemplateOptions {
  installDir: string;
  domain: string;
  https: boolean;
  port: number;
  judgeEnabled: boolean;
  emailProvider: "disabled" | "smtp";
}

/** prod 模式模板：全部走 docker，nginx 启用。 */
export function prodTemplate(opts: ProdTemplateOptions): DeployConfig {
  const cfg = baseConfig("prod", opts.installDir);
  const scheme = opts.https ? "https" : "http";
  cfg.env = {
    ...cfg.env,
    DOMAIN: opts.domain,
    APP_URL: `${scheme}://${opts.domain}`,
    CORS_ALLOWED_ORIGINS: `${scheme}://${opts.domain}`,
    TRUSTED_PROXIES: "172.28.0.0/16",
    NOJ_ALLOW_INSECURE_HTTP: String(!opts.https),
    NGINX_PORT: String(opts.port),
    STORAGE_PROVIDER: "s3",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "noj-support-packages",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
    EMAIL_PROVIDER: opts.emailProvider,
    JUDGE_IMAGE_BASE: "ghcr.io/neuro-oj/",
    JUDGE_ALLOW_EVALUATOR_NETWORK: "false",
    JUDGE_EVALUATOR_NETWORK: "noj-net",
    JUDGE_ALLOW_HTTP_S3: "true",
  };
  cfg.reverse_proxy = {
    type: "nginx",
    config_dir: "/etc/nginx/conf.d",
    domain: opts.domain,
    upstream_port: opts.port,
  };
  cfg.components = {
    postgres: dockerComponent({
      image: "postgres:16-alpine",
      internal_port: 5432,
      host_port: null,
      env: { POSTGRES_USER: "noj", POSTGRES_DB: "noj" },
    }),
    redis: dockerComponent({
      image: "redis:7-alpine",
      internal_port: 6379,
      host_port: null,
      env: {},
    }),
    minio: dockerComponent({
      image: "minio/minio:latest",
      api_port: 9000,
      console_port: 9001,
      host_api_port: null,
      host_console_port: null,
      env: {},
    }),
    server: dockerComponent({
      image: "ghcr.io/neuro-oj/noj-server:0.1.0",
      port: 8000,
      host_port: null,
      env: {
        NOJ_ENV: "production",
        PORT: "8000",
        DATABASE_URL:
          "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}",
        REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0",
        JWT_SECRET: "${JWT_SECRET}",
        TFA_ENCRYPTION_KEY: "${TFA_ENCRYPTION_KEY}",
        S3_ACCESS_KEY: "${S3_ACCESS_KEY}",
        S3_SECRET_KEY: "${S3_SECRET_KEY}",
      },
    }),
    ui: dockerComponent({
      image: "ghcr.io/neuro-oj/noj-ui:0.1.0",
      port: 3000,
      host_port: null,
      env: {
        NUXT_API_BASE: "http://server:8000",
        NUXT_NOJ_ENV: "production",
        NODE_ENV: "production",
        PORT: "3000",
      },
    }),
    llm_gateway: dockerComponent({
      image: "ghcr.io/neuro-oj/noj-llm-gateway:0.1.0",
      port: 8001,
      host_port: null,
      env: {
        NOJ_LLM_PORT: "8001",
        NOJ_LLM_SERVICE_TOKEN: "${NOJ_LLM_SERVICE_TOKEN}",
        NOJ_LLM_STORE_KEY: "${NOJ_LLM_STORE_KEY}",
      },
    }),
    judge: dockerComponent({
      image: "ghcr.io/neuro-oj/noj-judge:0.1.0",
      enabled: opts.judgeEnabled,
      env: {
        REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0",
        JUDGE_QUEUE: "noj:judge:queue",
        RESULT_QUEUE: "noj:judge:results",
        JUDGE_MAX_CONCURRENT_JUDGES: "2",
      },
    }),
    nginx: dockerComponent({
      image: "nginx:1.27-alpine",
      port: 8080,
      host_port: opts.port,
      env: {},
    }),
  };
  return cfg;
}
