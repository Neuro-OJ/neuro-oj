export const DEFAULT_JUDGE_DIR = "/srv/noj-judge";
export const DEFAULT_JUDGE_REPO = "https://github.com/Neuro-OJ/neuro-oj";
export const DEFAULT_JUDGE_REF = "main";
export const DEFAULT_REDIS_CONTAINER = "noj-judge-redis";
export const DEFAULT_REDIS_PORT = 16379;

export interface JudgeOptions {
  command:
    | "install"
    | "install-env"
    | "check"
    | "start"
    | "stop"
    | "status"
    | "logs"
    | "upgrade"
    | "download";
  dir: string;
  envFile: string;
  composeFile: string;
  repo: string;
  ref: string;
  version: string | undefined;
  redisContainer: string;
  redisPort: number;
  panel: "auto" | "baota" | "none";
  nonInteractive: boolean;
  downloadOnly: boolean;
  dryRun: boolean;
  follow: boolean;
}

const COMMANDS = new Set([
  "install",
  "install-env",
  "check",
  "start",
  "stop",
  "status",
  "logs",
  "upgrade",
  "download",
]);

export function parseJudgeArgs(args: string[]): JudgeOptions {
  const out: JudgeOptions = {
    command: "check",
    dir: DEFAULT_JUDGE_DIR,
    envFile: "",
    composeFile: "",
    repo: DEFAULT_JUDGE_REPO,
    ref: DEFAULT_JUDGE_REF,
    version: undefined,
    redisContainer: DEFAULT_REDIS_CONTAINER,
    redisPort: DEFAULT_REDIS_PORT,
    panel: "auto",
    nonInteractive: false,
    downloadOnly: false,
    dryRun: false,
    follow: false,
  };
  let commandSet = false;
  const takeValue = (flag: string): string => {
    const i = args.indexOf(flag);
    if (i === -1) throw new Error(`judge: ${flag} 缺少参数`);
    const value = args[i + 1];
    if (value === undefined) throw new Error(`judge: ${flag} 缺少参数`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (COMMANDS.has(a) && !commandSet) {
      out.command = a as JudgeOptions["command"];
      commandSet = true;
      continue;
    }
    if (a.startsWith("--dir=")) {
      out.dir = a.slice(6);
    } else if (a === "--dir") {
      out.dir = takeValue(a);
      i++;
    } else if (a.startsWith("--env-file=")) {
      out.envFile = a.slice(11);
    } else if (a === "--env-file") {
      out.envFile = takeValue(a);
      i++;
    } else if (a.startsWith("--compose-file=")) {
      out.composeFile = a.slice(15);
    } else if (a === "--compose-file") {
      out.composeFile = takeValue(a);
      i++;
    } else if (a.startsWith("--repo=")) {
      out.repo = a.slice(7);
    } else if (a === "--repo") {
      out.repo = takeValue(a);
      i++;
    } else if (a.startsWith("--ref=")) {
      out.ref = a.slice(6);
    } else if (a === "--ref") {
      out.ref = takeValue(a);
      i++;
    } else if (a.startsWith("--version=")) {
      out.version = a.slice(10);
    } else if (a === "--version") {
      out.version = takeValue(a);
      i++;
    } else if (a.startsWith("--redis-container=")) {
      out.redisContainer = a.slice(18);
    } else if (a === "--redis-container") {
      out.redisContainer = takeValue(a);
      i++;
    } else if (a.startsWith("--redis-port=")) {
      out.redisPort = Number(a.slice(13));
    } else if (a === "--redis-port") {
      out.redisPort = Number(takeValue(a));
      i++;
    } else if (a.startsWith("--panel=")) {
      out.panel = a.slice(8) as JudgeOptions["panel"];
    } else if (a === "--panel") {
      out.panel = takeValue(a) as JudgeOptions["panel"];
      i++;
    } else if (a === "--non-interactive") {
      out.nonInteractive = true;
    } else if (a === "--download-only") {
      out.downloadOnly = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--follow" || a === "-f") {
      out.follow = true;
    } else if (a === "--help" || a === "-h") {
      throw new Error("judge --help");
    } else {
      throw new Error(`未知 judge 参数: ${a}`);
    }
  }
  if (!commandSet) throw new Error("judge: 需要子命令");
  if (out.panel !== "auto" && out.panel !== "baota" && out.panel !== "none") {
    throw new Error(`judge: 非法 panel 模式: ${out.panel}`);
  }
  if (out.envFile === "") out.envFile = `${out.dir}/.env.judge`;
  if (out.composeFile === "") {
    out.composeFile = `${out.dir}/docker-compose.judge.yml`;
  }
  return out;
}
