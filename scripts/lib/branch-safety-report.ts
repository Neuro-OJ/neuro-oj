/**
 * 分支安全自检 · 文本报告。
 *
 * 入口脚本只负责解析参数与退出码；人类可读输出集中在这里，`--json` 直接序列化
 * 结果对象，不经过本模块。
 */

import type { CheckId, Finding } from "./branch-safety-checks.ts";
import type { PushedRunResult, RefRunResult } from "./branch-safety-pushed.ts";
import type { RunResult } from "./branch-safety-run.ts";

const SECTIONS: ReadonlyArray<{ id: CheckId; title: string; hint: string }> = [
  {
    id: "A",
    title: "A. 静默覆盖",
    hint: "目标分支分叉后改过、本分支也改过的文件",
  },
  {
    id: "B",
    title: "B. 断链引用",
    hint: "相对/别名导入与仓库内路径字面量",
  },
  { id: "C", title: "C. 提交签名", hint: "分叉后的提交必须 GPG 有效" },
  { id: "D", title: "D. 提交信息", hint: "<type>(<scope>): <描述>" },
];

function findingPlace(finding: Finding): string {
  if (finding.path === undefined) return finding.sha ?? "";
  return `${finding.path}${
    finding.line === undefined ? "" : `:${finding.line}`
  }`;
}

/** 按四个检查项分组渲染 findings（单分支与多引用共用）。 */
function renderSections(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const items = findings.filter((finding) => finding.check === section.id);
    lines.push(
      `${section.title}（${section.hint}）—— ${
        items.length === 0 ? "未发现问题" : `${items.length} 处`
      }`,
    );
    for (const finding of items) {
      const place = findingPlace(finding);
      lines.push(`  [${finding.level}]${place === "" ? "" : ` ${place}`}`);
      lines.push(`          ${finding.message}`);
      if (finding.detail !== undefined) {
        for (const detailLine of finding.detail.split("\n")) {
          lines.push(`          ${detailLine}`);
        }
      }
    }
    lines.push("");
  }
  return lines;
}

/** 渲染人类可读报告（全中文，与 scripts/ 下其他门禁风格一致）。 */
export function renderText(result: RunResult): string {
  const lines: string[] = [
    "分支安全自检",
    `  本分支：${result.branch} @ ${result.head}`,
    `  目标分支：${result.base} @ ${
      result.base_commit.slice(0, 12)
    }    分叉点：${result.merge_base.slice(0, 12)}`,
    `  扫描：本分支改动 ${result.stats.branch_files} 个文件；引用检查 ${result.stats.reference_files} 个文件（${result.stats.reference_count} 处引用）；目标分支分叉后 ${result.stats.base_commits} 个提交`,
    "",
    ...renderSections(result.findings),
  ];

  if (result.skipped.signatures) {
    lines.push("提示：已用 --ignore-signatures 跳过签名检查。");
  }
  lines.push(
    `汇总：error ${result.summary.error} / warn ${result.summary.warn} / info ${result.summary.info}`,
  );
  if (!result.ok) {
    lines.push("结果：失败（有 error）——修复后重新运行本脚本。");
  } else if (result.summary.warn > 0) {
    lines.push("结果：通过（无 error；上面的 warn 需要人工逐条确认）。");
  } else {
    lines.push("结果：通过。");
  }
  return lines.join("\n");
}

function renderRef(ref: RefRunResult): string[] {
  const lines: string[] = [
    `── ${ref.local_ref} → ${ref.remote_ref}`,
    ref.head === ""
      ? "   待检查提交：无法解析"
      : `   待检查提交：${ref.head}（待推送 ${ref.pushed_commits} 个提交；分叉点 ${
        ref.merge_base.slice(0, 12) || "无"
      }）`,
  ];
  if (ref.note !== undefined) lines.push(`   说明：${ref.note}`);
  if (ref.error !== undefined) {
    lines.push(`   [error] ${ref.error}`, "");
    return lines;
  }
  lines.push(
    `   扫描：本分支改动 ${ref.stats.branch_files} 个文件；引用检查 ${ref.stats.reference_files} 个文件（${ref.stats.reference_count} 处引用）`,
    "",
    ...renderSections(ref.findings),
    `   汇总：error ${ref.summary.error} / warn ${ref.summary.warn} / info ${ref.summary.info}`,
    "",
  );
  return lines;
}

/** 渲染 pre-push 多引用报告。 */
export function renderPushedText(result: PushedRunResult): string {
  const lines: string[] = [
    "分支安全自检（pre-push：逐个待推送引用）",
    `  目标分支：${result.base} @ ${result.base_commit.slice(0, 12)}`,
    `  待推送引用：${result.refs.length} 个`,
    "",
  ];
  for (const ref of result.refs) lines.push(...renderRef(ref));

  lines.push(
    `总计：error ${result.summary.error} / warn ${result.summary.warn} / info ${result.summary.info}`,
  );
  if (!result.ok) {
    lines.push("结果：失败（有 error）——修复后重新推送。");
  } else if (result.summary.warn > 0) {
    lines.push("结果：通过（无 error；上面的 warn 需要人工逐条确认）。");
  } else {
    lines.push("结果：通过。");
  }
  return lines.join("\n");
}
