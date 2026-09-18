/**
 * 退出码约定（#517 E9）。
 *
 * 放在独立文件以避免 `cli.ts` ↔ `problem/command.ts` 的循环依赖。
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
