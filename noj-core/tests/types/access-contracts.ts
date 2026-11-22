/**
 * P3 access 合同编译期负例。
 *
 * 该文件只在正式 `check:types` 中检查，不作为运行时测试执行。它直接调用
 * 生产的 `addDomainMemberTx` 与 application command；如果生产签名意外放宽，
 * `@ts-expect-error` 会使类型检查失败。
 */
import type { DbRoot, DbTx } from "../../src/shared/db/executor.ts";
import type {
  SystemActor,
  UserActor,
} from "../../src/modules/access/contracts/actor.ts";
import { addDomainMemberTx } from "../../src/modules/access/members.ts";
import {
  adminDeleteAccountCommand,
  createDomainCommand,
  removeDomainMemberCommand,
  updateDomainCommand,
} from "../../src/modules/application/access.ts";

declare const root: DbRoot;
declare const tx: DbTx;
declare const user: UserActor;
declare const system: SystemActor;

function compileAccessContracts(): void {
  void addDomainMemberTx(tx, user, "domain", "user");

  // @ts-expect-error 根连接不能冒充原子事务句柄
  void addDomainMemberTx(root, user, "domain", "user");
  // @ts-expect-error 原子 helper 不接受 undefined 执行器
  void addDomainMemberTx(undefined, user, "domain", "user");
  // @ts-expect-error 普通用户写用例不能接受系统身份
  void addDomainMemberTx(tx, system, "domain", "user");

  void createDomainCommand(user, {
    slug: "typed-domain",
    name: "typed domain",
    preset: "community",
  });
  // @ts-expect-error 普通用户 application command 不能接受系统身份
  void createDomainCommand(system, {
    slug: "typed-domain",
    name: "typed domain",
    preset: "community",
  });
  // @ts-expect-error 公开写用例必须显式传入操作者
  void createDomainCommand();

  // @ts-expect-error 普通用户 application command 不能接受系统身份
  void updateDomainCommand(system, "domain", 0, { name: "renamed" });
  // @ts-expect-error 普通用户 application command 不能接受系统身份
  void removeDomainMemberCommand(system, "domain", "target");
  // @ts-expect-error 账户注销必须携带成员清理与提交后副作用边界
  void adminDeleteAccountCommand(user, "target");
}

void compileAccessContracts;
