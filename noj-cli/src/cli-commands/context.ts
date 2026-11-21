// 命令上下文的共享类型：供 cli.ts 门面与 cli-commands/ 下的分发模块共同使用。

/**
 * CLI 执行上下文，供各子命令共享。
 *
 * 生产目录由 `findProductionDir()` 单独负责，不放在上下文里。
 */
export interface CommandContext {
    cwd: string;
}
