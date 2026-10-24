/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { Button, Result } from './components/primitives.tsx';
import { Toaster } from 'sonner';
import { Component, useEffect, useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell.tsx';
import { LegalConsent } from './components/LegalConsent.tsx';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { Problem } from './pages/Problem.tsx';
import { Problems } from './pages/Problems.tsx';
import { SubmissionDetail, Submissions } from './pages/Submissions.tsx';
import { Workspace } from './pages/Workspace.tsx';
import { StateProvider, useAppState } from './state.tsx';
import type { Bootstrap } from './types.ts';

function RequireAuth({ children }: PropsWithChildren) {
  const { user, authError, retryAuth } = useAppState();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);
  if (authError) {
    return (
      <Result
        status='warning'
        title='暂时无法验证登录状态'
        subTitle={authError.message}
        extra={
          <Button
            loading={retrying}
            onClick={() => {
              setRetrying(true);
              void retryAuth().finally(() => setRetrying(false));
            }}
          >
            重新验证
          </Button>
        }
      />
    );
  }
  if (!user) {
    return (
      <Navigate to={`/login?redirect=${encodeURIComponent(`/react${location.pathname}${location.search}`)}`} replace />
    );
  }
  return children;
}

class ErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <Result
          status='error'
          title='页面暂时无法显示'
          subTitle='请重新加载页面'
          extra={<Button href='/'>返回首页</Button>}
        />
      );
    }
    return this.props.children;
  }
}

function RouteContent() {
  const location = useLocation();
  const { user } = useAppState();
  useEffect(() => {
    const title = location.pathname.startsWith('/editor/')
      ? '代码工作区'
      : location.pathname.startsWith('/problems')
      ? '题库'
      : location.pathname.startsWith('/submissions')
      ? '提交记录'
      : location.pathname === '/login'
      ? '登录'
      : '首页';
    document.title = `${title} - Neuro OJ`;
    if (user?.must_change_password) globalThis.location.assign('/change-password');
  }, [location.pathname, user?.must_change_password]);
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path='login' element={<Login />} />
        <Route path='problems' element={<Problems />} />
        <Route path='problems/:id' element={<Problem />} />
        <Route
          path='editor/:id'
          element={
            <RequireAuth>
              <Workspace />
            </RequireAuth>
          }
        />
        <Route
          path='submissions'
          element={
            <RequireAuth>
              <Submissions />
            </RequireAuth>
          }
        />
        <Route path='submissions/:id' element={<SubmissionDetail />} />
        <Route path='*' element={<Result status='404' title='页面不存在' extra={<Link to='/'>返回首页</Link>} />} />
      </Route>
    </Routes>
  );
}

export function App({ bootstrap }: { bootstrap: Bootstrap }) {
  return (
    <StateProvider bootstrap={bootstrap}>
      <ErrorBoundary>
        <RouteContent />
        <LegalConsent />
      </ErrorBoundary>
      <Toaster
        theme='light'
        position='top-right'
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: 'inherit', borderRadius: '4px' } }}
      />
    </StateProvider>
  );
}
