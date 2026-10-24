/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Input, Space } from '../components/primitives.tsx';
import { Label } from '../components/ui/label.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { errorInfo, loginPayload } from '../api.ts';
import { safeRedirect } from '../routes.ts';
import { useAppState, useResource } from '../state.tsx';
import type { User } from '../types.ts';

export function Login() {
  const { api, user, setUser, retryAuth } = useAppState();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tfa, setTfa] = useState(false);
  const [credentials, setCredentials] = useState({ login: '', password: '', code: '', remember: false });
  const codeInput = useRef<HTMLInputElement>(null);
  const providers = useResource<{ data: { id: string; name: string }[] }>('/api/v1/auth/oauth/providers');
  const target = safeRedirect(params.get('redirect'));
  useEffect(() => {
    if (tfa) codeInput.current?.focus();
  }, [tfa]);
  function finish(destination: string) {
    if (destination === '/react' || destination.startsWith('/react/')) {
      navigate(destination.replace(/^\/react/, '') || '/', { replace: true });
    } else globalThis.location.assign(destination);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const response = await api.post<{ data: { user: User } }>('/api/v1/auth/login', loginPayload(credentials), {
        silent: true,
        timeout: 8000,
      });
      setUser(response.data.user);
      void retryAuth();
      setCredentials({ login: '', password: '', code: '', remember: false });
      if (response.data.user.must_change_password) globalThis.location.assign('/change-password');
      else finish(target);
    } catch (caught) {
      const info = errorInfo(caught);
      if (info.code === 'TFA_REQUIRED') {
        setTfa(true);
        setError('');
      } else setError(info.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className='mx-auto max-w-[420px] py-6 md:py-12'>
      <Card title={<h1 className='text-xl font-semibold'>{tfa ? '两步验证' : '登录'}</h1>}>
        {user
          ? (
            <Space orientation='vertical'>
              <Alert type='success' title={`已登录为 ${user.username}`} />
              <Button variant='default' block onClick={() => finish(target)}>继续</Button>
            </Space>
          )
          : (
            <>
              {error && (
                <div className='mb-5'>
                  <Alert type='error' title={error} />
                </div>
              )}
              {tfa && (
                <div className='mb-5'>
                  <Alert title='输入身份验证器中的动态码，或使用恢复码。' />
                </div>
              )}
              <form onSubmit={(event) => void submit(event)} className='space-y-5'>
                <div hidden={tfa} className='space-y-5'>
                  <div className='space-y-2'>
                    <Label htmlFor='react-login-login'>用户名或邮箱</Label>
                    <Input
                      id='react-login-login'
                      autoComplete='username'
                      required
                      disabled={loading}
                      value={credentials.login}
                      onChange={(event) => setCredentials((previous) => ({ ...previous, login: event.target.value }))}
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label htmlFor='react-login-password'>密码</Label>
                    <Input
                      id='react-login-password'
                      type='password'
                      autoComplete='current-password'
                      required
                      disabled={loading}
                      value={credentials.password}
                      onChange={(event) =>
                        setCredentials((previous) => ({ ...previous, password: event.target.value }))}
                    />
                  </div>
                  <div className='flex items-center gap-2'>
                    <Checkbox
                      id='react-login-remember'
                      checked={credentials.remember}
                      disabled={loading}
                      onCheckedChange={(value) =>
                        setCredentials((previous) => ({ ...previous, remember: value === true }))}
                    />
                    <Label htmlFor='react-login-remember'>记住我</Label>
                  </div>
                </div>
                {tfa && (
                  <div className='space-y-2'>
                    <Label htmlFor='react-login-code'>动态码或恢复码</Label>
                    <Input
                      ref={codeInput}
                      id='react-login-code'
                      autoComplete='one-time-code'
                      required
                      disabled={loading}
                      value={credentials.code}
                      onChange={(event) => setCredentials((previous) => ({ ...previous, code: event.target.value }))}
                    />
                  </div>
                )}
                <Button
                  variant='default'
                  type='submit'
                  block
                  loading={loading}
                  aria-label={tfa ? '验证并登录' : '登录'}
                >
                  {tfa ? '验证并登录' : '登录'}
                </Button>
                {tfa && (
                  <Button
                    block
                    disabled={loading}
                    onClick={() => {
                      setTfa(false);
                      setError('');
                      setCredentials((previous) => ({ ...previous, code: '' }));
                    }}
                  >
                    返回账号登录
                  </Button>
                )}
              </form>
              {!tfa && (
                <>
                  {!!providers.data?.data.length && (
                    <>
                      <Separator className='my-5' />
                      <p className='mb-3 text-center text-sm text-text-muted'>第三方登录</p>
                      <Space orientation='vertical'>
                        {providers.data.data.map((provider) => (
                          <Button
                            key={provider.id}
                            href={`/api/v1/auth/oauth/${encodeURIComponent(provider.id)}`}
                            block
                          >
                            使用 {provider.name} 登录
                          </Button>
                        ))}
                      </Space>
                    </>
                  )}
                  <div className='mt-5 flex justify-between text-sm'>
                    <a href='/register' className='text-primary'>立即注册</a>
                    <a href='/forgot-password' className='text-primary'>忘记密码</a>
                  </div>
                </>
              )}
            </>
          )}
      </Card>
    </div>
  );
}
