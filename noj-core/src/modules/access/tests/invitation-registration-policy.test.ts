import { assertEquals } from "jsr:@std/assert@^1";
import { canRegisterWithInvitation } from "../invitation-registration-policy.ts";

Deno.test("邀请注册政策覆盖注册模式、签发者角色和全局禁用", () => {
  for (const registrationMode of ["open", "invite", "admin_only"] as const) {
    for (const allowDomainRegistrationInvites of [false, true]) {
      for (const domainInviter of [false, true]) {
        for (const platformAdmin of [false, true]) {
          for (const allowRegister of [false, true]) {
            for (const emailConfigured of [false, true]) {
              const input = {
                registrationMode,
                allowDomainRegistrationInvites,
                domainInviter,
                platformAdmin,
                allowRegister,
                emailConfigured,
              };
              const expected = !allowRegister || !emailConfigured
                ? false
                : registrationMode === "admin_only"
                ? false
                : registrationMode === "open"
                ? true
                : platformAdmin ||
                  allowDomainRegistrationInvites && domainInviter;
              assertEquals(
                canRegisterWithInvitation(input),
                expected,
                JSON.stringify(input),
              );
            }
          }
        }
      }
    }
  }
});
