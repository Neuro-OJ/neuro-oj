// 部署模式（profile）判定：命令与 profile 的相容性门禁、探测与 --profile 校验。

import { resolve } from "@std/path";
import { detectProfile, type ProfileName, realProfileFs } from "../profile.ts";
import { UsageError } from "../util/args.ts";

/**
 * 命令与 profile 的相容性门禁（T23 收敛后）。
 *
 * ## T23 的变化
 *
 * 此前有 `prod`/`stack` 两个 profile，故需要"命令属于哪个模式"的双向门禁。
 * T23 删掉 `stack` 模态后只剩**一个** profile，那些判定随之失去意义——继续保留
 * 会让一个已删除的模式以错误信息的形式"复活"（实测：`noj-cli deploy status`
 * 报的是"属于 JSON 编排模式，请改用 --profile stack"，而 stack 已不存在）。
 *
 * 现在只做一件事：**拒绝 `--profile stack`**（显式使用了已删除的模式时给出
 * 可操作提示，而不是静默忽略——静默忽略会让用户以为自己在用某个模式）。
 *
 * `--profile prod` 与不传 profile 都放行：前者是显式确认，后者是唯一模式。
 */
export function assertCommandAllowedInProfile(
  profile: ProfileName,
  command: string,
): void {
  if (profile !== "prod") {
    throw new UsageError(
      `--profile ${profile} 已不受支持：T23 起 noj-cli 收敛为单模态，` +
        `配置真相源唯一（.env.prod + docker-compose.prod.yml）。\n` +
        `  直接运行 noj-cli ${command}（可省略 --profile prod）。\n` +
        `  若目录里仍有 noj-deploy.json / noj-secrets.json，可直接删除。`,
    );
  }
}

/**
 * **不依赖** profile 判定的命令：纯工具/自描述命令。
 *
 * 这些命令在任意目录都应有意义（如 `version`、`problem lint`），
 * 若也要求探测成功，会让用户在普通目录下无法使用它们。
 */
export const PROFILE_AGNOSTIC = new Set([
  "version",
  "help",
  "problem",
  "problems",
  "doctor",
  "completions",
]);

/**
 * 自动探测 profile。
 *
 * **歧义或都无法识别时抛 {@link UsageError}**（#518 验收：失败必须报错，
 * 不得静默取默认值）——猜错模式会把命令作用到错误的目标。
 */
export function detectProfileOrNull(startDir?: string): ProfileName | null {
  // `--dir` 优先：它与 `--profile` 正交（issue #518），是既有的
  // 「在任意目录用 --dir 指定安装目录」逃生通道（README / 生产文档均推荐）。
  const start = startDir !== undefined
    ? resolve(Deno.cwd(), startDir)
    : Deno.cwd();
  const result = detectProfile({ start, ...realProfileFs() });
  if (result.profile === null) {
    throw new UsageError(result.error ?? "无法判定 profile");
  }
  return result.profile;
}

/** 校验 `--profile` 取值；未给出时返回 undefined（交由探测决定）。 */
export function validateProfileName(value?: string): ProfileName | undefined {
  if (value === undefined) return undefined;
  const result = detectProfile({
    explicit: value,
    start: Deno.cwd(),
    ...realProfileFs(),
  });
  if (result.profile === null) {
    throw new UsageError(result.error ?? `无效的 --profile: ${value}`);
  }
  return result.profile;
}

/** 分发选项（#518：profile 相关行为）。 */
export interface DispatchOptions {
  /** `--profile` 显式值；缺省时由探测决定。 */
  explicitProfile?: string;
  /** 由 `stack` 委派而来：不打印旧名废弃提示。 */
  stackAlias?: boolean;
}

/**
 * 解析 profile，失败时抛出 {@link UsageError}。
 *
 * `--profile` 与 `--dir` 正交：profile 定语法，`--dir` 定位置。
 */
export function resolveProfile(
  options: DispatchOptions,
  cwd: string,
): ProfileName {
  const result = detectProfile({
    explicit: options.explicitProfile,
    start: cwd,
    ...realProfileFs(),
  });
  if (result.profile === null) {
    throw new UsageError(result.error ?? "无法判定 profile");
  }
  return result.profile;
}
