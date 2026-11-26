// 使用已安装的 VS Code，在独立 profile 与工作目录运行真实 Extension Host。
const { spawn } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const extension = path.resolve(__dirname, "..");
const root = mkdtempSync(path.join(tmpdir(), "noj-extension-host-"));
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
const report = path.join(root, "report.json");
const log = path.join(root, "host.log");
const args = [
  "--wait",
  "--new-window",
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-gpu",
  "--password-store=basic",
  `--user-data-dir=${path.join(root, "profile")}`,
  `--extensions-dir=${path.join(root, "extensions")}`,
  `--extensionDevelopmentPath=${extension}`,
  `--extensionTestsPath=${path.join(extension, "out/test/extension-host")}`,
  workspace,
];
console.log(`独立 Extension Host 验收目录：${root}`);
const child = spawn(process.env.NOJ_VSCODE_BINARY || "code", args, {
  env: { ...process.env, NOJ_EXTENSION_HOST_REPORT: report },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
const timer = setTimeout(() => {
  console.error("独立 Extension Host 超过 120 秒，验收失败。");
  child.kill("SIGTERM");
}, 120000);
child.on("error", (error) => {
  clearTimeout(timer);
  writeFileSync(log, output + error.message);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  clearTimeout(timer);
  writeFileSync(log, output);
  console.log(`宿主日志：${log}`);
  try {
    const result = JSON.parse(readFileSync(report, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = code === 0 && result.status === "passed" ? 0 : 1;
  } catch {
    console.error("宿主没有生成验收报告。请检查 host.log 和 profile/logs。");
    process.exitCode = 1;
  }
});
