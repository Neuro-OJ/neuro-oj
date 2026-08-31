/** 配置 schema 版本号。 */
export const SCHEMA_VERSION = 1;

/** 部署状态机的所有合法状态。 */
export type DeployState =
  | "uninitialized"
  | "stopped"
  | "running"
  | "partial"
  | "error";

/** 反向代理配置。 */
export interface ReverseProxyConfig {
  type: "nginx";
  config_dir: string;
  domain: string;
  upstream_port: number;
}

/** 单个组件的配置。不同组件使用不同的字段子集，全部字段可选除 enabled/method/env。 */
export interface ComponentConfig {
  enabled: boolean;
  method: "docker" | "process";
  image?: string;
  binary?: string | null;
  command?: string;
  internal_port?: number;
  host_port?: number | null;
  host_api_port?: number | null;
  host_console_port?: number | null;
  api_port?: number;
  console_port?: number;
  port?: number;
  docker_socket?: string;
  docker_socket_gid?: number;
  queue?: string;
  result_queue?: string;
  max_concurrent?: number;
  dev_command?: string | null;
  env: Record<string, string>;
}

/** 部署元数据（非敏感，对应 noj-deploy.json，权限 644）。 */
export interface DeployConfig {
  schema_version: number;
  type: "dev" | "prod";
  state: DeployState;
  created_at: string;
  updated_at: string;
  install_dir: string;
  version: { noj_cli: string; noj_server: string };
  env: Record<string, string>;
  components: Record<string, ComponentConfig>;
  reverse_proxy: ReverseProxyConfig;
}

/** 敏感配置（对应 noj-secrets.json，权限 600）。 */
export interface SecretsConfig {
  schema_version: number;
  created_at: string;
  updated_at: string;
  secrets: Record<string, string>;
}
