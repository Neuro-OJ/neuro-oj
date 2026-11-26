import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  getSetting,
  hashSecret,
  maskSecret,
  registerSettingChangeHook,
  SECRET_MASK,
} from "../../../src/shared/config/system-settings.ts";
import {
  guestActor,
  isSystemActor,
  isUserActor,
  requireUserActor,
  userActorFromAuthenticatedId,
} from "../../../src/shared/access/actor.ts";
import { createSystemActor } from "../../../src/shared/access/system-actors.ts";

Deno.test("shared/access/actor: 身份构造与守卫行为一致", () => {
  const user = userActorFromAuthenticatedId(" 42 ");
  assertEquals(user.kind, "user");
  assertEquals(user.userId, "42");
  assertEquals(isUserActor(user), true);
  assertEquals(isSystemActor(user), false);
  assertEquals(requireUserActor(user), user);

  const guest = guestActor();
  assertEquals(isUserActor(guest), false);
  assertThrows(() => requireUserActor(guest), TypeError);
  assertThrows(() => userActorFromAuthenticatedId("   "), TypeError);

  const sys = createSystemActor("background_task");
  assertEquals(isSystemActor(sys), true);
  assertThrows(() => requireUserActor(sys), TypeError);
});

Deno.test("shared/config/system-settings: 脱敏、兜底与变更钩子注册/注销幂等", async () => {
  assertEquals(maskSecret(null), "");
  assertEquals(maskSecret(""), "");
  assertEquals(maskSecret("secret-token"), SECRET_MASK);

  const hashed = await hashSecret("jwt-secret-value");
  assertEquals(hashed.startsWith("sha256$"), true);
  assertEquals(hashed.length, "sha256$".length + 16);

  // 未注册环境变量时兜底到 registry default
  const allowReg = getSetting("allow_register");
  assertEquals(allowReg?.source, "default");
  assertEquals(allowReg?.value, true);

  const noopHook = async () => {};
  const dispose = registerSettingChangeHook("test_hook_key", noopHook);
  dispose();
});
