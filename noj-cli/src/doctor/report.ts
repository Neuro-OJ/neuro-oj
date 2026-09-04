import type { DoctorReport } from "./doctor.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** 将检测报告格式化为 ANSI 彩色清单。 */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = ["环境检测结果:"];
  for (const c of report.checks) {
    let mark: string;
    if (!c.ok) {
      mark = `${RED}[失败]${RESET}`;
    } else if (c.severity === "warning") {
      mark = `${YELLOW}[告警]${RESET}`;
    } else {
      mark = `${GREEN}[通过]${RESET}`;
    }
    lines.push(`  ${mark} ${c.name}: ${c.detail}`);
  }
  lines.push(
    report.failed
      ? `${RED}检测未通过，存在失败项。${RESET}`
      : `${GREEN}检测通过。${RESET}`,
  );
  return lines.join("\n");
}
