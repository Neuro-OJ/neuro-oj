/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { LayoutDashboard, LogOut, Menu, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import logo from '../../assets/img/logo.jpg';
import { useAppState, useResource } from '../state.tsx';
import { Button, Space } from './primitives.tsx';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.tsx';

export function Shell() {
  const { user, setUser, api } = useAppState();
  const community = useResource<{ data: { enabled?: boolean } }>('/api/v1/community/config');
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    setLoggingOut(true);
    try {
      await api.post('/api/auth/logout');
      setUser(null);
      navigate('/');
      toast.success('已退出登录');
    } catch {
      /* 保留会话供用户重试，统一 API 层显示错误。 */
    } finally {
      setLoggingOut(false);
    }
  }
  const navigation = (
    <>
      {[['/', '首页'], ['/problems', '题库'], ['/submissions', '提交记录']].map(([to, label]) => (
        <NavLink
          key={to}
          to={to!}
          end={to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            `rounded px-3 py-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
              isActive ? 'bg-primary-bg font-semibold text-primary' : 'text-text-secondary hover:bg-bg-sunken'
            }`}
        >
          {label}
        </NavLink>
      ))}
      <a href='/contests' className='px-3 py-3 text-sm text-text-secondary'>竞赛</a>
      <a href='/trainings' className='px-3 py-3 text-sm text-text-secondary'>训练</a>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost'>更多</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start'>
          <DropdownMenuItem asChild>
            <a href='/ranking'>排行榜</a>
          </DropdownMenuItem>
          {community.data?.data.enabled && (
            <DropdownMenuItem asChild>
              <a href='/community'>社区</a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <a href='/queue'>评测队列</a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href='/about'>关于</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  return (
    <div data-noj-react className='min-h-dvh bg-bg-page text-text'>
      <a href='#react-main' className='sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4'>
        跳到主要内容
      </a>
      <header className='sticky top-0 z-30 border-b border-border bg-bg-panel'>
        <div className='mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 md:px-8'>
          <Button className='md:hidden' size='icon' aria-label='打开导航菜单' onClick={() => setMobileOpen(true)}>
            <Menu aria-hidden className='size-4' />
          </Button>
          <Link
            to='/'
            aria-label='Neuro OJ 首页'
            className='flex shrink-0 items-center gap-2.5 text-lg font-bold tracking-tight text-primary'
          >
            <img src={logo} alt='' width={30} height={30} className='rounded' />Neuro OJ
          </Link>
          <nav aria-label='主导航' className='ml-5 hidden flex-1 items-center gap-1 md:flex'>{navigation}</nav>
          <div className='ml-auto'>
            {user
              ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label='账户菜单'>
                      <Avatar className='size-6'>
                        <AvatarImage src={user.avatar_url ?? undefined} alt='' />
                        <AvatarFallback>
                          <UserRound aria-hidden className='size-4' />
                        </AvatarFallback>
                      </Avatar>
                      <span className='hidden sm:inline'>{user.username}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align='end'>
                    <DropdownMenuItem asChild>
                      <a href='/settings'>
                        <UserRound aria-hidden />账户设置
                      </a>
                    </DropdownMenuItem>
                    {user.is_admin && (
                      <DropdownMenuItem asChild>
                        <a href='/admin'>
                          <LayoutDashboard aria-hidden />管理后台
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem disabled={loggingOut} onSelect={() => void logout()}>
                      <LogOut aria-hidden />退出登录
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
              : <Button variant='default' onClick={() => navigate('/login')}>登录</Button>}
          </div>
        </div>
      </header>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side='left'>
          <SheetHeader>
            <SheetTitle>Neuro OJ 导航</SheetTitle>
            <SheetDescription className='sr-only'>站内导航</SheetDescription>
          </SheetHeader>
          <nav aria-label='移动端导航' className='flex flex-col gap-2 p-4'>{navigation}</nav>
        </SheetContent>
      </Sheet>
      <main id='react-main' className='mx-auto min-h-[calc(100dvh-170px)] max-w-7xl px-4 py-7 md:px-8 md:py-10'>
        <Outlet />
      </main>
      <footer className='border-t border-border bg-bg-panel'>
        <div className='mx-auto flex max-w-7xl flex-wrap justify-between gap-3 px-4 py-6 text-xs text-text-muted md:px-8'>
          <span>面向 AI 领域认证与竞赛的在线评测平台</span>
          <Space>
            <a href='/about'>关于</a>
            <a href='/legal/terms'>服务条款</a>
            <a href='/legal/privacy'>隐私政策</a>
          </Space>
          <span className='w-full'>Neuro OJ. 独立社区项目，与 CCF 及 LMCC 无官方关系。</span>
        </div>
      </footer>
    </div>
  );
}
