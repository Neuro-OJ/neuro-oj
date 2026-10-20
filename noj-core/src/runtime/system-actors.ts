/**
 * 系统身份组合入口。
 *
 * 该文件属于 runtime/application composition。HTTP 路由和请求 body 不得
 * 导入此构造器；它们只能接收 app 在启动时绑定的窄能力。
 */
import type {
  SystemActor,
  SystemPurpose,
} from "../modules/access/contracts/actor.ts";

/** 仅由启动、迁移和受管后台任务创建系统身份。 */
export function createSystemActor(purpose: SystemPurpose): SystemActor {
  return Object.freeze({ kind: "system", purpose });
}
