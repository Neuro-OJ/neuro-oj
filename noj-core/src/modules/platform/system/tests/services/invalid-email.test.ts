import { assertEquals } from "jsr:@std/assert@^1";
import { isInvalidEmailAddress } from "../../../../../shared/security/email-address.ts";
import {
  resetEmailProvider,
  sendEmailVerificationEmail,
  sendNotificationEmail,
  sendPasswordResetEmail,
  sendTestEmail,
} from "../../services/email.ts";
import { takeMockEmailsForTest } from "../../services/email-providers/mock.ts";

Deno.test("invalid-email: 只识别保留域名及其子域，大小写不敏感", () => {
  for (
    const email of [
      "student@invalid",
      "student@users.noj.invalid",
      "student@USERS.NOJ.INVALID",
      " student@users.noj.invalid. ",
    ]
  ) assertEquals(isInvalidEmailAddress(email), true);
  for (
    const email of [
      "student@invalid.com",
      "student@notinvalid",
      "student@invalid.example.com",
    ]
  ) assertEquals(isInvalidEmailAddress(email), false);
});

Deno.test("invalid-email: 所有发送入口在加载 Provider 前跳过，不发信也不报错", async () => {
  const previous = Deno.env.get("NOJ_ENV");
  Deno.env.set("NOJ_ENV", "production");
  resetEmailProvider();
  takeMockEmailsForTest();
  try {
    // 默认 mock 在生产环境必定抛错；占位邮箱应在读取配置和加载 Provider 前返回。
    const recipient = "student@users.noj.INVALID";
    await sendPasswordResetEmail(
      recipient,
      "https://noj.test/reset?token=secret",
    );
    assertEquals(
      await sendEmailVerificationEmail(
        recipient,
        "https://noj.test/verify?token=secret",
      ),
      false,
    );
    assertEquals(await sendTestEmail(recipient), false);
    assertEquals(
      await sendNotificationEmail(recipient, "通知", "<p>正文</p>"),
      false,
    );
    assertEquals(takeMockEmailsForTest(), []);
  } finally {
    if (previous === undefined) Deno.env.delete("NOJ_ENV");
    else Deno.env.set("NOJ_ENV", previous);
    resetEmailProvider();
  }
});
