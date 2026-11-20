/**
 * 退出码约定（#517 E9）。
 *
 * 放在独立文件，供 `problem/command.ts` 引用而不牵入整个分发层。
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
