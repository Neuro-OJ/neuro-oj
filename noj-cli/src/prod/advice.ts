/**
 * 非交互环境（TTY）检测与诊断（原 `init/non_interactive.ts`，T23 搬迁 + 文案改写）。
 *
 * 早先 `deploy init < /dev/null` 仍会进入交互向导：读不到输入 → 提示
 * 「输入无效，请重新选择」→ 无限循环空转（#517 E10）。CI/管道场景因此会挂住或刷屏。
 *
 * **T23 改写了文案**：原版的建议是「请预先手写 noj-deploy.json」——那个文件已随
 * 双模态一起删除。现在指向**唯一**的生产安装路径：
 * `noj-cli install`（它自己会拉 compose/example 并在 TTY 下进入配置向导）。
 *
 * 判定抽成纯函数（可注入 `isTty`）以便 `deno task test` 直接断言，不依赖真实终端。
 */

/** 交互式向导所需的最小输入集合。 */
export interface NonInteractiveAdvice {
  /** 检测到非交互环境且缺少必需参数时给出的提示。 */
  message: string;
}

/**
 * 判断当前是否应当拒绝进入交互向导。
 *
 * @param isTty 标准输入是否连接终端
 * @param hasMode 是否已通过显式参数给出必需配置（对应旧版的 `--mode`）
 * @returns 拒绝时的可操作提示；可以进入交互时返回 null
 */
export function nonInteractiveAdvice(
  isTty: boolean,
  hasMode: boolean,
): NonInteractiveAdvice | null {
  if (isTty) return null;
  // 非 TTY 下：即便给了必需参数，后续仍可能问端口/域名等，
  // 因此一律拒绝交互，并告诉用户如何补齐。
  if (hasMode) {
    return {
      message: "检测到非交互环境（标准输入不是终端）。\n" +
        "生产安装仍需交互确认（域名、端口、组件开关等），无法在非交互环境完成。\n" +
        "请在终端中直接运行 noj-cli install --dir <安装目录>，" +
        "或先用 --non-interactive 与显式环境变量补齐配置。",
    };
  }
  return {
    message: "检测到非交互环境（标准输入不是终端），无法进入交互向导。\n" +
      "请在终端中直接运行 noj-cli install --dir <安装目录>。",
  };
}
