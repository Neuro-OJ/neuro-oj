import type { DeployConfig, DeployState } from "../config/types.ts";
import { type DeployAction, transition } from "../state/machine.ts";

export interface StateResult {
  state: DeployState;
  changed: boolean;
  message: string;
}

/** 薄封装 P0 transition，判断命令是否 should no-op。 */
export function nextState(
  config: DeployConfig,
  action: DeployAction,
): StateResult {
  return transition(config.state, action);
}

/** 当前状态是否 running（up 应 no-op）。 */
export function upIsNoOp(config: DeployConfig): boolean {
  return nextState(config, "up").changed === false;
}

/** 当前状态是否 stopped（down 应 no-op）。 */
export function downIsNoOp(config: DeployConfig): boolean {
  return nextState(config, "down").changed === false;
}

/** 写回目标状态并落盘（更新 updated_at 为 UTC ISO）。 */
export async function writeState(
  config: DeployConfig,
  state: DeployState,
  save: (c: DeployConfig) => Promise<void>,
): Promise<void> {
  config.state = state;
  config.updated_at = new Date().toISOString();
  await save(config);
}
