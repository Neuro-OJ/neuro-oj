import { assertEquals } from "@std/assert";
import {
  DEPLOY_FILE,
  DEPLOY_FILE_MODE,
  SECRETS_FILE,
  SECRETS_FILE_MODE,
} from "./io.ts";

Deno.test("文件命名与权限常量", () => {
  assertEquals(DEPLOY_FILE, "noj-deploy.json");
  assertEquals(SECRETS_FILE, "noj-secrets.json");
  assertEquals(DEPLOY_FILE_MODE, 0o644);
  assertEquals(SECRETS_FILE_MODE, 0o600);
});
