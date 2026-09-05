/**
 * 注册提交流程（issue #425 / #426）。
 *
 * 从 pages/register.vue 抽出的纯流程逻辑，便于回归测试：
 * 注册失败 → 抛出原始错误；登录失败 → 引导手动登录；
 * 登录成功 → 按注册接口返回的 email_verification_sent 跳转验证页。
 * `sent` 必须覆盖整个提交流程作用域，避免未定义变量导致跳转回退。
 */

export interface RegisterFlowDeps {
  register: (
    username: string,
    email: string,
    password: string,
  ) => Promise<boolean>;
  login: (username: string, password: string) => Promise<unknown>;
}

export type RegisterFlowResult = {
  /** verified=邮件已发送；resend_needed=注册成功但邮件未发出；login_failed=自动登录失败 */
  status: 'verified' | 'resend_needed' | 'login_failed';
  /** 前端应执行 router.replace 的目标路径 */
  destination: string;
};

/**
 * 执行"注册 → 自动登录 → 跳转"流程。
 *
 * @returns 注册成功时的跳转结果；注册接口失败时返回 null（错误由调用方捕获提示）。
 */
export async function submitRegistration(
  deps: RegisterFlowDeps,
  username: string,
  email: string,
  password: string,
): Promise<RegisterFlowResult | null> {
  // 注册接口失败时错误向调用方传播，由页面统一提示
  const sent = await deps.register(username, email, password);

  try {
    await deps.login(username, password);
  } catch {
    // 注册成功但登录失败 → 引导用户手动登录
    return { status: 'login_failed', destination: '/login?registered=1' };
  }

  return {
    status: sent ? 'verified' : 'resend_needed',
    destination: `/verify-email?registered=1&sent=${sent ? '1' : '0'}`,
  };
}
