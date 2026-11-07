import type { RenderIO } from "../../output/render.ts";
import { isJsonMode, renderStatus } from "../../output/render.ts";
import { createTheme } from "../../output/theme.ts";
import type { StatusKind } from "../../output/theme.ts";
import type { ColorMode } from "../../util/color.ts";
import { validateTargetDir } from "../bootstrap.ts";
import type { LifecycleBaseResult, LifecycleOptions } from "../lifecycle.ts";

/** 一次命令运行的上下文：目录 + 两个输出通道 + 状态行写出器。 */
export interface LifecycleContext {
  dir: string;
  io: RenderIO;
  jsonMode: boolean;
  /** 写一行状态（T8 符号 + 语义色），JSON 模式自动改道 stderr。 */
  status: (kind: StatusKind, text: string) => void;
  /** 写一条失败诊断：**永远 stderr**（对照 bash `fail` 的 >&2）。 */
  error: (text: string) => void;
}

/** 真实 stderr 写入（RenderIO 未注入 stderr 时的兜底）。 */
function realStderr(text: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(text));
}

/**
 * 写失败诊断到 stderr。
 *
 * bash `fail` 是 `printf ... >&2; exit 1`，而 T6 的 `emitHuman` 在人类模式写
 * **stdout**（只有 JSON 模式改道 stderr）——两者不能同时满足，故失败诊断显式
 * 走 stderr：这样重定向 `> out.txt` 时错误仍可见，`--json` 的 stdout 也不被污染。
 */
export function emitFailure(io: RenderIO, text: string): void {
  (io.stderr ?? realStderr)(text);
}

/** 构造命令上下文：T6 的 JSON 模式与 T8 的 stream 成对判定。 */
export function lifecycleContext(opts: LifecycleOptions): LifecycleContext {
  const jsonMode = isJsonMode(opts.args ?? []);
  const io: RenderIO = { ...(opts.io ?? {}), jsonMode };
  const stream: "stdout" | "stderr" = jsonMode ? "stderr" : "stdout";
  const theme = createTheme(opts.color ?? "auto", stream);
  return {
    dir: validateTargetDir(opts.dir),
    io,
    jsonMode,
    status: (kind, text) => {
      renderStatus(kind, text, {
        color: opts.color ?? ("auto" satisfies ColorMode),
        stream,
        io,
      });
    },
    error: (text) => emitFailure(io, theme.status("error", text) + "\n"),
  };
}

/** 生命周期结果的 `--json` 载荷（stdout 只含这一个 JSON 文档）。 */
export function jsonPayload(
  result: LifecycleBaseResult,
): Record<string, unknown> {
  return {
    dir: result.dir,
    state: result.state,
    noOp: result.noOp,
    error: result.error,
  };
}

/** 统一的运行失败结果（`error` 已写往人类通道）。 */
export function failed(
  dir: string,
  error: string,
): LifecycleBaseResult {
  return { dir, state: "error", noOp: false, exitCode: 1, error };
}
