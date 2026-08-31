import type { PromptIO } from "../tui/io.ts";
import { confirm, input, secretInput, select } from "../tui/widgets.ts";
import type { SystemProbe } from "../doctor/probe.ts";
import { runDoctor } from "../doctor/doctor.ts";
import { formatReport } from "../doctor/report.ts";
import {
  devTemplate,
  prodTemplate,
  type ProdTemplateOptions,
} from "./templates.ts";
import { generateSecrets } from "./secrets.ts";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";

/** init 引导选项。 */
export interface InitOptions {
  mode?: "dev" | "prod";
  port?: number;
  installDir: string;
}

/** 引导 dev 模式：组件开关、端口、数据目录。 */
async function guideDev(
  io: PromptIO,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const port = Number(await input(io, "对外端口", String(opts.port ?? 8080)));
  const dataDir = await input(io, "数据目录", `${opts.installDir}/data`);
  const config = devTemplate(opts.installDir, port);
  config.env["DATA_DIR"] = dataDir;
  const secrets = generateSecrets("dev");
  return { config, secrets };
}

/** 引导 prod 模式：域名、HTTPS、端口、Judge、邮件、反向代理。 */
async function guideProd(
  io: PromptIO,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const domain = await input(io, "网站地址（域名）", "oj.example.com");
  const https = await confirm(io, "启用 HTTPS", true);
  const port = Number(await input(io, "对外端口", String(opts.port ?? 8080)));
  const judgeEnabled = await confirm(io, "启用 Judge 评测组件", false);
  const emailIdx = await select(io, "邮件服务", ["disabled", "smtp"]);
  const emailProvider = emailIdx === 0 ? "disabled" : "smtp";
  const tplOpts: ProdTemplateOptions = {
    installDir: opts.installDir,
    domain,
    https,
    port,
    judgeEnabled,
    emailProvider,
  };
  const config = prodTemplate(tplOpts);
  const secrets = generateSecrets("prod");
  return { config, secrets };
}

/** 运行 deploy init 引导，返回待落盘的配置与密钥。 */
export async function runInitWizard(
  io: PromptIO,
  probe: SystemProbe,
  opts: InitOptions,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  io.write("=== noj-cli deploy init ===\n");

  let mode = opts.mode;
  if (mode === undefined) {
    const idx = await select(io, "选择部署模式", [
      "dev（开发）",
      "prod（生产）",
    ]);
    mode = idx === 0 ? "dev" : "prod";
  }

  // 自动运行 doctor 环境检测，彩色清单展示（不阻断）。
  const report = await runDoctor(probe, {
    port: opts.port ?? 8080,
    installDir: opts.installDir,
  });
  io.write(formatReport(report) + "\n");

  const result = mode === "dev"
    ? await guideDev(io, opts)
    : await guideProd(io, opts);

  io.write("=== 配置摘要 ===\n");
  io.write(`模式: ${result.config.type}\n`);
  io.write(`安装目录: ${result.config.install_dir}\n`);
  io.write(`组件: ${Object.keys(result.config.components).join(", ")}\n`);

  const ok = await confirm(io, "确认写入配置", true);
  if (!ok) {
    throw new Error("用户取消，未写入配置");
  }
  return result;
}
