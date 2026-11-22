/**
 * 页面级登录守卫：认证状态就绪后仍未登录则跳转 /login。
 *
 * 与页面声明的 middleware: "auth" 职责互补（middleware 先行拦截，
 * 此处处理 middleware 未覆盖的异步场景），从重复的页面样板中抽取。
 */
export function useRequireLogin() {
  const { isLoggedIn, loading } = useAuth();
  const router = useRouter();
  watch(loading, (val) => {
    if (!val && !isLoggedIn.value) router.replace('/login');
  }, { immediate: true });
}
