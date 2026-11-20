import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { createSystemActor } from "../../runtime/index.ts";
import {
  guestActor,
  requireUserActor,
  userActorFromAuthenticatedId,
} from "../contracts/actor.ts";

Deno.test("access actor contract rejects missing user identities", () => {
  assertThrows(() => userActorFromAuthenticatedId("   "), TypeError);
  assertThrows(() => requireUserActor(guestActor()), TypeError);
  assertThrows(
    () => requireUserActor(createSystemActor("background_task")),
    TypeError,
  );
});

Deno.test("system actor purpose is explicit and immutable", () => {
  const actor = createSystemActor("bootstrap");
  assertEquals(actor, { kind: "system", purpose: "bootstrap" });
  assertThrows(() => {
    (actor as { purpose: string }).purpose = "background_task";
  }, TypeError);
});
