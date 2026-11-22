export interface ContestRegistrationOptions {
  isRegistering: () => boolean;
  setRegistering: (registering: boolean) => void;
  register: () => Promise<void>;
  onRegistered: () => void;
  refresh?: () => Promise<void>;
  onRefreshFailed?: (error: unknown) => void;
}

/**
 * 执行竞赛报名流程，区分报名请求与报名后的数据刷新。
 *
 * 报名请求成功后，刷新失败只能影响补偿性的页面同步，不能把已成功的报名重新判定为失败。
 */
export async function runContestRegistration(
  options: ContestRegistrationOptions,
): Promise<boolean> {
  if (options.isRegistering()) return false;

  options.setRegistering(true);
  try {
    await options.register();
    options.onRegistered();

    if (options.refresh) {
      try {
        await options.refresh();
      } catch (error) {
        options.onRefreshFailed?.(error);
      }
    }
    return true;
  } finally {
    options.setRegistering(false);
  }
}
