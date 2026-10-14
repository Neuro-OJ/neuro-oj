/**
 * `noj-cli problem` 帮助文本（#514）。
 *
 * 独立文件以避免 `cli.ts` 与 `problem/command.ts` 的循环依赖。
 */
export function renderProblemHelp(): string {
  return [
    "用法: noj-cli problem <子命令> [选项]",
    "",
    "题目包管理：本地校验、打包与推送到平台，服务出题人的 TUI 引导与自动化两种模式。",
    "",
    "子命令:",
    "  init <slug>        生成题目骨架（默认 TUI 引导）",
    "  lint [dir]         本地离线校验（manifest + 结构 + 质量规则）",
    "  pack [dir]         纯 JS 打包（不依赖系统 zip 命令）",
    "  push <目标...>     推送到平台（目标为 目录/zip，或 目录/zip=题号 表示更新该题；只登录一次）",
    "",
    "init 选项:",
    "  --type U|P          题目归属（默认 P）",
    "  --judge-type dual|oi 评测模式（默认 dual；oi 为 C/C++ 传统 OI）",
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
    "push 选项:",
    "  --server <url>      平台地址（或环境变量 NOJ_SERVER）；非本机地址必须 HTTPS",
    "  --publish           导入后立即发布（默认保存为草稿）",
    "  --problem <题号>    单个题包时更新既有题目（等价于 目标=题号）",
    "  --no-interactive    缺少 NOJ_TOKEN 时直接失败，不提示登录",
    "  --json              机器可读输出",
    "  认证：优先使用环境变量 NOJ_TOKEN；未设置时在终端提示登录（密码不回显）",
    "",
    "退出码: 0 通过 / 1 校验失败 / 2 用法错误",
    "",
  ].join("\n");
}
