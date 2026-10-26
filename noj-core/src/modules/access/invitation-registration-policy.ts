/** 邀请预览共用实例注册政策；有效邀请和签发者授权须由调用方先验证。 */
export function canRegisterWithInvitation(input: {
  allowRegister: boolean;
  emailConfigured: boolean;
  registrationMode: "open" | "invite" | "admin_only";
  allowDomainRegistrationInvites: boolean;
  domainInviter: boolean;
  platformAdmin: boolean;
}): boolean {
  return input.allowRegister && input.emailConfigured &&
    input.registrationMode !== "admin_only" &&
    (input.registrationMode === "open" || input.platformAdmin ||
      input.allowDomainRegistrationInvites && input.domainInviter);
}
