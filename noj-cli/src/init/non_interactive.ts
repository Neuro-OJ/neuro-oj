/**
 * 非交互环境（TTY）检测与诊断（#517 E10）。
 *
 * 早先 `deploy init < /dev/null` 仍会进入交互向导：读不到输入 → 提示
 * 「输入无效，请重新选择」→ 无限循环空转。CI/管道场景因此会挂住或刷屏。
 *
 * 判定抽成纯函数（可注入 `isTty`）以便 `deno task test` 直接断言，
 * 不依赖真实终端。
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
 * @param hasMode 是否已通过 `--mode` 显式给出模式
 * @returns 拒绝时的可操作提示；可以进入交互时返回 null
 */
export function nonInteractiveAdvice(
  isTty: boolean,
  hasMode: boolean,
): NonInteractiveAdvice | null {
  if (isTty) return null;
  // 非 TTY 下：即便给了 --mode，后续仍会问端口/域名等，
  // 因此一律拒绝交互，并告诉用户如何补齐。
  if (hasMode) {
    return {
      message: "检测到非交互环境（标准输入不是终端）。\n" +
        "deploy init 仍需交互确认（域名、端口、组件开关等），无法在非交互环境完成。\n" +
        "请在终端中直接运行 noj-cli deploy init，或预先手写 noj-deploy.json。",
    };
  }
  return {
    message: "检测到非交互环境（标准输入不是终端），无法进入交互向导。\n" +
      "请在终端中直接运行 noj-cli deploy init，或预先手写 noj-deploy.json。",
  };
}
