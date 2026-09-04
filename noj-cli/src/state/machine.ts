import type { DeployState } from "../config/types.ts";

export type DeployAction = "init" | "up" | "down" | "restart" | "reset";

export interface TransitionResult {
  state: DeployState;
  /** 状态是否发生变化；false 表示 no-op（如 running 时再 up）。 */
  changed: boolean;
  message: string;
}

const NO_OP_MSG: Record<string, string> = {
  up: "已处于 running，无需重复启动",
  down: "已处于 stopped，无需重复关闭",
};

export function transition(
  state: DeployState,
  action: DeployAction,
): TransitionResult {
  let next: DeployState;
  let changed = true;

  switch (action) {
    case "init":
      next = "stopped";
      break;
    case "up":
      if (state === "running") {
        next = "running";
        changed = false;
      } else {
        next = "running";
      }
      break;
    case "down":
      if (state === "stopped") {
        next = "stopped";
        changed = false;
      } else {
        next = "stopped";
      }
      break;
    case "restart":
      next = "running";
      break;
    case "reset":
      next = "stopped";
      break;
  }

  return {
    state: next,
    changed,
    message: changed
      ? `状态从 ${state} 转换为 ${next}`
      : (NO_OP_MSG[action] ?? `状态保持 ${next}`),
  };
}
