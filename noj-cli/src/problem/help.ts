import {
  PROBLEM_TEMPLATE_DESCRIPTIONS,
  PROBLEM_TEMPLATE_NAMES,
} from "../../../noj-core/scripts/problem-templates.ts";

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
    "  pack [dir]         纯 JS 打包，输出格式 2（不依赖系统 zip 命令）",
    "  push [dir|zip]     通过 HTTP 导入目标域（默认草稿）",
    "  test [dir]         本地 Docker 沙箱验题：跑参考解答并断言得分（不连平台）",
    "  skill [dir]        把 AI 出题 Skill 写入出题仓库（.agents/skills 与 .claude/skills）",
    "  import --domain <slug> --dir <包目录>  透传给部署中的 core 容器",
    "  格式 1 仅接受 P 题包转换；新题包不含 type 分类。",
    "",
    "init 选项:",
    "  --judge-type dual|oi 评测模式（默认 dual；oi 为 C/C++ 传统 OI）",
    "  --template <name>   从可验题模板生成（含参考解答与断言，可直接 problem test）：",
    ...PROBLEM_TEMPLATE_NAMES.map((name) =>
      `                        ${name.padEnd(11)}${
        PROBLEM_TEMPLATE_DESCRIPTIONS[name]
      }`
    ),
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
    "  --server <url>      平台 HTTPS 地址（也可设置 NOJ_SERVER）",
    "  --domain <slug>     使用域，默认 main；不读取导航偏好",
    "  --publish           导入草稿后以返回的 revision 显式发布",
    "  --no-interactive    缺 NOJ_TOKEN 时不提示登录，直接报错",
    "  --json              机器可读输出",
    "",
    "test 选项:",
    "  --solution <path[@name]>  参考解答（可多个；缺省读取 submissions/ 目录）",
    "                      名称缺省为去扩展名的文件名；目录按 artifact zip 提交",
    "  --expect <断言>     分数断言（0-100，可多个）：good=100、wrong<60、partial>=50",
    "                      缺省读取 submissions/expect.json",
    "  --judge-bin <path>  noj-judge 二进制（缺省 NOJ_JUDGE_BIN，再缺省 PATH 上的 noj-judge）",
    "  --allow-network     允许 evaluator 联网（默认关闭；Solution 始终无网）",
    "  --network <name>    联网时使用的 Docker 网络（默认 bridge，需 --allow-network）",
    "  --no-llm-mock       LLM 题不使用离线 mock（默认 mock：SDK 回显最后一条 user 消息）",
    "  --llm-gateway <url> 使用真实 LLM 网关（需 --allow-network 与 --llm-token）",
    "  --llm-token <t>     真实网关的 eval_token",
    "  --json              机器可读输出",
    "",
    "skill 选项:",
    "  --force             已存在且内容不同时覆盖",
    "  --json              机器可读输出",
    "",
    "退出码: 0 通过 / 1 校验或断言失败 / 2 用法错误（含找不到 noj-judge）",
    "",
  ].join("\n");
}
