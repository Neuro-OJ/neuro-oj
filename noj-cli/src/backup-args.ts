/**
 * `backup` 子命令的参数解析（纯函数）。
 *
 * 从 `cli.ts` 抽出（2026-09-23）：`cli.ts` 已登记单文件规模棘轮基线，本次修复在
 * `parseBackupArgs` 上新增了 `--dry-run` 等旗标，继续留在原文件会让它越过基线。
 * 本模块只做参数解析（零副作用），便于单测与复用。
 *
 * @module
 */

import { parseDirArg, UsageError } from "./util/args.ts";

export interface BackupArgs {
  sub: string;
  dir: string | undefined;
  backupDir: string | undefined;
  passphraseFile: string | undefined;
  zstdLevel: number;
  noEncrypt: boolean;
  confirm: boolean;
  includeDeployConfigs: boolean;
  snapshot: string | undefined;
  report: string | undefined;
  /** #515 P6：prune 保留最近 N 份。 */
  keep: number | undefined;
  /** #515 P6：prune 删除早于 N 天的备份。 */
  olderThanDays: number | undefined;
  /** #515 P6：prune 是否允许删除旧目录格式（默认否，防误删）。 */
  includeLegacy: boolean;
  /** #515 P6：机器可读输出（list/prune）。 */
  json: boolean;
  /** #516：跳过 Judge 验收。 */
  skipJudge: boolean;
  /** #516：演练子网。 */
  subnet: string | undefined;
  /** #516：演练 Compose 项目名。 */
  projectName: string | undefined;
  /** #516：RPO 上限（小时）。 */
  rpoMaxHours: number | undefined;
  /** #516：RTO 上限（分钟）。 */
  rtoMaxMinutes: number | undefined;
  /** #516：drill 保留演练环境（与 prune 的 --keep N 语义不同）。 */
  keepFlag: boolean;
  /** `backup restore --dry-run`：只规划并校验，零副作用。 */
  dryRun: boolean;
}

/** 解析 maintain backup 参数：子命令 + 位置参数 snapshot + 各旗标。 */
export function parseBackupArgs(args: string[]): BackupArgs {
  const out: BackupArgs = {
    sub: args[0] ?? "",
    dir: undefined,
    backupDir: undefined,
    passphraseFile: undefined,
    zstdLevel: 15,
    noEncrypt: false,
    confirm: false,
    includeDeployConfigs: false,
    snapshot: undefined,
    report: undefined,
    keep: undefined,
    olderThanDays: undefined,
    includeLegacy: false,
    json: false,
    skipJudge: false,
    subnet: undefined,
    projectName: undefined,
    rpoMaxHours: undefined,
    rtoMaxMinutes: undefined,
    keepFlag: false,
    dryRun: false,
  };
  const rest = args.slice(1);
  // `--dir` 统一解析（支持 `--dir=`，缺值报错）；下面的 switch 跳过它。
  out.dir = parseDirArg(rest);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dir" || a.startsWith("--dir=")) {
      if (a === "--dir") i++;
      continue;
    }
    const takeValue = (name: string): string => {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      i++;
      return value;
    };
    switch (a) {
      case "--backup-dir":
        out.backupDir = takeValue("--backup-dir");
        break;
      case "--passphrase-file":
        out.passphraseFile = takeValue("--passphrase-file");
        break;
      case "--zstd-level": {
        const raw = takeValue("--zstd-level");
        const level = Number(raw);
        if (!Number.isInteger(level) || level < 1 || level > 22) {
          throw new UsageError(
            `--zstd-level 需要一个 1-22 的整数，收到 "${raw}"`,
          );
        }
        out.zstdLevel = level;
        break;
      }
      case "--no-encrypt":
        out.noEncrypt = true;
        break;
      case "--confirm":
        out.confirm = true;
        break;
      case "--include-deploy-configs":
        out.includeDeployConfigs = true;
        break;
      case "--report":
        out.report = takeValue("--report");
        break;
      case "--keep": {
        // 两种语义（#515/#516），按**子命令**区分而非猜测下一个参数：
        // - prune：`--keep N` 保留最近 N 份（必须有值）；
        // - drill：裸 `--keep` 保留演练环境（bool，无值）。
        if (out.sub === "drill") {
          out.keepFlag = true;
          break;
        }
        // 注意：takeValue 已经把 i 推进到值上，**不可再 i++**
        // （否则会多跳一个 token，把下一个选项的值当成位置参数）。
        const raw = takeValue("--keep");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(`--keep 需要一个非负整数，收到 "${raw}"`);
        }
        out.keep = n;
        break;
      }
      case "--older-than": {
        const raw = takeValue("--older-than");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new UsageError(
            `--older-than 需要一个非负整数（天），收到 "${raw}"`,
          );
        }
        out.olderThanDays = n;
        break;
      }
      case "--include-legacy":
        // 旧目录格式承载存量数据，默认受保护（#515）
        out.includeLegacy = true;
        break;
      case "--skip-judge":
        // #516：无 Judge 部署时跳过相关验收
        out.skipJudge = true;
        break;
      case "--subnet":
        out.subnet = takeValue("--subnet");
        break;
      case "--project-name":
        out.projectName = takeValue("--project-name");
        break;
      case "--rpo-max-hours": {
        const raw = takeValue("--rpo-max-hours");
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new UsageError(`--rpo-max-hours 需要正整数，收到 "${raw}"`);
        }
        out.rpoMaxHours = n;
        break;
      }
      case "--rto-max-minutes": {
        const raw = takeValue("--rto-max-minutes");
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new UsageError(`--rto-max-minutes 需要正整数，收到 "${raw}"`);
        }
        out.rtoMaxMinutes = n;
        break;
      }
      case "--json":
        out.json = true;
        break;
      case "--dry-run":
        // **文档承诺的旗标**（`noj-cli/README.md` 与 CHANGELOG 的 `backup restore
        // --dry-run`）。此前它在 `UNIMPLEMENTED_PROD_FLAGS` 里被拒绝（退出码 2），
        // 于是照文档敲命令的用户拿到的是"用法错误"；而"省略 --confirm 即 dry-run"
        // 又不为文档读者所知。这里显式接受，并在 restore 分支按"只规划不执行"处理。
        out.dryRun = true;
        break;
      default:
        positional.push(a);
    }
  }
  out.snapshot = positional[0];
  return out;
}
