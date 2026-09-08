/** restore-drill 命令参数解析。 */

export interface RestoreDrillOptions {
  snapshot: string;
  envFile: string | undefined;
  composeFile: string | undefined;
  passphraseFile: string;
  projectName: string;
  drillDir: string | undefined;
  report: string | undefined;
  subnet: string;
  rpoMaxHours: number;
  rtoMaxMinutes: number;
  waitTimeout: number;
  skipJudge: boolean;
  keep: boolean;
}

export const DEFAULT_DRILL_PROJECT = "noj-drill";
export const DEFAULT_DRILL_SUBNET = "172.29.0.0/16";
export const DEFAULT_RPO_MAX_HOURS = 24;
export const DEFAULT_RTO_MAX_MINUTES = 60;
export const DEFAULT_WAIT_TIMEOUT = 300;

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function missing(flag: string): never {
  throw new Error(`restore-drill: ${flag} 缺少参数`);
}

function nonNegativeInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`restore-drill: ${flag} 必须是非负整数: ${value}`);
  }
  return n;
}

export function parseRestoreDrillArgs(args: string[]): RestoreDrillOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    throw new Error("restore-drill: 需要 SNAPSHOT 参数");
  }
  const out: RestoreDrillOptions = {
    snapshot: args[0]!,
    envFile: undefined,
    composeFile: undefined,
    passphraseFile: Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE") ?? "",
    projectName: DEFAULT_DRILL_PROJECT,
    drillDir: undefined,
    report: undefined,
    subnet: DEFAULT_DRILL_SUBNET,
    rpoMaxHours: DEFAULT_RPO_MAX_HOURS,
    rtoMaxMinutes: DEFAULT_RTO_MAX_MINUTES,
    waitTimeout: DEFAULT_WAIT_TIMEOUT,
    skipJudge: false,
    keep: false,
  };
  const take = (flag: string): string => {
    const idx = args.indexOf(flag);
    const value = args[idx + 1];
    if (idx === -1 || value === undefined || value.startsWith("--")) {
      throw missing(flag);
    }
    return value;
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--env-file=")) out.envFile = a.slice(11);
    else if (a === "--env-file") {
      out.envFile = take(a);
      i++;
    } else if (a.startsWith("--compose-file=")) out.composeFile = a.slice(15);
    else if (a === "--compose-file") {
      out.composeFile = take(a);
      i++;
    } else if (a.startsWith("--passphrase-file=")) {
      out.passphraseFile = a.slice(18);
    } else if (a === "--passphrase-file") {
      out.passphraseFile = take(a);
      i++;
    } else if (a.startsWith("--project-name=")) out.projectName = a.slice(15);
    else if (a === "--project-name") {
      out.projectName = take(a);
      i++;
    } else if (a.startsWith("--drill-dir=")) out.drillDir = a.slice(12);
    else if (a === "--drill-dir") {
      out.drillDir = take(a);
      i++;
    } else if (a.startsWith("--report=")) out.report = a.slice(9);
    else if (a === "--report") {
      out.report = take(a);
      i++;
    } else if (a.startsWith("--subnet=")) out.subnet = a.slice(9);
    else if (a === "--subnet") {
      out.subnet = take(a);
      i++;
    } else if (a.startsWith("--rpo-max-hours=")) {
      out.rpoMaxHours = nonNegativeInt(a.slice(16), "--rpo-max-hours");
    } else if (a === "--rpo-max-hours") {
      out.rpoMaxHours = nonNegativeInt(take(a), "--rpo-max-hours");
      i++;
    } else if (a.startsWith("--rto-max-minutes=")) {
      out.rtoMaxMinutes = nonNegativeInt(a.slice(18), "--rto-max-minutes");
    } else if (a === "--rto-max-minutes") {
      out.rtoMaxMinutes = nonNegativeInt(take(a), "--rto-max-minutes");
      i++;
    } else if (a.startsWith("--wait-timeout=")) {
      out.waitTimeout = nonNegativeInt(a.slice(15), "--wait-timeout");
    } else if (a === "--wait-timeout") {
      out.waitTimeout = nonNegativeInt(take(a), "--wait-timeout");
      i++;
    } else if (a === "--skip-judge") {
      out.skipJudge = true;
    } else if (a === "--keep") {
      out.keep = true;
    } else if (a === "-h" || a === "--help") {
      throw new Error("restore-drill --help");
    } else {
      throw new Error(`restore-drill: 未知选项: ${a}`);
    }
  }
  if (out.projectName.includes("prod")) {
    throw new Error("restore-drill: 演练项目名不得包含 prod");
  }
  if (!PROJECT_NAME_RE.test(out.projectName)) {
    throw new Error(
      "restore-drill: 演练项目名只能包含小写字母、数字、- 和 _",
    );
  }
  return out;
}
