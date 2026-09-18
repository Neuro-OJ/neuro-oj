/**
 * `noj-cli problem` 帮助文本（#514）。
 *
 * 独立文件以避免 `cli.ts` 与 `problem/command.ts` 的循环依赖。
 */
export function renderProblemHelp(): string {
  return [
    "用法: noj-cli problem <子命令> [选项]",
    "",
    "题目包管理：本地离线校验与打包，服务出题人的 TUI 引导与自动化两种模式。",
    "",
    "子命令:",
    "  init <slug>        生成题目骨架（默认 TUI 引导）",
    "  lint [dir]         本地离线校验（manifest + 结构 + 质量规则）",
    "  pack [dir]         纯 JS 打包（不依赖系统 zip 命令）",
    "",
    "init 选项:",
    "  --type U|P          题目归属（默认 P）",
    "  --difficulty <d>    easy / medium / hard（默认 medium）",
    "  --title <t>         题目标题（默认同 slug）",
    "  --no-interactive    跳过 TUI 引导（自动化）",
    "",
    "lint 选项:",
    "  --strict            SHOULD 层警告也计入退出码",
    "  --json              机器可读输出",
    "",
    "pack 选项:",
    "  --out <dir>         输出目录（默认 ../packages）",
    "  --json              机器可读输出",
    "",
    "退出码: 0 通过 / 1 校验失败 / 2 用法错误",
    "",
  ].join("\n");
}
